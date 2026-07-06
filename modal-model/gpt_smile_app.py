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
    Blocks abuse of this public-URL endpoint: only worker-metered requests run."""
    if not secret:
        return True  # secret not configured → skip (dev)
    try:
        body, sig = token.split(".")
        expected = base64.urlsafe_b64encode(
            hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest()
        ).decode().rstrip("=")
        if not hmac.compare_digest(sig, expected):
            return False
        payload = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        return payload.get("exp", 0) > time.time() * 1000
    except Exception:
        return False

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
        # sanity guard — reject wild alignment
        scale = float(np.hypot(M[0, 0], M[1, 0]))
        if not (0.55 < scale < 1.8):
            raise RuntimeError(f"alignment out of range (scale {scale:.2f})")
        warp = cv2.warpAffine(gpt, M, (W, H), flags=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REPLICATE)

        outer = pts(lo, OUTER_LIP)
        dst = pts(lo, INNER_LIP)
        mw = float(dst[:, 0].max() - dst[:, 0].min())
        cx, cy = outer[:, 0].mean(), outer[:, 1].mean()
        poly = np.array([[cx + (p[0] - cx) * 1.10, cy + (p[1] - cy) * 1.10] for p in outer], np.int32)
        mask = np.zeros((H, W), np.uint8)
        cv2.fillConvexPoly(mask, cv2.convexHull(poly), 255)
        fr = max(5, int(mw * 0.14) | 1)
        mf = (cv2.GaussianBlur(mask, (fr, fr), 0).astype(np.float32) / 255.0)[:, :, None]
        comp = (orig_bgr.astype(np.float32) * (1 - mf) + warp.astype(np.float32) * mf).astype(np.uint8)

        ok, jpg = cv2.imencode(".jpg", comp, [cv2.IMWRITE_JPEG_QUALITY, 94])
        return jpg.tobytes()

    @modal.fastapi_endpoint(method="POST")
    def compose(self, body: dict):
        t0 = time.time()
        try:
            if not _verify_meter_token(body.get("token", ""), os.environ.get("SMILE_HMAC_SECRET", "")):
                return {"error": "unauthorized (invalid or expired meter token)"}
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
