# Hallmark Smile Simulator — Agent Cold-Start Document

**Version:** 2.0  
**Classification:** Cold-Start Foundation Document  
**Project:** Hallmark Dental Smile Simulator  
**Authority:** Dr. David Donelson — Hallmark Dental, david@hallmarkdds.com  
**Live URL:** https://drdonelson.github.io/hallmark-smile/smile-simulator.html  

---

## 1. What This Is and Why It Matters

A patient walks into Hallmark Dental with broken, missing, or damaged teeth. Before any treatment plan is presented, before any cost discussion begins, they need to *see* what's possible. Not a diagram. Not a stock photo. Their face, transformed.

This simulator exists to show that patient — on the spot, in the chair, in under 30 seconds — what their smile would look like after a complete cosmetic dental makeover. Dr. Apa-level work: golden proportion symmetry, individually defined teeth, BL1 whitening, natural gingival emergence, enamel texture. Not whitening. Not brightening. A total reconstruction.

The quality standard is **bitebot.io**. Look it up before touching this codebase. That is the ceiling we are building toward. Anything that looks like a photoshop cut-and-paste, anything that produces a denture slab, anything with a color cast, anything that touches the face — is a failure state.

This document exists because this project has 95 commits and hard-won knowledge inside every one of them. An agent cold-starting without reading this will repeat those failures. That is unacceptable.

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
MediaPipe 468-landmark face mesh → tooth bounds {xMin, xMax, yMin, yMax}
    ↓
[Primary]   Ideogram v2 inpainting via Replicate  → ideogramCropMakeover()
[Fallback 1] FLUX Pro Fill via fal.ai             → fluxCropMakeover()
[Fallback 2] gpt-image-2 via OpenAI proxy         → gptMaskWhiten()
[Fallback 3] Dr. Apa SDXL LoRA via Modal.com      → full-face img2img
[Fallback 4] FLUX Pro Fill full image             → full image inpainting
[Fallback 5] RunPod ComfyUI                       → legacy
[Fallback 6] Client-side HSL whitening            → last resort
```

### 2.3 The Crop-Zoom Pattern

All primary AI paths follow the same geometry:

1. MediaPipe finds tooth bounds (`xMin`, `xMax`, `yMin`, `yMax`)
2. Compute crop box: **2.0× horizontal padding**, **1.5× vertical padding** around bounds
3. Scale crop to **1024px on longest side**, rounded to 64px increments (`outW`, `outH`)
4. Before sending to AI: **desaturate everything below the tooth bounding box** (converts the dental bib's blue/teal color to grayscale so the AI doesn't sample it as a color reference for teeth generation)
5. Create the AI inpainting mask for that model's convention (see Section 3.3)
6. Receive AI result, composite tooth region back onto original face at `(cx, cy)` with size `(cw, ch)`

**Critical compositing rule** — see Section 3.1.

---

## 3. What We Know That Isn't in the Code

These are the findings that took weeks to earn. Do not skip them.

### 3.1 The Blend Mask Bug — Most Important

`destination-in` composite mode clips by **source alpha**, not source color. A canvas filled with opaque black (`rgba(0,0,0,255)`) has alpha=255 — identical to opaque white. If you fill the blend mask background with black before drawing the white tooth rectangle, `destination-in` preserves every pixel in the image. The entire crop composites onto the face. The face is destroyed.

The correct blend mask: **leave the canvas default-transparent. Draw only the tooth region as opaque.** The blur then creates a soft edge into true transparency.

```javascript
// WRONG — clips nothing, full crop bleeds onto face:
bmCtx.fillStyle = '#000';
bmCtx.fillRect(0, 0, outW, outH);   // opaque black = alpha 255 everywhere
bmCtx.fillStyle = '#fff';
bmCtx.fillRect(tbX, tbY, tbW, tbH);

// CORRECT — clips cleanly to tooth bbox with soft edge:
bmCtx.filter = 'blur(6px)';
bmCtx.fillStyle = 'rgba(255,255,255,1)';
bmCtx.fillRect(tbX, tbY, tbW, tbH);
bmCtx.filter = 'none';
```

This error went undetected for multiple sessions because FLUX happened to preserve surrounding face areas closely enough that the bleeding wasn't visible. Ideogram does not — the gray bib desaturation area composited directly onto the face as a rectangular band.

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

### 3.6 The LoRA Plastic Slab Problem

The Dr. Apa LoRA (drdonelson/dental-lora) was trained on SDXL base (4-channel UNet). The SDXL inpainting model uses a 9-channel UNet — these weights are structurally incompatible. The LoRA is deployed on Modal using `StableDiffusionXLImg2ImgPipeline` (img2img, not inpainting).

At strength ≥ 0.70, img2img obliterates the existing tooth structure and generates a uniform white slab. At strength < 0.70, changes are too subtle. This has not been solved. A promising untested approach: run the LoRA on the full face at strength 0.40, then use MediaPipe to extract only the tooth pixels from the LoRA result and composite them back — discarding the LoRA's face changes while keeping its dental quality.

The LoRA represents 600 Dr. Apa cosmetic dental cases — the exact aesthetic target for this project. The problem is not the LoRA's knowledge; it's the deployment architecture.

### 3.7 Cloudflare Worker 30-Second Timeout

Cloudflare Workers have a hard 30-second subrequest limit. Modal inference takes 20–30s warm, 60–120s cold. The browser calls Modal **directly** (bypassing the Worker) with a 90-second AbortController and one auto-retry. The Worker's `/api/modal/inpaint` route exists for reference but is not called in production.

### 3.8 Replicate SDXL Cold Start Kills

Replicate's automated health checker disables model versions that consistently fail to respond. SDXL cold starts take 2–5 minutes. The health checker flagged them as failing and disabled all deployed versions. Replicate is not viable for SDXL-based models. Modal with persistent volume caching is the correct deployment for SDXL work.

### 3.9 Crop-Zoom Integration Problem

Zooming to 1024px gives the AI enough pixels to render individual tooth anatomy. But it also removes the face lighting context. The AI generates teeth with its own lighting model, which does not match the original photo. When composited back, the result looks like a pasted-on smile — technically clean but visually wrong.

This is an unsolved architectural tension. Full-face inference preserves lighting context but sacrifices tooth detail. Crop-zoom produces dental detail but breaks integration. The LoRA composite approach described in 3.6 may resolve this because the LoRA was trained on full-face photos and naturally understands full-face context.

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
| **Fix the output, not the source** | Post-processing color correction creates new artifacts. Strip the bib color from the input image before sending to AI. |
| **Opaque black blend mask background** | destination-in reads alpha, not color. Black is opaque. The entire crop composites onto the face. |
| **Wrong mask convention** | Ideogram expects black=edit. FLUX expects white=edit. gpt-image-2 expects transparent=edit. Getting it wrong tells the model to edit the face. |
| **High guidance_scale** | Values above 15 force the prompt over the source image. Generates plastic artificiality, not photorealism. |
| **Warm/ivory language in tooth prompt** | FLUX and Ideogram generate yellow teeth. Say "BL1 bright natural white." |
| **Crop-zooming without bib desaturation** | Blue bibs bleed into tooth color. Desaturate below the tooth bounding box before every AI call. |
| **Using buildToothMask** | Dead code. Finds 628 pixels. Misses everything non-white. Use buildMediaPipeMask. |
| **Running Modal through the Cloudflare Worker** | Hard 30-second subrequest limit. Call Modal directly from the browser. |
| **Deploying SDXL on Replicate** | Health checker will disable the model within hours. Use Modal with persistent volume caching. |
| **LoRA at strength ≥ 0.70** | Plastic slab. No exceptions. |

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

**Immediate:** The crop-zoom compositing produces a cut-and-paste look because the AI generates teeth without the face's lighting context. Two approaches to solve this have not been tested:

1. **Full-face Ideogram** — No crop-zoom. Send the full resized face image to Ideogram with the tooth bounding box mask. The AI sees full lighting context. May sacrifice tooth detail but gains integration.

2. **LoRA composite** — Run the Dr. Apa LoRA on the full face at strength 0.40. Get back a LoRA-quality smile integrated into the full face context. Use MediaPipe to extract only the tooth pixels from the LoRA result. Composite those pixels — and only those pixels — onto the original face. The face changes from the LoRA get discarded. The dental quality from 600 Dr. Apa training cases is preserved.

Option 2 is the most promising long-term path. The LoRA encodes exactly the aesthetic target. The problem has never been the LoRA's knowledge — it has been getting that knowledge composited cleanly onto patient photos.

---

## 9. The Compound Obligation

A patient sitting in Dr. Donelson's chair, looking at a before-and-after that looks like bad Photoshop, does not book a consultation. That patient leaves. The simulator exists because seeing is believing — but only if what they see is believable.

95 commits have gone into this project. Each one represents a hypothesis tested, a failure diagnosed, a constraint discovered. That knowledge is the floor. The next session starts from here, not from scratch.

The failure mode to avoid is the agent who reads none of this and confidently breaks every lesson we earned. Read the anti-patterns. Test against real photos. Compare to bitebot.io. Hold the line.

---

*The goal is not a demo. The goal is a patient who sees their future smile and books the appointment.*

