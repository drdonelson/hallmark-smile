# Hallmark Smile Simulator — Agent Cold-Start Document

**Version:** 4.0 (July 2026 — primary path is now GPT full-image + tooth composite)  
**Classification:** Cold-Start Foundation Document  
**Project:** Hallmark Dental Smile Simulator  
**Authority:** Dr. David Donelson — Hallmark Dental, david@hallmarkdds.com  
**Live URL:** https://app.lucidroi.com/smile-simulator.html (also drdonelson.github.io/hallmark-smile/smile-simulator.html — 301s to the custom domain)  
**Full Developer Handoff:** `DEVELOPER_HANDOFF.md` in repo root — read this for the complete project arc  

**v4.0 changes (read Section 3.13 first):** GPT `gpt-image-1` full-image + tooth
composite is the new PRIMARY generation path (Ideogram demoted to Fallback 1).
It solves the lighting-integration problem the crop-zoom never did and handles
severe missing/broken-teeth cases. Video upgraded to Kling 2.5 Turbo Pro.
Harness gained `gpt_fullface.py` + `gpt_composite.py`. The product also grew a
self-serve white-label + 3-tier-role dashboard layer (out of scope for this
pipeline doc; see the memory files / DEVELOPER_HANDOFF).

---

## 1. What This Is and Why It Matters

A patient walks into Hallmark Dental with broken, missing, or damaged teeth. Before any treatment plan is presented, before any cost discussion begins, they need to *see* what's possible. Not a diagram. Not a stock photo. Their face, transformed.

This simulator exists to show that patient — on the spot, in the chair, in under 30 seconds — what their smile would look like after a complete cosmetic dental makeover. Dr. Apa-level work: golden proportion symmetry, individually defined teeth, BL1 whitening, natural gingival emergence, enamel texture. Not whitening. Not brightening. A total reconstruction.

The quality standard is **bitebot.io**. Look it up before touching this codebase. That is the ceiling we are building toward. Anything that looks like a photoshop cut-and-paste, anything that produces a denture slab, anything with a color cast, anything that touches the face — is a failure state.

This document exists because this project has 100+ commits and hard-won knowledge inside every one of them. An agent cold-starting without reading this will repeat those failures. That is unacceptable.

---

## 2. The Architecture — Current State

### 2.1 Files and Deployment

| File | Location | Deployment |
|---|---|---|
| `smile-simulator.html` | GitHub Pages | Auto-deploys from `main` branch (~60s) |
| `worker.js` | Cloudflare Worker | Auto-deploys via GitHub Actions (~30s) |
| `modal-model/dental_app.py` | Modal.com A10G | Manual deploy via `modal deploy` |
| `modal-model/download_weights.py` | Modal.com volume | One-off weight pre-loader |

**Worker URL:** `https://quiet-forest-e1f8.david-d73.workers.dev`  
**LoRA weights:** `drdonelson/dental-lora` on HuggingFace (456MB safetensors)  
**Modal endpoint:** `https://drdonelson--dental-lora-dentalmodel-inpaint.modal.run`

### 2.2 Pipeline (Primary → Fallbacks)

```
Patient photo
    ↓
MediaPipe 468-landmark face mesh → landmarks + inner/outer-lip polygons
    ↓
[PRIMARY]    GPT full-image + tooth composite     → gptCompositeMakeover()  (July 2026)
[Fallback 1] Ideogram v2 crop-zoom via Replicate  → ideogramCropMakeover()
[Fallback 2] ControlNet+LoRA inpaint via Modal    → loraCompositeMakeover()
[Fallback 3] FLUX Pro Fill crop-zoom via fal.ai   → fluxCropMakeover()
[Fallback 4] gpt-image-2 crop-zoom via OpenAI     → gptMaskWhiten()
[Fallback 5] Dr. Apa SDXL LoRA full-face img2img  → Modal legacy
[Fallback 6] FLUX Pro Fill full image             → full image inpainting
[Fallback 7] RunPod ComfyUI                       → legacy
[Fallback 8] Client-side HSL whitening            → last resort
```

**Primary changed July 2026 (Section 3.13).** GPT full-image + tooth composite
replaced Ideogram crop-zoom as primary: it fixes the lighting-integration gap
(Section 3.9/3.10) and handles severe missing/broken-teeth cases the crop-zoom
fails on (Section 3.12). Ideogram stays as Fallback 1 — proven and
identity-perfect — so it catches GPT errors, 30s timeouts, or bad alignment.

### 2.3 The Crop-Zoom Pattern

All primary AI paths follow the same geometry:

1. MediaPipe finds tooth bounds (`xMin`, `xMax`, `yMin`, `yMax`)
2. Compute crop box: **2.0× horizontal padding**, **1.5× vertical padding** around bounds
3. Scale crop to **1024px on longest side**, rounded to 64px increments (`outW`, `outH`)
4. **Bib desaturation:** desaturate everything below the tooth bounding box (strips dental bib blue/teal)
5. **Tooth erase:** fill tooth pixels with dark color `rgb(20,12,12)` — forces Ideogram to fully generate rather than adjust existing teeth (see Section 3.6)
6. Create the AI inpainting mask for that model's convention (see Section 3.3)
7. Receive AI result, **harmonize teeth lighting to the scene** (LAB illuminant transfer — see Section 3.10)
8. Build pixel-precise blend mask from MediaPipe tooth shape (see Section 3.1)
9. Composite tooth region back onto original face at `(cx, cy)` with size `(cw, ch)`

**Critical compositing rules** — see Sections 3.1 and 3.7.

---

## 3. What We Know That Isn't in the Code

These are the findings that took weeks to earn. Do not skip them.

### 3.1 The Blend Mask Bug — Most Important

`destination-in` composite mode clips by **source alpha**, not source color. A canvas filled with opaque black (`rgba(0,0,0,255)`) has alpha=255 — identical to opaque white. If you fill the blend mask background with black before drawing the white tooth rectangle, `destination-in` preserves every pixel in the image. The entire crop composites onto the face. The face is destroyed.

The correct blend mask: **leave the canvas default-transparent. Draw only the tooth region as opaque.** The blur then creates a soft edge into true transparency.

**Current implementation uses pixel-precise tooth shape, not a bbox rectangle.** A blurred bbox rect shows a visible rectangular seam. Instead, convert MediaPipe mask brightness → alpha channel:

```javascript
// WRONG 1 — opaque black background: clips nothing, full crop bleeds onto face
bmCtx.fillStyle = '#000';
bmCtx.fillRect(0, 0, outW, outH);

// WRONG 2 — bbox rectangle: shows visible rectangular seam at composite boundary
bmCtx.filter = 'blur(6px)';
bmCtx.fillStyle = 'rgba(255,255,255,1)';
bmCtx.fillRect(tbX, tbY, tbW, tbH);

// CORRECT — pixel-precise tooth shape with commissure fade:
// 1. Convert MediaPipe mask brightness → alpha (white=opaque, black=transparent)
for (let i = 0; i < am.length; i += 4) {
  const b = Math.round(0.299*am[i] + 0.587*am[i+1] + 0.114*am[i+2]);
  am[i] = 255; am[i+1] = 255; am[i+2] = 255; am[i+3] = b;
}
// 2. Fade blend to 0 at outer 10% of tooth-bbox width (prevents commissure seam)
const commMargin = Math.round(tbW * 0.10);
for (let i = 0; i < am.length; i += 4) {
  const x = (i/4) % outW;
  const minH = Math.min(x - tbX, (tbX + tbW) - 1 - x);
  if (minH < commMargin) am[i+3] = Math.round(am[i+3] * Math.max(0, minH/commMargin));
}
// 3. Blur for soft feathering
bmCtx.filter = 'blur(10px)';
bmCtx.drawImage(alphaMaskCanvas, 0, 0);
```

This error went undetected for multiple sessions because FLUX happened to preserve surrounding face areas closely enough that the bleeding wasn't visible. Ideogram does not.

### 3.2 Dental Bib Color Contamination

Patients in the dental chair wear light blue/teal bibs. The bib sits below the teeth in every crop image. Generative fill models (FLUX, Ideogram) sample surrounding color context when generating new content. They see the blue/teal bib and generate blue/teal teeth.

**Fix:** Before converting the crop canvas to JPEG for the AI, desaturate all pixels below the tooth bounding box (from `tbY + tbH + 4` to `outH`). The model sees neutral gray below the teeth instead of blue. Applied in `ideogramCropMakeover()` and `fluxCropMakeover()` before `toDataURL`.

Post-processing pixel correction (boosting R channel, reducing B channel) does not work. It either under-corrects (still blue) or over-corrects (yellow teeth, warm band artifacts at blend mask edges). Attack the source, not the output.

### 3.3 Mask Conventions — Each Model Is Different

This has caused silent failures repeatedly. Every AI inpainting model uses a different mask convention. Getting it wrong sends the model instructions to edit the face and preserve the teeth.

| Model | Edit Zone | Preserve Zone |
|---|---|---|
| FLUX Pro Fill (fal.ai) | **White** pixels | Black pixels |
| Ideogram v2 (Replicate) | **Black** pixels | White pixels |
| SDXL inpainting | **White** pixels | Black pixels |
| gpt-image-2 (OpenAI) | **Transparent** (alpha=0) | Opaque (alpha=255) |

The Ideogram mask is white-background with a black rectangle at the tooth area. FLUX is the inverse.

### 3.4 MediaPipe Over Brightness Thresholding

There are two tooth detection functions in the codebase. `buildToothMask` (brightness threshold) finds ~628 tooth pixels and completely misses yellowish or stained teeth. `buildMediaPipeMask` (468-landmark face mesh) consistently finds ~6,000+ tooth pixels geometrically, regardless of tooth color.

`buildToothMask` is dead code. Do not resurrect it.

### 3.5 Guidance Scale and Prompt Language

**`guidance_scale: 25` for FLUX is too high.** At 25, the model forces the prompt at the cost of integrating with the source image — produces artificial, plastic-looking output. Optimal range for photorealistic inpainting: 10–15. Current setting: 12.

**"Warm" or "ivory" in the tooth color prompt means yellow.** FLUX interprets "natural warm ivory-white" literally and generates warm/yellow teeth. The prompt must say "bright natural white, BL1 shade" and the negative prompt must include "yellow teeth, stained teeth, amber, warm yellow."

### 3.6 The Ideogram Slab Problem — Fix: Tooth Erase Before Sending

When a patient has existing light or white teeth, Ideogram sees them as "already tooth-colored" and adjusts minimally. The result: white slab, no embrasures, no individual crown definition.

**Fix:** Before sending the crop to Ideogram, fill all tooth pixels (identified by MediaPipe mask) with `rgb(20,12,12)` — dark mouth interior. Ideogram now sees a dark cavity regardless of the patient's original tooth color, forcing full generation from scratch — the same behavior that makes missing-teeth cases generate well-defined individual teeth. Applied in `ideogramCropMakeover()` after bib desaturation, before `cropImgUrl = toDataURL(...)`.

### 3.7 The LoRA Architecture Problem

The Dr. Apa LoRA (drdonelson/dental-lora) was trained on SDXL base (4-channel UNet). SDXL inpainting uses a 9-channel UNet — structurally incompatible. Currently deployed as `StableDiffusionXLControlNetInpaintPipeline` (4-channel, compatible) with ControlNet canny conditioning.

**ControlNet limitation:** operates at full-face resolution. Tooth region is only ~200px wide — insufficient for individually-defined tooth anatomy. Ideogram crop-zoom at 1024px on the tooth region produces 5× more pixel density. ControlNet+LoRA is Fallback 1.

**img2img cliff:** at strength ≥ 0.70 obliterates tooth structure → white slab. At <0.70 too subtle. No workable range.

The LoRA represents 600 Dr. Apa cosmetic dental cases. The problem is not its knowledge — it is the deployment architecture. Most promising untested path: run LoRA full-face at strength ~0.40, extract only tooth pixels via MediaPipe, composite onto original face (preserves face lighting because LoRA sees full photo).

### 3.7 Cloudflare Worker 30-Second Timeout

Cloudflare Workers have a hard 30-second subrequest limit. Modal inference takes 20–30s warm, 60–120s cold. The browser calls Modal **directly** (bypassing the Worker) with a 90-second AbortController and one auto-retry. The Worker's `/api/modal/inpaint` route exists for reference but is not called in production.

### 3.8 Replicate SDXL Cold Start Kills

Replicate's automated health checker disables model versions that consistently fail to respond. SDXL cold starts take 2–5 minutes. The health checker flagged them as failing and disabled all deployed versions. Replicate is not viable for SDXL-based models. Modal with persistent volume caching is the correct deployment for SDXL work.

### 3.9 Crop-Zoom Integration Problem

Zooming to 1024px gives the AI enough pixels to render individual tooth anatomy. But it also removes the face lighting context. The AI generates teeth with its own lighting model, which does not match the original photo. When composited back, the result looks like a pasted-on smile — technically clean but visually wrong.

This is an unsolved architectural tension. Full-face inference preserves lighting context but sacrifices tooth detail. Crop-zoom produces dental detail but breaks integration. The LoRA composite approach described in 3.6 may resolve this because the LoRA was trained on full-face photos and naturally understands full-face context.

### 3.10 Lighting Harmonization — LAB Illuminant Transfer (SOLVED June 2026)

Ideogram generates teeth under its own studio-flat lighting; the face is lit by
warm office light. Raw composites read icy/gray and "pasted on". The fix is
`harmonizeTeeth()` in `smile-simulator.html`, applied to the Ideogram output in
crop space before the blend mask:

1. **Scene illuminant estimate:** brightest decile of perioral skin pixels in
   the ORIGINAL crop (pre-desat, pre-erase), in CIELAB. Sampling MUST be
   restricted to a box around the mouth AND warm-toned pixels (`a > 4`).
   Sampling the whole crop lets white walls/bibs hijack the estimate — the
   correction then shifts teeth CYAN instead of warm (observed failure).
2. **Chroma shift:** move generated-teeth mean a/b 70% of the way toward HALF
   the illuminant chroma (skin highlights carry skin tone; full adoption makes
   teeth pink).
3. **Brightness normalization:** scale teeth L so P95 ≈ skin-highlight L + 12,
   clamped to [0.78, 1.2]. Two-directional: dims fluorescent teeth, lifts dull ones.
4. **Light falloff:** per-column gain from the skin band above the upper lip
   (clamped [0.85, 1.15]) restores directional lighting across the smile.

Validated on 5 real office photos (stained, broken, missing teeth) via the
local harness. Zero added cost or latency — pure canvas math.

### 3.10b Collapsed (Edentulous) Openings — Dedicated Branch (SHIPPED June 2026)

An edentulous smile's inner-lip bbox aspect (height/width) is < 0.18; all
tested normal smiles measure 0.22–0.26. With standard padding the crop becomes
an 8:1 letterbox, Ideogram returns ~3:1, and the stretch-back squashes the
teeth into a dim gray sliver. `ideogramCropMakeover` detects `collapsed` and
switches to: tight padding (0.5×/1.0× → ~3:1 crop), pixels from the FULL-RES
original (passed as 6th arg), a vertically expanded edit/blend mask (up
0.45×colH, down 0.18×colH — tooth-erase stays at the original polygon), and
harmonization with the brightness cap disabled (dark perioral skin made the
cap dim teeth to gray). Result: full crowns with gingival margins meeting the
lip line. The hires-crop severe-decay risk (3.12) doesn't apply here — the
collapsed mouth interior is uniformly dark, like the missing-teeth case.

Harmonizer guards added at the same time (all cases): chroma shift weighted
to 0 below L≈25–45 (warm-shifting mouth shadows turns them maroon); absolute
chroma clamp on the target (a ≤ 8, b ≤ 11 — strong color-cast photos made
teeth dingy); absolute floor of 76 on the L target (tan skin pulled the
relative target below believable enamel brightness).

Known open issue: Ideogram occasionally draws small black specks on teeth
(seen on 1 of 10 test photos). Generation variance — a retry usually clears
it. Candidate fix: artifact detection (dark pixel clusters inside tooth mask
in the output) + one automatic retry.

### 3.11 Local Test Harness — Iterate Without Paying Per Run

`harness/server.mjs` (Node, port 8788) + `harness/harness.html` clone the
production pipeline stage by stage and cache every intermediate to
`test-outputs/<photo>/`. Generation runs once per photo (~$0.08); all
compositing/harmonization iteration afterward is free (`mode=recomposite`,
`mode=harmonize`). MediaPipe landmarks are computed natively via
`harness/landmarks.py` (same face_landmarker.task model as production) because
headless Chromium cannot create the WebGL context MediaPipe's wasm needs.
Patient photos live in `test-photos/` — **gitignored; this repo deploys
publicly via GitHub Pages. Never commit patient photos.**

Run: `node harness/server.mjs`, then drive
`http://localhost:8788/harness/harness.html?photo=IMG_X.jpg&mode=...` with a
browser. The harness proxies Ideogram through the Worker with an allowed
Origin header.

### 3.12 Hires Crop Experiments — Promising, NOT Production-Safe (June 2026)

Production padding (2.0×/1.5×) makes the crop span nearly the full image, so
scale ≈ 0.92 and teeth reach Ideogram at ~205px wide — the "1024px crop-zoom"
performs NO actual zoom on typical photos. Harness `mode=hires` crops from the
full-resolution original with 0.5×/1.0× padding → teeth at ~500px, near
Ideogram's native 3:1 output aspect (its output is 1536×512-ish; the production
8:1 crop gets stretch-resampled, costing sharpness).

Results: dramatically sharper teeth on 4/5 photos, BUT consistently artifacts
on severe full-arch decay (dark ticks/blotches — 3/3 attempts failed on that
case while the wide production crop handled it cleanly). The tight crop loses
the facial context that anchors "healthy smile" generation. Do not ship without
solving that case.

Gum-band finding (harness `gum=0.25`): erasing the entire inner-lip polygon
leaves Ideogram no anchor for gingiva — gum-showing smiles get a dark void
above the teeth. Preserving the top 25% of each mask column fixes it, but the
keep/erase decision must be GLOBAL per photo (≥40% of columns bright pink →
preserve everywhere, else erase everywhere). Per-pixel preservation lets dark
reddish decay survive as blotches; per-column flickers into stripes Ideogram
hallucinates patterns from. Both observed.

### 3.13 GPT Full-Image + Tooth Composite — PRIMARY PATH (SHIPPED July 2026)

This is the current primary and the most important section in the doc. It came
out of testing the "GPT milestone" a contractor (Carthago/Amor) quoted $1,200
for. We reproduced and beat it ourselves for ~$1 of API. Files:
`smile-simulator.html` `gptCompositeMakeover()` (production) and the harness
tools `harness/gpt_fullface.py` + `harness/gpt_composite.py` (where all the
iteration happened — free after one generation per photo).

**The core discovery.** `gpt-image-1` run on the FULL face (not the mouth crop)
produces the best teeth realism AND lighting integration we have ever gotten —
including on SEVERE missing/broken/decayed cases that the crop-zoom pipeline
fails on (Section 3.12). Full-image context is exactly what solves the
lighting-integration problem that Sections 3.9/3.10 called the core unsolved
gap. The contractor's hypothesis was right.

**The catch — GPT is not an inpainter.** `gpt-image-1` re-renders the ENTIRE
image, with or without a mask. A mask does NOT constrain it. So it beautifies
and de-ages the whole face — mild on high-contrast male faces, SEVERE on women
(smoother skin, brighter eyes, glamorized, younger). Shipping GPT whole-image
would hand patients a photo of a different, prettier person. Unacceptable.

**The architecture that works: generate with GPT, composite only the mouth.**
1. Send the full resized face to `gpt-image-1` at `quality:medium` (see 30s
   note below) with a hard identity-lock prompt (`GPT_LOCK_PROMPT`).
2. Run MediaPipe on BOTH the original and the GPT result.
3. Compute a least-squares **affine** from the GPT inner-lip landmarks → the
   original inner-lip landmarks (`solveAffine`) and warp the GPT image so its
   mouth registers onto the original mouth. (GPT shifts/widens the mouth; this
   puts it back.)
4. Composite ONLY the mouth region back onto the untouched original face, so
   the patient's real skin/eyes/identity are preserved and only the smile
   changes. Guard: reject out-of-range alignment (scale <0.55 or >1.8, or
   mouth-center shift >12% width) → fall through to Ideogram.

**THE MASK IS THE WHOLE GAME — use the OUTER lip, never the inner lip.**
Dr. Donelson (a dentist) caught the failure that a non-dentist eye misses:
if you mask the composite to the ORIGINAL inner-lip opening, you clip GPT's
teeth. The original mouth aperture is smaller/differently-shaped than the new
smile, so clipping to it slices off the **gingival emergence profile** (leaves
a pink band above the teeth) and the **incisal edges** (cut off at the lower
lip). GPT's raw smile is dentally correct; the tight mask destroys it.
FIX: build the composite mask from the **outer-lip polygon**, grown ~16% and
heavily feathered (~18% of mouth width), so GPT's WHOLE smile (lips + teeth,
full emergence-to-incisal anatomy) transfers intact and the blend lands on
perioral skin, not across the teeth. `OUTER_LIP` indices are in the code.
Inner-lip landmarks are still used for the affine REGISTRATION (step 3); the
MASK is outer-lip. Do not confuse the two.

**Known residual trade-off:** the outer-lip mask brings a thin ring of GPT's
slightly-smoothed perioral skin with it — a soft halo around the lips, not a
seam. Acceptable; correct dental anatomy wins. If a dentist objects, tighten
the mask on the skin side (asymmetric: hug the upper lip/philtrum where skin
must stay original, stay generous at the incisal edge). Not yet done.

**30s Cloudflare Worker limit (Section 3.7 bites here).** `gpt-image-1`
`quality:high` routinely exceeds 30s and the Worker kills the subrequest
(observed: a high-quality run timed out at exactly 300s client-side after the
Worker stalled). Production uses `quality:medium` (finishes in time, still
excellent) with a 40s client AbortController → Ideogram fallback. If you ever
want `high` in production, move the GPT call to a longer-timeout backend
(Modal / a Vercel function / OpenAI background mode). No local OpenAI key
exists — all testing routes through the Worker proxy.

**Metering.** GPT calls go through `POST /api/gpt/edit?tenant=<slug>` which
meters a `sim` against the tenant cap. The generic `/v1/images/edits` OpenAI
proxy passthrough is UNMETERED — never route production sims there or a tenant
can burn spend past its cap.

**Cost:** ~$0.04/sim at medium (comparable to Ideogram's ~$0.08). Validated on
11 real office photos in the harness.

### 3.14 Video — Kling 2.5 Turbo Pro (SHIPPED July 2026)

`worker.js` `KLING_MODEL` was Seedance v1 lite (cheapest tier, weak motion).
Upgraded to `fal-ai/kling-video/v2.5-turbo/pro/image-to-video` for best-in-class
human-motion smile/laugh reveals (matching the bitebot Veo/Kling tier). Input
schema: `{ prompt, image_url, duration:'5'|'10', negative_prompt, cfg_scale }`;
aspect ratio is taken from the image (no aspect_ratio field); no audio field.
Runs on fal's **queue** (`queue.fal.run`) — the start call submits and returns a
`request_id` immediately, the client polls `/api/kling/status`, so generation
time is a UX wait, NOT a Worker-timeout concern. `/api/kling/start` accepts a
`duration` body param. Validated: natural reveal→laugh, identity preserved,
teeth stable; 5s ~99s / 10s ~73s (queue variance), ~$0.35 for 5s (+$0.07/s).
`handleKlingStart` also carries `STYLE_PROMPTS` (laugh/reveal/talk).

### 3.15 GitHub Pages deploy hangs — force a rebuild

GitHub Pages `build_type` is `legacy` (Jekyll). `.nojekyll` is committed (a
Jekyll build failure once froze the live site several commits behind — always
keep `.nojekyll`). Even so, the legacy auto-build intermittently hangs in
`building` for 5+ min. Fix each time: `gh api --method POST
repos/drdonelson/hallmark-smile/pages/builds` forces a fresh build that
completes in ~40s. Happened 3× in one session. Durable fix (not yet done):
switch Pages to an Actions-based deploy workflow. The `drdonelson.github.io`
URL 301-redirects to the `app.lucidroi.com` custom domain (CNAME); curl without
`-L` shows stale content — always follow redirects or hit the custom domain.

---

## 4. What Has Been Tried and Abandoned

Do not revisit these unless the constraints have materially changed.

### Brightness-Threshold Tooth Mask
Finds ~628 pixels, misses non-white teeth entirely. Replaced by MediaPipe.

### FLUX with Inner-Lip Polygon Mask
The inner-lip polygon (MediaPipe indices `[78, 191, 80, 81, 82, 13, 312, ...]`) covers the entire mouth opening including where the tongue lives. FLUX generated tongue tissue in the inpainted region. Replaced by the tooth bounding box.

### Post-Processing Pixel Color Correction
Applying `R * 1.10, B * 0.80` to the FLUX output. Blue cast became yellow cast. Also bled through the blend mask edges (soft blur allows partial compositing of corrected background pixels). Root-cause fix (bib desaturation of the input) is the correct approach.

### Replicate SDXL Deployment (drdonelson/dental-inpaint)
Health checker disabled all versions due to cold start times. Moved to Modal.com with persistent volume caching.

### gpt-image-2 as Primary Path
Conservative edit API — designed to minimally modify existing content. Wrong model for total makeover. For patients with missing or severely damaged teeth, gpt-image-2 changes nothing. Demoted to Fallback 2.

### High FLUX Guidance Scale (25)
Produced over-constrained, plastic-looking teeth. Reduced to 12.

---

## 5. Anti-Patterns — What Will Break This Project

| Anti-Pattern | Why It Fails |
|---|---|
| **Fix the output, not the source** | Post-processing color correction creates new artifacts. Strip the bib color from the input before sending to AI. |
| **Sending light/white teeth to Ideogram** | Ideogram adjusts minimally → white slab. Erase tooth pixels to dark `rgb(20,12,12)` first. |
| **Opaque black blend mask background** | destination-in reads alpha, not color. Black = alpha 255 = opaque. Entire crop bleeds onto face. |
| **Bbox rectangle blend mask** | Shows visible rectangular seam at composite boundary. Use pixel-precise MediaPipe brightness→alpha mask. |
| **Blend mask extending to commissures** | Ideogram color drift at commissure corners shows through. Fade blend to 0 at outer 10% of tooth-bbox width. |
| **Wrong mask convention** | Ideogram: black=edit. FLUX: white=edit. gpt-image-2: transparent=edit. Wrong = model edits the face. |
| **High guidance_scale** | Values above 15 force prompt over source → plastic teeth. Optimal: 10–15. |
| **Warm/ivory language in tooth prompt** | FLUX and Ideogram generate yellow teeth. Say "BL1 bright natural white." |
| **Crop-zooming without bib desaturation** | Blue bibs bleed into tooth color. Always desaturate below tooth bbox before every AI call. |
| **Using buildToothMask** | Dead code. Finds 628 pixels. Misses non-white teeth. Use buildMediaPipeMask. |
| **Running Modal through the Cloudflare Worker** | 30-second subrequest hard limit. Call Modal directly from the browser. |
| **Deploying SDXL on Replicate** | Health checker disables within hours. Use Modal with persistent volume caching. |
| **LoRA img2img at strength ≥ 0.70** | Plastic slab. No exceptions. |
| **numpy<2 only in first pip_install** | opencv-python-headless upgrades numpy to 2.4.6 in its layer. Must pin `numpy<2` in SAME call as opencv. |
| **Clipping GPT teeth to the INNER-lip mask** | Cuts off the gingival emergence profile (pink band above teeth) and the incisal edges (cut at the lower lip). GPT's smile is dentally correct; the tight mask destroys it. Composite with the OUTER-lip mask (grown + feathered), blend on skin (Section 3.13). A dentist WILL notice; a non-dentist eye will not. |
| **Shipping GPT full-image whole (no composite)** | gpt-image-1 re-renders the whole face and beautifies/de-ages it (severe on women). Always composite only the mouth back onto the original face. |
| **Masking gpt-image-1 to "constrain" it** | It is NOT an inpainter — a mask does not stop it re-rendering the whole image. Only compositing preserves identity. |
| **Routing production GPT sims through `/v1/images/edits`** | That proxy is UNMETERED — burns spend past the tenant cap. Use `POST /api/gpt/edit?tenant=`. |
| **gpt-image-1 `quality:high` through the Worker** | Exceeds the 30s subrequest limit → timeout. Use `quality:medium` + a longer-timeout backend if high is ever needed. |
| **Assuming the live site is current after a push** | GitHub Pages legacy build hangs; force `gh api --method POST .../pages/builds`. Follow redirects (github.io 301s to app.lucidroi.com). |

---

## 6. The Quality Standard

A result is acceptable when:

- The face is **unchanged** — skin, lips, hair, eyes, lighting all identical to the original photo
- The teeth are **individually defined** — inter-dental shadows and embrasures visible between each tooth
- The color is **bright natural white** — not blue, not yellow, not plastic, not fluorescent
- The **integration is seamless** — a viewer should not be able to identify where the composite boundary is
- The **makeover is dramatic enough to matter** — a patient with rotted or missing teeth should see a complete transformation, not a subtle improvement

The reference is bitebot.io. Open it in a tab before evaluating any result. If the comparison is unfavorable, the result is not done.

---

## 7. Deployment Workflow

Changes to `smile-simulator.html` → push to `main` → GitHub Pages auto-deploys in ~60 seconds.

Changes to `worker.js` → push to `main` → GitHub Actions deploys to Cloudflare in ~30 seconds.

Both can be in the same commit. Effective total deployment time: ~90 seconds.

```bash
git add smile-simulator.html worker.js
git commit -m "description of change"
git push origin main
# wait 90 seconds, then reload https://drdonelson.github.io/hallmark-smile/smile-simulator.html
```

Test with real patient photos from the office — they have dental bibs, office lighting, and a variety of dental conditions. Stock photos will not reveal the real failure modes.

---

## 8. The Work That Remains

### Solved in Current Version
- **Lighting integration (was THE hardest problem):** SOLVED July 2026 by the GPT
  full-image + tooth composite primary (Section 3.13). Full-image `gpt-image-1`
  sees the whole face, so teeth are lit to match the photo. The crop-zoom
  architecture that caused the mismatch is now Fallback 1, not primary.
- **Severe missing/broken/full-arch decay:** GPT full-image regenerates a
  complete healthy arch cleanly — the case the hires-crop failed on (3.12).
- **Clipped emergence profile / incisal edges:** outer-lip composite mask (3.13).
- **Sloppy white slab** (existing teeth): tooth-erase step forces Ideogram to generate from scratch
- **Rectangular seam artifact**: pixel-precise MediaPipe brightness→alpha blend mask
- **Commissure artifact at mouth corners**: 10% commissure fade in blend mask
- **ControlNet closed-mouth generation**: canny blanked inside mask
- **Modal crash loop**: numpy<2 repeated in opencv pip_install layer

### Still Unsolved / Open

- **Perioral skin halo** from the GPT outer-lip composite — a soft ring of
  GPT's slightly-smoothed skin around the lips. Soft, not a seam; acceptable
  for now. Fix: asymmetric mask (tight on the upper-lip/philtrum skin side,
  generous at the incisal edge). Iterate in `harness/gpt_composite.py`.
- **`gpt-image-1` mouth drift** — GPT widens/shifts the smile; the affine
  registration corrects most of it, but extreme cases hit the alignment guard
  and fall back to Ideogram. A tighter registration (per-tooth or more
  landmarks) could raise the GPT hit rate.
- **30s Worker ceiling** blocks `quality:high` GPT in production. A
  longer-timeout backend (Modal / Vercel fn / OpenAI background mode) would let
  high quality ship. See 3.13.
- **In-browser QA** of the GPT-composite path can't be done headless (MediaPipe
  needs WebGL, Section 3.11) — iterate in the Python harness, then verify one
  real simulation in a real browser after each change.

---

## 9. The Compound Obligation

A patient sitting in Dr. Donelson's chair, looking at a before-and-after that looks like bad Photoshop, does not book a consultation. That patient leaves. The simulator exists because seeing is believing — but only if what they see is believable.

95 commits have gone into this project. Each one represents a hypothesis tested, a failure diagnosed, a constraint discovered. That knowledge is the floor. The next session starts from here, not from scratch.

The failure mode to avoid is the agent who reads none of this and confidently breaks every lesson we earned. Read the anti-patterns. Test against real photos. Compare to bitebot.io. Hold the line.

---

*The goal is not a demo. The goal is a patient who sees their future smile and books the appointment.*

