# Hallmark Smile Simulator — Complete Developer Handoff

**Date:** May 2026  
**Project:** Hallmark Dental Smile Simulator  
**Owner:** Dr. David Donelson — david@hallmarkdds.com  
**Live URL:** https://app.lucidroi.com/smile-simulator.html (github.io 301s here)  
**Quality Target:** https://bitebot.io — open this in a tab before touching any code  

---

> ## ⚠️ CURRENT STATE (2026-07-11) — the doc below is the historical arc; read this box for what's live
> - **PRIMARY engine is now Google Gemini** (`gemini-3-pro-image`, in-place teeth edit) via a metered Worker endpoint **`POST /api/gemini/edit`** — dentist-rated cleaner than GPT, ~18s, no Modal. **GPT-Modal → Ideogram are now fallbacks.** (`GEMINI_PRIMARY` flag in `smile-simulator.html`; `GEMINI_API_KEY` is a Worker secret.)
> - The **GPT path** (server-side on Modal, inner-lip keep-lips composite, deterministic geometric quality gate) is **fallback-only** now — still in the code.
> - **Security hardened** (2026-07-08/10): metering double-charge fix, Modal auth fails-closed, image-bound meter token, removed the unmetered OpenAI proxy, locked `/api/gpt-shadow`.
> - **Cost:** old GPU app `dental-lora` is STOPPED. Real per-sim cost is the image API (OpenAI/Gemini, ~cents), NOT Modal.
> - **Video:** Kling 2.5 Turbo Pro; default style **"Talk & laugh"** (`talklaugh`).
> - Full detail: **`COLD_START.md` v6.0 + §3.16** and memory `feedback_gpt_and_video_2026-07.md`.

---

## Why This Exists

A patient sits in Dr. Donelson's chair with broken, missing, or severely stained teeth. The consultation depends on them being able to *see* what's possible before any cost discussion begins. Not a stock photo. Not a diagram. Their actual face, transformed to Dr. Apa cosmetic quality — in under 30 seconds, on the spot.

The simulator takes a photo from a phone or tablet, runs it through a full AI inpainting pipeline, and shows a side-by-side before/after. If the result is believable, the patient books. If it looks like bad Photoshop, they leave.

The quality standard is bitebot.io. Individual teeth with visible embrasures, BL1 white, correct proportions, face completely unchanged. Anything short of that standard is a failure in the consultation room.

---

## Repository Structure

```
hallmark-smile/
├── smile-simulator.html    → Single-file frontend (GitHub Pages)
├── worker.js               → Cloudflare Worker API proxy
├── modal-model/
│   ├── dental_app.py       → Modal.com inference server (A10G GPU)
│   └── download_weights.py → One-time weight pre-loader for Modal volume
├── COLD_START.md           → Earlier cold-start doc (still valid, read it too)
└── DEVELOPER_HANDOFF.md    → This file
```

**Deployments:**
| Target | How | Time |
|---|---|---|
| GitHub Pages | Push to `main` | ~60s |
| Cloudflare Worker | GitHub Actions on push | ~30s |
| Modal inference server | `python3 -m modal deploy modal-model/dental_app.py` | Manual |

**Worker URL:** `https://quiet-forest-e1f8.david-d73.workers.dev`  
**Modal endpoint:** `https://drdonelson--dental-lora-dentalmodel-inpaint.modal.run`

---

## Phase 1 — Building the Foundation

### What We Needed Before Any AI Could Work

Before any inpainting model can produce a good result, you need two things: (1) a tight crop that zooms to the tooth region, and (2) an accurate mask of exactly where the teeth are.

#### Tooth Detection — Two Attempts

**Attempt 1: Brightness Threshold (`buildToothMask`)**
Find pixels brighter than a threshold. Result: detected ~628 pixels and completely missed yellowed, stained, or damaged teeth — the exact patients who most need the simulator. This function still exists in the code as dead code. Do not resurrect it.

**Attempt 2: MediaPipe 468-Point Face Mesh (`buildMediaPipeMask`)**
Uses Google's MediaPipe face landmarker to geometrically locate the tooth area using facial landmark indices, regardless of tooth color. Consistently finds 6,000+ pixels. This is the production path.

The key indices are the `INNER_LIP` polygon (indices including 78, 308 = commissure corners) which traces the inner boundary of the mouth opening. The `bounds` object gives `{xMin, xMax, yMin, yMax}` of the tooth region.

#### The Crop-Zoom Pattern

All primary AI paths use the same geometry:
1. MediaPipe finds tooth bounds
2. Compute crop box: **2.0× horizontal padding, 1.5× vertical padding** around bounds
3. Scale crop to **1024px on longest side**, rounded to 64px increments
4. Pre-process the crop (bib desaturation + tooth erase — see below)
5. Create AI mask for that model's convention
6. Receive AI result, composite tooth region back onto original face

#### Dental Bib Color Contamination

Every patient wears a light blue/teal dental bib. It sits below the teeth in every crop. FLUX and Ideogram sample surrounding color context — they see the blue bib and generate blue teeth.

**Fix:** Before sending the crop to any AI model, desaturate all pixels below the tooth bounding box (`tbY + tbH + 4` to `outH`). The model sees neutral gray below the teeth instead of blue. Post-processing color correction on the output was tried and failed — it creates new artifacts at blend edges. Fix the source, not the output.

#### The Blend Mask Bug (Most Critical Lesson)

`destination-in` composite mode clips by **source alpha**, not source color. A canvas filled with opaque black (`rgba(0,0,0,255)`) has alpha=255 — identical to opaque white. If the blend mask background is opaque black, `destination-in` preserves every pixel and the entire crop composites onto the face.

**Correct blend mask:** leave the canvas default-transparent. Draw only the tooth region. Then blur for soft feathering.

This was undetected for multiple sessions because FLUX happened to preserve the surrounding face closely enough. Ideogram does not — the gray bib desaturation area composited as a rectangular band across the face. The bug is documented in COLD_START.md §3.1 with code examples.

---

## Phase 2 — Custom LoRA Training

### Why We Trained a LoRA

Off-the-shelf inpainting models (FLUX, Ideogram, SDXL) don't know what cosmetic dental work looks like. They generate something generically "white and tooth-shaped" — not the specific aesthetic this practice produces: golden proportion spacing, BL1 shade, individually defined crowns, healthy gingival scalloping, correct emergence profiles.

Dr. Donelson provided 600 before/after cosmetic case photos — all Dr. Apa-level work. We trained a SDXL LoRA on these cases.

**LoRA:** `drdonelson/dental-lora` on HuggingFace
**File:** `dental-lora.safetensors` (456MB)
**Base model:** Stable Diffusion XL base 1.0
**Training data:** 600 real cosmetic dental case photos

The LoRA encodes exactly the right aesthetic. The problem is not its knowledge — it's every deployment architecture we've tried.

### Why The LoRA Doesn't Work as a Standalone Solution

**Problem 1: Architecture Incompatibility**

The LoRA was trained on the SDXL base model, which uses a **4-channel UNet**. SDXL Inpainting uses a **9-channel UNet** (the extra 5 channels carry the mask and masked image). These are structurally incompatible. You cannot load a 4-channel LoRA into a 9-channel inpainting pipeline.

**Problem 2: img2img Strength Cliff**

The only fully compatible path is img2img (`StableDiffusionXLImg2ImgPipeline`). At strength ≥ 0.70, img2img obliterates existing tooth structure and generates a uniform white slab. At strength < 0.70, the change is too subtle to matter for patients with significant dental problems. There is no workable sweet spot.

**Problem 3: ControlNet + LoRA — Resolution Limit**

We built a third deployment using `StableDiffusionXLControlNetInpaintPipeline` (4-channel UNet, compatible with the LoRA) with `diffusers/controlnet-canny-sdxl-1.0`. This was briefly in production.

The ControlNet operates on the full face at ~1024px. The tooth region in a typical dental photo is only **~200px wide** at full-face resolution. At 200px, you cannot render individually-defined tooth anatomy. Additionally, for patients with missing or damaged teeth, canny edge extraction inside the mask produces garbage (dark gaps, broken stumps). We fixed this by zeroing canny inside the mask (`edges[mask_array > 128] = 0`), but then ControlNet conditions on nothing inside the tooth area and the LoRA generates a slab.

**ControlNet is currently Fallback 1.** It only activates if Ideogram fails.

**Problem 4: Replicate Health Checker**

Replicate's automated health checker disables model versions that fail to respond quickly. SDXL cold starts take 2–5 minutes. Replicate disabled every deployed version within hours. Replicate is not viable for SDXL. We moved to Modal.com with persistent volume caching — weights survive container restarts via the `dental-lora-weights` volume.

---

## Phase 3 — Current Primary Path: Ideogram Crop-Zoom

### Why Ideogram Over Our LoRA

Ideogram v2 at 1024px crop-zoom produces **5× more pixel density** in the tooth region than full-face ControlNet (~200px tooth width). More pixels → more room for individual tooth anatomy → visible embrasures → looks like cosmetic dental work.

### The Full Ideogram Pipeline (`ideogramCropMakeover` in smile-simulator.html)

```
1. MediaPipe bounds → compute crop box (2× horiz, 1.5× vert padding)
2. Scale crop to 1024px (outW × outH)
3. Bib desaturation: pixels below tbY+tbH → grayscale
4. Load MediaPipe mask image (mpMaskImg)
5. TOOTH ERASE: fill tooth pixels with dark color (20,12,12)
6. Send crop + inverted MP mask to Ideogram v2 via worker
7. Poll Replicate status endpoint every 4s (max 120s)
8. Receive Ideogram output
9. Build pixel-precise blend mask from MP mask (brightness→alpha conversion)
10. COMMISSURE FADE: fade blend to 0 at outer 10% of tooth-bbox width
11. 10px blur for soft feathering
12. destination-in composite: clip Ideogram result to tooth shape
13. Draw onto original face at (cx,cy,cw,ch)
```

### The Mask Conventions (All AI Models Are Different)

| Model | Edit Zone | Preserve Zone |
|---|---|---|
| FLUX Pro Fill (fal.ai) | **White** pixels | Black pixels |
| Ideogram v2 (Replicate) | **Black** pixels | White pixels |
| SDXL inpainting | **White** pixels | Black pixels |
| gpt-image-2 (OpenAI) | **Transparent** (alpha=0) | Opaque (alpha=255) |

Getting this wrong silently inverts what the model edits — it edits the face and preserves the teeth.

### The Tooth-Erase Fix (Solves Sloppy/Undefined Teeth)

**The problem:** When a patient has existing light or white teeth, Ideogram sees them as "already tooth-colored" and adjusts minimally. The result is a white slab — the original blob structure, slightly brightened, no embrasures, no individual crowns.

**The fix:** Before sending to Ideogram, fill all tooth pixels (identified by the MediaPipe mask) with near-black (`rgb(20,12,12)` — dark mouth interior). Ideogram now sees a dark cavity regardless of original tooth color. It generates fresh teeth from scratch with defined embrasures, exactly like it does for patients with missing teeth.

This is why the missing-teeth case consistently produced the best results before this fix: dark input → Ideogram generates from scratch → defined individual teeth. Every case now gets a dark canvas.

### The Commissure Seam Fix

The `INNER_LIP` polygon extends to the mouth corners (commissures). The blend mask derived from this polygon includes those corners. When Ideogram's output at the commissure corners differs slightly from the original (even in the "white=preserve" zone), the difference shows through as a visible artifact at the corner of the mouth.

**Fix:** After converting MediaPipe mask brightness→alpha, fade alpha to 0 over the outer 10% of the tooth-bbox width on each side. Commissure corners always show original face pixels. The blend only covers the central tooth area.

---

## Current Pipeline Order (Production)

```
Patient photo
    ↓ MediaPipe 468-landmark detection (all cases)
    ↓
[Primary]    Ideogram v2 crop-zoom  → ideogramCropMakeover()
[Fallback 1] ControlNet+LoRA        → loraCompositeMakeover() via Modal A10G
[Fallback 2] FLUX Pro Fill crop-zoom → fluxCropMakeover()
[Fallback 3] gpt-image-2 crop-zoom  → gptMaskWhiten()
[Fallback 4] Modal LoRA full-face   → legacy path
[Fallback 5] FLUX Pro Fill full image
[Fallback 6] RunPod ComfyUI
[Fallback 7] Client-side HSL whitening (last resort, no AI)
```

---

## Where We Are Still Having Difficulty

These are the honest remaining gaps between current output and bitebot.io quality.

### 1. Lighting Integration — Core Architectural Problem (Unsolved)

Crop-zoom sends a 1024px patch to Ideogram without the full face lighting context. Ideogram generates teeth with its own lighting model, which doesn't match the actual photo. When composited back, the teeth look like they were photographed under different light — technically clean but visually wrong.

Full-face inference preserves lighting context but produces only ~200px of tooth detail. Crop-zoom produces tooth detail but breaks integration. This is the fundamental unsolved tension.

bitebot.io solves this — their results show seamless lighting integration across the full face with no visible crop boundary. How they achieve this is unknown. Most likely: a model trained end-to-end on full-face dental transformation pairs, not a crop-and-composite architecture.

### 2. Ideogram Prompt Reliability

Ideogram v2 does not always produce defined inter-dental embrasures even when the prompt explicitly demands them. For some patient photos, it still generates a solid white band. The dark tooth-erase step should reduce this but hasn't been fully validated across all dental conditions.

### 3. Upper Gum Line Stitching

For close-up photos or certain face angles, the compositing boundary is visible at the upper gum line — where the Ideogram result meets the original upper lip. This is partly a blend mask issue and partly a lighting mismatch. Current 10px blur sometimes isn't enough.

### 4. The LoRA Composite Approach (Untested, Most Promising)

The conceptually best path given existing assets hasn't been fully implemented:

1. Run the Dr. Apa LoRA on the **full face** at strength ~0.40 (low enough to preserve face structure, enough for the LoRA to apply cosmetic knowledge)
2. Get a LoRA-modified full-face image — face lighting preserved because the LoRA operates on the full photo, dental aesthetic from 600 real cases
3. Use MediaPipe to extract **only the tooth pixels** from the LoRA result
4. Composite those tooth pixels — and only those — onto the original face, discarding the LoRA's face changes

This would address the lighting problem because the LoRA sees the full photo. The blocking issue is finding the strength that applies enough dental transformation without drifting the face structure. Strength 0.40 may be too subtle. Strength 0.55–0.65 starts drifting the face.

---

## Anti-Patterns — Things That Were Tried and Failed

| What | Why It Fails |
|---|---|
| Post-processing color correction on output | Under-corrects or over-corrects. Creates new artifacts at blend edges. Fix the input. |
| Opaque black blend mask background | `destination-in` reads alpha. Black = alpha 255. Entire crop bleeds onto face. |
| Rectangular blend mask only | Shows a visible rectangle at the composite boundary. Use the MediaPipe polygon shape. |
| Pixel-precise blend including commissures | Ideogram color drift at commissure corners shows as seam. Fade blend at outer 10% of bbox. |
| Light/white tooth pixels sent to Ideogram | Ideogram adjusts minimally. Produces slab. Erase to dark first. |
| FLUX guidance_scale: 25 | Forces prompt over source image. Plastic look. Optimal: 10–15. |
| "Warm" or "ivory" in tooth prompt | FLUX and Ideogram generate yellow teeth. Use "BL1 bright natural white" only. |
| Crop-zoom without bib desaturation | Blue bibs bleed into tooth color. Always desaturate below tooth bbox. |
| `buildToothMask` (brightness threshold) | Finds 628 pixels. Misses non-white teeth entirely. Dead code — do not use. |
| SDXL LoRA loaded into inpaint pipeline | 4-channel vs 9-channel UNet incompatibility. Failure or garbage. |
| LoRA img2img at strength ≥ 0.70 | Generates a white slab. No individual teeth. |
| Deploying SDXL on Replicate | Health checker disables within hours. Use Modal with persistent volume. |
| Modal called through Cloudflare Worker | 30-second subrequest hard limit. Call Modal directly from the browser. |

---

## Key Technical Facts for Code Review

**MediaPipe INNER_LIP indices:**
```javascript
const INNER_LIP = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95];
// Point 78 = right commissure. Point 308 = left commissure.
```

**Crop geometry (ideogramCropMakeover):**
```javascript
const padX = (bounds.xMax - bounds.xMin) * 2.0;   // 2× tooth width on each side
const padY = (bounds.yMax - bounds.yMin) * 1.5;   // 1.5× tooth height top/bottom
const scale = Math.min(1024 / cw, 1024 / ch);
const outW  = Math.round(cw * scale / 64) * 64;   // 1024px, 64px-aligned
const outH  = Math.round(ch * scale / 64) * 64;
```

**Tooth-erase (forces full generation):**
```javascript
for (let i = 0; i < te.length; i += 4) {
  if (teMask[i] > 128) { te[i] = 20; te[i+1] = 12; te[i+2] = 12; }
}
```

**Blend mask — brightness→alpha:**
```javascript
for (let i = 0; i < am.length; i += 4) {
  const brightness = Math.round(0.299 * am[i] + 0.587 * am[i+1] + 0.114 * am[i+2]);
  am[i] = 255; am[i+1] = 255; am[i+2] = 255;
  am[i+3] = brightness;  // white=opaque, black=transparent
}
```

**Commissure fade:**
```javascript
const commMargin = Math.round(tbW * 0.10);
for (let i = 0; i < am.length; i += 4) {
  const x    = (i / 4) % outW;
  const minH = Math.min(x - tbX, (tbX + tbW) - 1 - x);
  if (minH < commMargin) {
    am[i + 3] = Math.round(am[i + 3] * Math.max(0, minH / commMargin));
  }
}
```

**numpy<2 pin order (Modal — critical):** Each `.pip_install()` call is a separate Docker layer. `opencv-python-headless` upgrades numpy to 2.4.6 in its layer, breaking `torch==2.1.2`. Must repeat `"numpy<2"` in the same `.pip_install()` call as opencv:
```python
.pip_install("diffusers==0.27.2", ..., "opencv-python-headless", "numpy<2")
#                                                                   ^^^^^^^^ required
```

**Modal — call from browser, not worker:** Cloudflare Workers hard limit 30 seconds. Modal warm inference = 20–30s. The browser calls Modal directly (`AbortController` at 90s with one retry). The worker `/api/modal/inpaint` route exists for reference only.

---

## What bitebot.io Does That We Don't (Hypothesis)

Looking at their before/after output vs ours:

1. **Full-face generation, not crop-zoom.** Their results show seamless lighting integration across the entire face — no visible crop boundary. They are almost certainly running the full face through their model, not compositing a cropped patch.

2. **Model trained specifically on dental transformations.** The output quality suggests a model fine-tuned on many thousands of dental before/after pairs at full-face level — not a general inpainting model with a dental prompt.

3. **No visible compositing step.** The result looks like one coherent photograph, not a face with teeth inserted.

**The path to bitebot.io quality most likely requires one of:**
- A full-face inpainting or diffusion model trained end-to-end on dental transformation pairs (their approach)
- OR the LoRA composite approach: run Dr. Apa LoRA full-face at low strength, extract only tooth pixels via MediaPipe, composite with a tight mask — this preserves face lighting because the LoRA operates on the full photo

The second path is achievable with existing assets (456MB of Dr. Apa dental knowledge already trained). The blocking question is finding the strength setting where the LoRA transforms teeth enough to matter without drifting the face. This is the most promising next experiment.

---

## Quick Start for New Developer

```bash
git clone https://github.com/drdonelson/hallmark-smile.git
cd hallmark-smile

# Live demo
open https://drdonelson.github.io/hallmark-smile/smile-simulator.html

# Quality target — open this first
open https://bitebot.io

# Deploy Modal inference server (needs Modal account with A10G access)
pip3 install modal
python3 -m modal deploy modal-model/dental_app.py

# Worker needs REPLICATE_API_TOKEN, FAL_API_KEY, OPENAI_API_KEY as Cloudflare secrets
# Push to production
git push origin main  # GitHub Actions deploys worker; Pages deploys frontend
```

Test with real office photos — patients in dental chairs with bibs, office lighting, a range of dental conditions. Stock photos will not reveal the real failure modes.

---

## Remaining Work Summary

| Problem | Status | Best Known Next Step |
|---|---|---|
| Sloppy/undefined teeth (white slab) | Fixed in latest commit | Validate across patient types |
| Commissure seam at mouth corners | Fixed in latest commit | Validate, may need fade % tuned |
| Upper gum line stitching | Partially addressed | Larger blur or alpha feathering |
| Lighting mismatch (crop-zoom vs face) | **Unsolved** | LoRA composite at full face, or full-face Ideogram |
| LoRA aesthetic at usable strength | **Unsolved** | Low-strength composite + tooth-pixel extraction |
| bitebot.io-level seamless integration | **Unsolved** | Likely requires full-face model trained on dental pairs |

---

*The goal is not a demo. The goal is a patient who sees their future smile and books the appointment.*
