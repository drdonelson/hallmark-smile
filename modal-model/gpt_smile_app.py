"""GPT smile transformation — server-side generation + tooth composite.

This is the primary smile-generation path, moved OFF the browser to fix the
perioral-band artifact the JS canvas composite produced (and which could not be
headless-QA'd, because MediaPipe needs WebGL). The algorithm here is the exact
one validated clean in harness/gpt_composite.py:

  1. gpt-image-1 full-image edit (best teeth + lighting; handles severe cases).
  2. MediaPipe FaceLandmarker on BOTH the original and the GPT result.
  3. Least-squares affine (inner-lip) registers GPT's mouth onto the original.
  4. Alpha-feathered OUTER-lip composite grafts GPT's whole smile back onto the
     UNTOUCHED original face — identity preserved, only the teeth change, full
     gingival emergence + incisal edges (feather beats Poisson: seamlessClone
     dulls/discolors the teeth).

CPU only — no GPU, no model weights. Cheap on Modal's free tier. No 30s limit,
so it can use gpt-image-1 quality:high if desired.

Deploy:
  1. modal secret create smile-secret \
       OPENAI_API_KEY=sk-...  SMILE_HMAC_SECRET=<same value as the worker's DASH_SECRET>
  2. modal deploy modal-model/gpt_smile_app.py
  3. Put the printed endpoint URL into MODAL_SMILE_URL in smile-simulator.html.

SMILE_HMAC_SECRET must equal the Cloudflare Worker's DASH_SECRET — that's how
Modal verifies the browser's request was metered/authorized by the worker.

Endpoint: POST {url}
  body {"image":"data:image/...;base64,...","quality":"medium"|"high","token":"...","tenant":"slug"}
  -> {"image":"data:image/jpeg;base64,...","ms":1234,"engine":"gpt-composite"}
"""
import io
import os
import time
import base64
import json
import hmac
import hashlib

import modal


def _verify_meter_token(token, secret):
    """Verify the worker-issued HMAC token (see signMeterToken in worker.js).
    Returns the decoded payload dict on success, or None. Blocks abuse of this
    public-URL endpoint: only worker-metered requests run."""
    if not secret:
        # FAIL CLOSED: the Modal URL is public — a missing secret must NOT grant
        # unrestricted OpenAI spend. Only bypass with an explicit dev opt-in.
        return {"dev": True} if os.environ.get("ALLOW_UNAUTH_DEV") == "1" else None
    try:
        body, sig = token.split(".")
        expected = base64.urlsafe_b64encode(
            hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest()
        ).decode().rstrip("=")
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        if payload.get("exp", 0) <= time.time() * 1000:
            return None
        return payload
    except Exception:
        return None

image = (
    modal.Image.debian_slim(python_version="3.11")
    # mediapipe pulls in the NON-headless opencv (opencv-contrib-python), whose
    # cv2 needs libGL.so.1 + libglib — not present in debian_slim. Without these
    # the container crash-loops on `ImportError: libGL.so.1`.
    .apt_install("libgl1", "libglib2.0-0")
    # numpy<2 pinned in the SAME call as mediapipe (mediapipe otherwise upgrades
    # it to 2.x — the documented numpy-pin gotcha). mediapipe brings opencv +
    # numpy, so we don't list opencv separately (avoids a double cv2 install).
    .pip_install(
        "numpy<2",
        "mediapipe==0.10.14",
        "pillow==10.4.0",
        "requests==2.32.3",
        "fastapi[standard]==0.115.0",
    )
)
app = modal.App("gpt-smile", image=image)

# Lightweight image for the before|after video compositing endpoint — just ffmpeg,
# NO mediapipe/opencv. Kept separate from the GptSmile class so cold starts are
# fast (the class's @enter downloads the FaceLandmarker model, which video
# compositing doesn't need).
video_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install("requests==2.32.3", "fastapi[standard]==0.115.0")
)


@app.function(image=video_image, timeout=300, min_containers=0,
              secrets=[modal.Secret.from_name("smile-secret")])
@modal.fastapi_endpoint(method="POST")
def compose_video(body: dict):
    """Stitch the STATIC before photo beside the animated after video into one
    shareable before|after clip (like bitebot). Returns raw mp4 bytes.
    Auth: any valid meter token (the browser mints an uncapped kind=shadow one —
    the video was already billed at Kling-start, so this must not re-charge)."""
    import base64 as b64m, subprocess, tempfile, os as _os
    import requests as rq
    from fastapi import Response
    if not _verify_meter_token(body.get("token", ""), _os.environ.get("SMILE_HMAC_SECRET", "")):
        return Response(content=b'{"error":"unauthorized"}', status_code=401, media_type="application/json")
    vurl = body.get("video_url", "")
    before = body.get("before", "")
    if not vurl or not before:
        return Response(content=b'{"error":"need before + video_url"}', status_code=400, media_type="application/json")
    d = tempfile.mkdtemp()
    bpath, vpath, opath = _os.path.join(d, "b.jpg"), _os.path.join(d, "v.mp4"), _os.path.join(d, "out.mp4")
    try:
        raw = before.split(",", 1)[1] if "," in before else before
        open(bpath, "wb").write(b64m.b64decode(raw))
        r = rq.get(vurl, timeout=60); r.raise_for_status()
        open(vpath, "wb").write(r.content)
        # Probe the video length so we can HARD-CAP the output with -t. That's the
        # reliable way to stop ffmpeg: a -loop'd still image is an infinite input,
        # and hstack (even with shortest=1) can fail to propagate EOF and hang. A
        # -t output cap forces the muxer to finalize at exactly the clip length.
        dur = 10.0
        try:
            pr = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                 "-of", "default=nw=1:nk=1", vpath],
                                capture_output=True, stdin=subprocess.DEVNULL, timeout=30)
            dur = min(float(pr.stdout.decode().strip()), 12.0)
        except Exception:
            pass
        # Before (looped still, input 0) | After (video, input 1), same height,
        # web-friendly H.264. scale=-2 keeps widths even so no pad is needed.
        fc = ("[0:v]scale=-2:900,setsar=1[b];[1:v]scale=-2:900,setsar=1[a];"
              "[b][a]hstack=inputs=2")
        cmd = ["ffmpeg", "-nostdin", "-y", "-loop", "1", "-i", bpath, "-i", vpath,
               "-filter_complex", fc, "-t", "%.2f" % dur, "-c:v", "libx264",
               "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", opath]
        p = subprocess.run(cmd, capture_output=True, stdin=subprocess.DEVNULL, timeout=90)
        if p.returncode != 0 or not _os.path.exists(opath):
            return Response(content=('{"error":"ffmpeg: %s"}' % p.stderr.decode()[-180:].replace('"', "'")).encode(),
                            status_code=500, media_type="application/json")
        return Response(content=open(opath, "rb").read(), media_type="video/mp4")
    except Exception as e:
        return Response(content=('{"error":"%s"}' % str(e)[:180].replace('"', "'")).encode(),
                        status_code=500, media_type="application/json")

MP_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)
MP_MODEL_PATH = "/root/face_landmarker.task"

# MediaPipe inner-lip loop (mouth opening) — used to REGISTER GPT's mouth to the
# original via the affine transform.
INNER_LIP = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308,
             415, 310, 311, 312, 13, 82, 81, 80, 191]
# Outer-lip loop — the composite MASK (grown + feathered). Inner-lip clips the
# gingival emergence + incisal edges; outer-lip keeps the whole smile intact.
OUTER_LIP = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291,
             409, 270, 269, 267, 0, 37, 39, 40, 185]

PROMPT = (
    "Retouch this exact photo. Change ONLY the teeth already visible between the lips: "
    "make them straight, even, and bright natural white (shade BL1-BL2, not gray/blue/yellow), "
    "individual teeth with natural inter-dental shadows and subtle incisal translucency, healthy "
    "pink gums; repair chips, decay, gaps, and missing teeth into a complete healthy arch. "
    "Keep it the SAME photograph of the SAME person: do not change the mouth shape, smile width, "
    "lip position, amount of teeth showing, expression, skin texture, freckles, wrinkles, facial "
    "hair, hair, eyes, age, head angle, framing, lighting, shadows, or background. Do not smooth "
    "or beautify the skin. Only the teeth change. Photorealistic, identical lighting to the original."
)


@app.cls(secrets=[modal.Secret.from_name("smile-secret")], timeout=300, min_containers=0)
class GptSmile:
    @modal.enter()
    def setup(self):
        import requests
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision
        if not os.path.exists(MP_MODEL_PATH):
            with open(MP_MODEL_PATH, "wb") as f:
                f.write(requests.get(MP_MODEL_URL, timeout=120).content)
        self._vision = vision
        self.landmarker = vision.FaceLandmarker.create_from_options(
            vision.FaceLandmarkerOptions(
                base_options=mp_python.BaseOptions(model_asset_path=MP_MODEL_PATH),
                num_faces=1,
            )
        )

    # ---- helpers ----
    def _decode(self, data_url):
        import numpy as np
        from PIL import Image, ImageOps
        b64 = data_url.split(",", 1)[1] if "," in data_url else data_url
        im = Image.open(io.BytesIO(base64.b64decode(b64)))
        im = ImageOps.exif_transpose(im).convert("RGB")
        return np.array(im)[:, :, ::-1].copy()  # BGR

    def _landmarks_bgr(self, bgr):
        import mediapipe as mp
        rgb = bgr[:, :, ::-1].copy()
        mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        res = self.landmarker.detect(mp_img)
        if not res.face_landmarks:
            return None
        return res.face_landmarks[0]

    def _gpt_edit(self, bgr, quality):
        import requests
        from PIL import Image
        buf = io.BytesIO()
        Image.fromarray(bgr[:, :, ::-1]).save(buf, "PNG")
        r = requests.post(
            "https://api.openai.com/v1/images/edits",
            headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"},
            files={"image": ("face.png", buf.getvalue(), "image/png")},
            data={"model": "gpt-image-1", "prompt": PROMPT, "n": "1",
                  "size": "auto", "quality": quality},
            timeout=240,
        )
        if r.status_code != 200:
            raise RuntimeError(f"OpenAI {r.status_code}: {r.text[:200]}")
        item = r.json()["data"][0]
        return base64.b64decode(item["b64_json"])

    def _composite(self, orig_bgr, gpt_png_bytes):
        """Exact harness alpha-feather composite (feather beats seamlessClone)."""
        import numpy as np
        import cv2
        from PIL import Image

        H, W = orig_bgr.shape[:2]
        s = min(1.0, 1024 / max(H, W))
        if s < 1.0:
            orig_bgr = cv2.resize(orig_bgr, (round(W * s), round(H * s)), interpolation=cv2.INTER_LANCZOS4)
            H, W = orig_bgr.shape[:2]
        gpt = np.array(Image.open(io.BytesIO(gpt_png_bytes)).convert("RGB"))[:, :, ::-1].copy()
        gpt = cv2.resize(gpt, (W, H), interpolation=cv2.INTER_LANCZOS4)

        lo = self._landmarks_bgr(orig_bgr)
        lg = self._landmarks_bgr(gpt)
        if lo is None or lg is None:
            raise RuntimeError("no face detected")

        def pts(lm, idx):
            return np.array([[lm[i].x * W, lm[i].y * H] for i in idx], np.float32)

        M, _ = cv2.estimateAffine2D(pts(lg, INNER_LIP), pts(lo, INNER_LIP), method=cv2.LMEDS)
        if M is None:
            M, _ = cv2.estimateAffinePartial2D(pts(lg, INNER_LIP), pts(lo, INNER_LIP))
        # ---- QUALITY GATE (deterministic geometry, precision-first) ----------
        # A reject raises → compose() returns {"error"} → the browser falls back
        # to the Ideogram engine. Every threshold rejects only CLEARLY-broken
        # registration (a false reject would send the patient to the weaker
        # engine). Design: codex geometric-gate consult 2026-07-08.
        src0 = pts(lg, INNER_LIP)     # GPT inner-lip
        dst0 = pts(lo, INNER_LIP)     # original inner-lip
        mw0 = float(dst0[:, 0].max() - dst0[:, 0].min())

        # Check 1 — affine-fit residual: does M actually register the mouth, or
        # is it a numerically-valid transform that doesn't line the teeth up?
        src_w = cv2.transform(src0[None, :, :], M)[0]
        err = np.linalg.norm(src_w - dst0, axis=1)
        if float(np.median(err)) > max(4.0, 0.035 * mw0):
            raise RuntimeError(f"gpt quality rejected: affine residual median {float(np.median(err)):.1f}px")
        if float(np.percentile(err, 90)) > max(10.0, 0.08 * mw0):
            raise RuntimeError(f"gpt quality rejected: affine residual p90 {float(np.percentile(err, 90)):.1f}px")

        # Check 2 — transform-shape sanity ONLY (gross distortion). NOTE: we do
        # NOT gate raw mouth displacement — gpt-image-1 re-renders the whole face
        # and freely repositions the mouth (a good result can shift it ~100px);
        # the affine exists precisely to correct that, and Checks 1 + 3 verify the
        # registration position-independently. Bounds here are loose: full affine
        # (estimateAffine2D) naturally produces mild anisotropy/shear on good fits.
        a, b = float(M[0, 0]), float(M[0, 1])
        c, d = float(M[1, 0]), float(M[1, 1])
        sx, sy = np.hypot(a, c), np.hypot(b, d)
        gscale = (sx + sy) / 2.0
        rot_deg = abs(np.degrees(np.arctan2(c, a)))
        anisotropy = max(sx / sy, sy / sx)
        shear = abs((a * b + c * d) / max(1e-6, sx * sy))
        if not (0.55 < gscale < 1.8):
            raise RuntimeError(f"gpt quality rejected: scale {gscale:.2f}")
        if rot_deg > 25:
            raise RuntimeError(f"gpt quality rejected: rotation {rot_deg:.1f}deg")
        if anisotropy > 1.5:
            raise RuntimeError(f"gpt quality rejected: anisotropy {anisotropy:.2f}")
        if shear > 0.4:
            raise RuntimeError(f"gpt quality rejected: shear {shear:.2f}")

        warp = cv2.warpAffine(gpt, M, (W, H), flags=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REPLICATE)

        # Mask = INNER-lip polygon grown moderately (1.12 wide x 1.20 tall), NOT
        # the outer lip. This keeps the patient's ORIGINAL lips, so GPT's lip
        # rendering — which can go orange/muddy on glossy lips — is never used.
        # The affine already scaled GPT's teeth into the original mouth opening,
        # so full teeth (gingival emergence + incisal edges) still show, and the
        # blend lands at the tooth/lip boundary inside the mouth, not on skin.
        dst = pts(lo, INNER_LIP)
        mw = float(dst[:, 0].max() - dst[:, 0].min())
        cx, cy = dst[:, 0].mean(), dst[:, 1].mean()
        poly = np.array([[cx + (p[0] - cx) * 1.12, cy + (p[1] - cy) * 1.20] for p in dst], np.int32)
        mask = np.zeros((H, W), np.uint8)
        cv2.fillConvexPoly(mask, cv2.convexHull(poly), 255)
        fr = max(3, int(mw * 0.06) | 1)
        mf = (cv2.GaussianBlur(mask, (fr, fr), 0).astype(np.float32) / 255.0)[:, :, None]
        comp = (orig_bgr.astype(np.float32) * (1 - mf) + warp.astype(np.float32) * mf).astype(np.uint8)

        # Check 3 — post-composite self-consistency: re-detect on the FINISHED
        # image and confirm the mouth landed where the ORIGINAL mouth is. Catches
        # anything (misregistration, deformation) that moved the visible mouth.
        # If detection fails, SKIP rather than reject (a failed re-detect is not
        # proof the result is bad — protect precision).
        lc = self._landmarks_bgr(comp)
        if lc is not None:
            d3 = pts(lc, INNER_LIP) - dst0
            center_shift = float(np.linalg.norm(np.median(d3, axis=0)))
            dy = abs(float(np.median(d3[:, 1])))
            p90 = float(np.percentile(np.linalg.norm(d3, axis=1), 90))
            if dy > max(12.0, 0.06 * mw0) or center_shift > max(14.0, 0.075 * mw0) or p90 > max(18.0, 0.12 * mw0):
                raise RuntimeError(f"gpt quality rejected: post-composite drift dy={dy:.1f} c={center_shift:.1f} p90={p90:.1f}")

        ok, jpg = cv2.imencode(".jpg", comp, [cv2.IMWRITE_JPEG_QUALITY, 94])
        return jpg.tobytes()

    @modal.fastapi_endpoint(method="POST")
    def compose(self, body: dict):
        t0 = time.time()
        try:
            payload = _verify_meter_token(body.get("token", ""), os.environ.get("SMILE_HMAC_SECRET", ""))
            if not payload:
                return {"error": "unauthorized (invalid or expired meter token)"}
            # If the token is image-bound, the submitted image must match its hash
            # (blocks replaying a captured token against a different image).
            h = payload.get("h")
            if h:
                actual = hashlib.sha256(body.get("image", "").encode()).hexdigest()
                if not hmac.compare_digest(h, actual):
                    return {"error": "meter token does not match image"}
            quality = body.get("quality", "medium")
            if quality not in ("low", "medium", "high"):
                quality = "medium"
            orig = self._decode(body["image"])
            gpt_png = self._gpt_edit(orig, quality)
            out_jpg = self._composite(orig, gpt_png)
            return {
                "image": "data:image/jpeg;base64," + base64.b64encode(out_jpg).decode(),
                "ms": int((time.time() - t0) * 1000),
                "engine": "gpt-composite",
            }
        except Exception as e:
            return {"error": str(e), "ms": int((time.time() - t0) * 1000)}

    # ---- Shadow collection (detached background gen for the review queue) ----
    @modal.method()
    def run_shadow(self, image_data_url, tenant, worker_base):
        """Generate the GPT smile and file it UNLABELED in the worker's review
        queue. Runs DETACHED (spawned by the `shadow` endpoint) so it survives
        the patient closing the browser tab — shadow collection must NOT depend
        on the patient waiting ~40-90s for the generation to finish."""
        import requests
        try:
            orig = self._decode(image_data_url)
            gpt_png = self._gpt_edit(orig, "medium")
            out_jpg = self._composite(orig, gpt_png)
            after = "data:image/jpeg;base64," + base64.b64encode(out_jpg).decode()
            resp = requests.post(
                f"{worker_base}/api/gpt-shadow",
                json={"tenant": tenant, "beforeImage": image_data_url,
                      "afterImage": after, "engine": "gpt"},
                timeout=60,
            )
            print(f"[shadow] stored tenant={tenant} worker={resp.status_code} {resp.text[:80]}")
        except Exception as e:
            print(f"[shadow] FAILED tenant={tenant}: {e}")

    @modal.fastapi_endpoint(method="POST")
    def shadow(self, body: dict):
        """Fire-and-forget shadow collection. Verifies the meter token, spawns a
        detached job (gen + store), returns immediately so the browser is held
        for <1s instead of the full generation time."""
        if not _verify_meter_token(body.get("token", ""), os.environ.get("SMILE_HMAC_SECRET", "")):
            return {"error": "unauthorized (invalid or expired meter token)"}
        worker_base = body.get("worker_base") or "https://quiet-forest-e1f8.david-d73.workers.dev"
        tenant = body.get("tenant", "unknown")
        try:
            GptSmile().run_shadow.spawn(body["image"], tenant, worker_base)
        except Exception as e:
            return {"error": str(e)}
        return {"ok": True, "queued": True}
