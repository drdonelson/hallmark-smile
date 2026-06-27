# Hallmark Smile Simulator — Developer Status Brief
*For external developer onboarding — June 2026*

---

## What This Is

A patient-facing AI smile simulator embedded on dental practice websites. Patient takes a selfie in the dental chair; the simulator shows a photorealistic "after" image of a full cosmetic makeover (Dr. Apa–style: golden proportion symmetry, individually defined teeth with visible embrasures, BL1 whitening). The goal is to make the patient emotionally commit to treatment before leaving the chair.

Competing product: **bitebot.io** — same product category, further along on quality.

**Live demo:** https://drdonelson.github.io/hallmark-smile/smile-simulator.html  
**First client embed:** https://sevenbridgesdentalstudio.com  
**Key files:** `smile-simulator.html` (all browser logic), `worker.js` (Cloudflare Worker API proxy)

---

## Business Context

- SaaS platform model: dental practices subscribe via Lucid ROI (lucidroi.com) for ~$149/mo
- Dr. David Donelson (dentist/founder) edits this repo directly — always pull before pushing
- Worker deployed to Cloudflare; simulator hosted on GitHub Pages
- Cloudflare R2 bucket (`TEMP_IMAGES`) is the single storage layer: metering, media library, consent audit, practice registry
- Usage metering is live: per-tenant quotas enforced via R2 counters

---

## Pipeline Architecture (Current)

```
Patient selfie (mobile camera)
    ↓
MediaPipe 468-point face mesh (browser WASM)
    → inner-lip geometry → tooth bounding box
    ↓
ideogramCropMakeover() — PRIMARY PATH
    → perioral ellipse edit zone (rx 0.85·tbW, ry 2.5·tbH)
    → crop from full-res photo, scale to 1024px longest side
    → tooth erase: fill tooth pixels rgb(20,12,12)
    → bib desaturation below ellipse
    → Ideogram v2 inpaint (Replicate API via CF Worker)
    → best-of-2 parallel draws, scored by embrasure definition
    → pixel-precise blend mask → composite back to original face
    ↓
Fallback chain (each fires only if primary throws):
  [1] FLUX Pro Fill crop-zoom (fal.ai) — DEAD (Modal/RunPod defunded)
  [2] gpt-image-2 crop-zoom (OpenAI)
  [3] Modal LoRA full-face img2img — DEAD
  [4] FLUX Pro Fill full image
  [5] RunPod ComfyUI — DEAD
  [6] Client-side HSL whitening (always works, lowest quality)
    ↓
After image displayed → video pregeneration starts immediately
    → Seedance v1 lite (fal.ai): 8s/720p, mouthing "this is amazing" + laugh
    → Patient presses "Watch Video" → attaches to already-running job
    ↓
Email to patient + dentist (Resend API via CF Worker)
    → hosted before/after URLs from R2 media library (48-hex tokens, 30-day TTL)
```

---

## What Bitebot Does Differently (Our Core Gap)

We've studied bitebot.io's output extensively. Their before/after pairs show subtle but consistent signs of **full lower-face regeneration**, not tooth inpainting:

| Signal | What It Means |
|---|---|
| Hair and upper face are pixel-identical to before | They're NOT doing full-face AI |
| But smile is noticeably WIDER than original anatomy allows | They're regenerating more than just teeth |
| Lip shape/support changes between before and after | Lower face (lips, gum, perioral region) is regenerated |
| No visible composite seam anywhere | Edit zone is large enough that the boundary is outside the face |
| Every case gets full arch canine-to-canine | Not constrained by original tooth detection |

**Their likely approach:** Inpaint a large perioral zone (ellipse covering teeth + gums + lips) so the boundary falls on cheek skin where any seam is invisible, then regenerate everything inside coherently. This is architecturally different from tooth-confined inpainting.

---

## Our Iteration History (From Inception)

### Attempt 1 — Brightness-threshold masking
Built `buildToothMask()` using HSV/brightness threshold to find white pixels. Finds ~628 pixels. Misses yellowish, stained, decayed teeth entirely. **Dead code. Never use.**

### Attempt 2 — ControlNet+LoRA full-face inpaint (Modal A10G)
SDXL + dental LoRA (drdonelson/dental-lora, 456MB, trained on ~600 Instagram before/after pairs from a dentist friend). Ran at 1024px full-face resolution — tooth region only ~200px wide. Cannot render individually defined tooth anatomy at 200px. Produces blurry, undefined blobs.

Additional failure: LoRA img2img had no workable strength range. Above 0.70 → white plastic slab. Below 0.70 → too subtle for damaged teeth. No sweet spot.

**Outcome: Demoted to Fallback 1. Now defunded (Modal/RunPod no longer active). LoRA weights survive on HuggingFace.**

### Attempt 3 — FLUX Pro Fill crop-zoom
Crop to mouth region, zoom to 1024px, FLUX inpaint. Mask convention: white=edit. Solid results but Ideogram outperformed it on tooth anatomy detail. Now Fallback 2.

### Attempt 4 — Ideogram v2 crop-zoom (current primary)
Key insight: crop to the tooth region at 2.0×/1.5× padding, scale to 1024px longest side. Teeth now fill ~205px of the input — vs ~200px at full-face but with 5× more AI compute focused on that zone. Ideogram v2 via Replicate.

**Critical sub-discoveries:**
- **Tooth erase:** Before sending to Ideogram, fill all MP-detected tooth pixels with `rgb(20,12,12)` (very dark). Without this, Ideogram sees existing light teeth and adjusts minimally → white slab with no embrasures. Dark fill makes every case behave like the missing-teeth case → full generation from scratch.
- **Pixel-precise blend mask:** Building the composite blend from a bounding rectangle gave a visible rectangular seam. Fixed by converting the MediaPipe mask (brightness→alpha) so the blend exactly follows tooth geometry.
- **Commissure fade:** The INNER_LIP polygon extends to the mouth corners. Ideogram drifts slightly at those corners even in the "preserve" zone. Fade blend alpha to 0 over the outer 5–10% of tooth width on each side.
- **destination-in alpha trap:** Canvas `destination-in` clips by SOURCE ALPHA, not color. Filling background with opaque black (alpha 255) = same as white. Blend mask canvas must default transparent.
- **Bib desaturation:** Patients wear teal/blue dental bibs. Ideogram samples surrounding context and generates blue teeth. Fix: desaturate all pixels below the tooth zone before sending to Ideogram.
- **Mask convention inversion:** Ideogram v2 uses BLACK=edit zone, WHITE=preserve. FLUX/SDXL use the opposite. Getting this wrong silently inverts which zone is regenerated.

### Attempt 5 — Lighting harmonization
After compositing Ideogram teeth onto the original face, the teeth appeared "pasted on" — too cool, too bright, disconnected from ambient lighting. Built `harmonizeTeeth()` using LAB color space illuminant transfer:
- Sample scene illuminant from perioral skin pixels (warm-only: `LAB a > 4`) — not whole crop (white walls contaminate the estimate and cyan-shift the teeth)
- Transfer ~half the chroma shift toward the illuminant
- Brightness P95 → match skin highlight level
- Per-column left/right light falloff

Solved the icy pasted-on teeth problem. Key constraint: must sample WARM perioral skin only, not the whole crop.

### Attempt 6 — Collapsed/edentulous detection
Patients with full-arch tooth loss have nearly closed mouths (upper/lower lips meet). The inner-lip bounding box is nearly horizontal — aspect ratio < 0.18 (normal smiles: 0.22–0.26). When collapsed:
- Use tighter crop (0.5×/1.0× padding, ~3:1 AR matching Ideogram's native output)
- Expand the edit zone vertically above and below bounds
- Switch to `perioralSmile` prompt variant
- Disable harmonization (already collapsed context)

### Attempt 7 — Perioral ellipse for collapsed cases
For true edentulous patients, tooth-confined inpainting couldn't restore lip support — inpainting is bounded by the original lip line. Fix: draw a perioral ellipse (center: tooth bbox center, rx=0.72·tbW, ry=2.2·tbH) covering the full mouth opening including lips. Ideogram regenerates the entire smile zone coherently. This is the approach closest to what bitebot does.

Validated 5/5 draws on reference edentulous photo. Shipped June 9.

### Attempt 8 — Best-of-2 QC
Ideogram has large run-to-run variance: same input → sometimes excellent, sometimes white slab or dark gaps at smile corners. Run two parallel draws, score both with `scoreToothGeneration()` (embrasure local-minima count + tonal stddev − cold-glare penalty + coverage/fill ratio), keep higher score. ~$0.16/run vs $0.08.

### Attempt 9 — Perioral ellipse for ALL normal cases (FAILED — reverted)
Attempt to close the bitebot gap by applying the perioral ellipse to all cases, not just edentulous. Used rx=0.85·tbW, ry=1.6·tbH. On patients with relatively intact teeth, Ideogram generated a grotesquely wide, anatomically impossible "clown smile." Reverted within hours. This was live on Seven Bridges Dental briefly.

**Why it failed on normal cases:** For edentulous patients, Ideogram has no competing tooth context — it generates freely. For patients with existing normal anatomy, the surrounding lip context constrains Ideogram's interpretation of "smile," and the ellipse shape tells Ideogram the smile is wider than it actually is.

### Attempt 10 — Hires geometry (current, shipped)
Production crop padding (2.0×/1.5×) spans nearly the full image → teeth at Ideogram are only ~205px wide, no real zoom benefit. Switch to: crop from the full-resolution photo (not the 1024px-downscaled working image), tight 0.5×/1.0× padding, ~3:1 aspect ratio matching Ideogram's native output. Teeth now hit Ideogram at ~500px. Dramatically sharper anatomy on most cases.

Previously blocked because severe full-arch decay cases artifacted (dark ticks/blotches) at tight crop — the tight crop loses facial context that anchors "healthy smile" generation. Now routing severe damage separately (see below).

### Attempt 11 — Perioral ellipse as default with larger aperture (current, shipped)
Re-applied the perioral approach to all cases but with better calibration: rx=0.85·tbW, ry=2.5·tbH (larger vertical than the failed attempt 9's 1.6), using `openSmile`/`perioralSmile` prompt. This time it worked without clown-face artifacts, validated across 7 case types. The larger ry prevents the ellipse from cutting through the smile arc.

### Attempt 12 — Severe damage routing
Added tooth brightness measurement (average brightness of original tooth pixels, pre-erase). If avgBright < 90 → routes to `fullArch` Ideogram variant instead of `normalSmile`. The `normalSmile` prompt explicitly negated "wider smile, different smile width" — the wrong constraint for heavily decayed teeth. The `fullArch` prompt explicitly requests "premolars visible toward the corners" and "broad confident smile arc filling the mouth opening."

---

## Current Quality Assessment

### What works well:
- Natural/mild discoloration cases — Ideogram generates clean BL1 teeth that integrate naturally
- True edentulous/collapsed cases — perioral ellipse gives convincing lip-supported smile
- Bib desaturation — dental bibs no longer generate teal teeth
- Lighting harmonization — eliminates the pasted-on look for normal cases
- Video generation — Seedance delivers in ~60s, pregenerated by the time patient watches

### Where we're still short of bitebot:
1. **Smile width on moderate damage** — Ideogram generates teeth to match the visible opening. Bitebot widens the smile beyond the original anatomy by regenerating the perioral region more aggressively.
2. **Gum-tooth transition** — when Ideogram-generated gum tissue is composited over the original face, there's a dark band where the two don't match. Current fix: blend only the tooth pixels (not generated gum), let original gum show. Works for most cases, imperfect on gum-showing smiles.
3. **Run-to-run variance** — best-of-2 reduces but doesn't eliminate bad draws (slab, partial arch, glare).
4. **Severe decay cases** — tight crop artifacts require separate handling.

---

## Technical Architecture Details

### Infrastructure
- **GitHub Pages** — static hosting for simulator HTML
- **Cloudflare Worker** — API proxy for all AI calls (enforces origin-locked CORS, metering, rate limiting)
- **Cloudflare R2** — storage: temp images (5-10 min TTL), media library (30-day, hosted URLs for email), consent audit log, usage counters, practice registry
- **Replicate** — Ideogram v2 inpaint (primary). `POST /api/ideogram/inpaint` → Worker polls every 4s
- **fal.ai** — Seedance video generation. `POST /api/kling/start` → Worker polls status
- **Resend** — transactional email (before/after to patient + dentist)
- **OpenAI** — gpt-image-2 fallback. Also SAM teeth segmentation endpoint (unused in primary path)

### Key Cloudflare Worker Limits
- 30-second subrequest wall clock. Ideogram takes 20–90s → Worker cannot wait for it. Solution: Worker starts the Replicate prediction, returns prediction ID, browser polls `/api/replicate/status?id=X` every 4s directly. Same pattern for all long-running jobs.
- This means all AI calls are effectively async from the browser's perspective.

### MediaPipe Integration
- Loaded from CDN via `@mediapipe/tasks-vision` npm package baked into a script tag
- Uses the face_landmarker task (468 landmarks)
- Runs fully client-side — face landmarks never leave the browser
- Returns INNER_LIP polygon (indices 78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191) → drawn to canvas → white-on-black mask PNG
- Critical: headless Chromium cannot run this (no WebGL). For server-side automation, use Python `mediapipe` with `harness/landmarks.py`

### Ideogram v2 Specifics
- Model on Replicate: `ideogram-ai/ideogram-v2`
- Mask convention: **BLACK = edit zone, WHITE = preserve zone** (opposite of FLUX/SDXL)
- Output aspect ratio: always ~3:1 regardless of input. A 5:1 input comes back 3:1 with letterboxing → keep crop AR near 3:1 to avoid double-resampling quality loss
- Generation time: 20–90s (queue-dependent)
- Cost: ~$0.08/image, $0.16/run with best-of-2

### Prompt Variants (worker.js)
| Variant | Used for | Key difference |
|---|---|---|
| `normalSmile` | Normal cases, intact teeth | Preserves smile width, negates "wider smile" |
| `fullArch` | Severe decay (avgBright <90) | Full arch corner-to-corner, drops "same width" constraint |
| `perioralSmile` | Edentulous/collapsed | Perioral zone regeneration, lip support |

---

## Local Development

```bash
# Test harness (runs worker proxy + serves harness.html)
node harness/server.mjs   # port 8788

# Harness URL params:
# photo=X.jpg             test photo from test-photos/ (gitignored)
# mode=baseline           original production path
# mode=hires              tight-crop high-res path
# mode=harmonize          with lighting harmonization
# gum=0.25                gum-band preservation experiment (not shipped)

# MediaPipe in harness (headless Chromium can't run it):
python harness/landmarks.py <photo>   # outputs JSON landmarks to stdout
```

Harness caches all intermediates to `test-outputs/<photo>/`. First run costs ~$0.08 via Worker proxy (spoofed Origin header). All subsequent iterations are free — reuses cached Ideogram output and lets you test compositing changes without new generations.

Patient test photos go in `test-photos/` — gitignored (repo is public).

---

## Path Forward: Without Training Data

These improvements are achievable with Ideogram inpainting as-is:

### 1. Aperture calibration per case type (2–4 hours)
The perioral ellipse rx/ry parameters (0.85 width, 2.5 height currently) are a single fixed value for all cases. Larger ry → more lip area regenerated → closer to bitebot. But too large → identity drift. Need to test more patients to find a stable ceiling.

Test tool: `harness.html?photo=X&rx=0.85&ry=2.5` (add tunable params to harness UI).

### 2. Artifact detection + retry (3–5 hours)
`scoreToothGeneration()` already runs on both best-of-2 draws. Add a minimum acceptable score threshold — if both draws score below it, run a third draw. Catches the ~15% of runs that produce slabs or partial arches. Adds $0.08 and ~30s to those cases only.

### 3. Gum-band anchor for gum-showing smiles (4–8 hours)
When patients show gum above upper teeth, full tooth erase leaves Ideogram no gingival anchor → dark void above generated teeth. Research in harness (`gum=0.25`): preserve the top 25% of each tooth column (globally if ≥40% of columns have healthy pink gum, else erase fully). This `global-per-photo` decision prevents the per-pixel/per-column blotch artifacts. Validated at hires crop, needs production crop validation before ship.

### 4. Scoring improvements (2–3 hours)
`scoreToothGeneration()` uses embrasure local-minima + tonal stddev + coverage. Add:
- Symmetry check: left/right half brightness difference (slabs fail this)
- Width check: ratio of bright pixels in the tooth band vs band area (narrows fail this)
- Glare penalty: over-exposed highlights covering >40% of tooth area

### 5. FLUX Kontext as alternative primary (exploratory, 1–2 days)
FLUX Dev Kontext (released mid-2026) takes a reference image and transforms it instruction-following. Could sidestep Ideogram's inpainting constraints entirely — instead of masking, describe "replace the teeth with BL1 veneers, keep everything else." No mask needed. Quality unknown for this use case. Worth a proof-of-concept run on the test harness.

---

## Path Forward: With Training Data (Closes the Bitebot Gap)

This is the path to truly matching or beating bitebot. Bitebot's quality edge almost certainly comes from a fine-tuned model trained on real before/after pairs.

### What we have
- ~600 before/after pairs scraped from a dentist friend's Instagram (NOT commercially licensed — privacy/copyright issue for commercial use, needs written partner agreement)
- Weights survive on HuggingFace (`drdonelson/dental-lora`) and possibly RunPod volumes (unverified)
- Dr. D's own practice archive: photo pairs exist (e.g., `_DSC1529` before / `_DSC3401` after for the edentulous reference patient)

### FLUX Kontext LoRA — the right vehicle
FLUX Dev Kontext LoRA fine-tuning needs only **50–150 before/after pairs** (far less than Stable Diffusion LoRA). With good pairs from Dr. D's own archive, this is achievable without the copyright issue.

**Training pair requirements:**
- Matched lighting (same room, same time)
- Same face position (slight angle variation OK)
- Full-face photos, not crops
- At least 3 case types: mild whitening, veneer makeover, full-arch restoration
- 50+ pairs per case type for reliable generalization

**What a fine-tuned FLUX Kontext LoRA would change:**
- No mask needed — the model understands "cosmetic dental makeover" as a transformation instruction
- No crop-zoom required — model operates at full face, knows dental anatomy
- No bib desaturation hack — model learns to ignore bibs from training data
- Full perioral coherence — lips, gum, teeth regenerated as a unit because the model saw real results
- Eliminates run-to-run variance — trained signal is far more consistent than zero-shot prompting

### Training workflow
1. Curate 50–100 pairs from Dr. D's own archive (or partner practice with written consent)
2. Fine-tune FLUX Dev Kontext LoRA on Replicate or fal.ai (both have hosted training)
3. Deploy the fine-tuned model version to Replicate
4. Replace `ideogramCropMakeover()` with a full-face FLUX Kontext call
5. Keep current pipeline as fallback for cases the trained model mishandles

**Cost estimate:** FLUX Kontext LoRA training on Replicate ~$30–80 for 100 pairs/2000 steps. Inference ~$0.06/image. Should outperform current Ideogram at both quality and cost.

---

## Known Hard Constraints

| Constraint | Why It Matters |
|---|---|
| Cloudflare Worker 30s limit | All AI calls must be async (start job → return ID → browser polls). Never wait inside Worker. |
| Ideogram mask is BLACK=edit | Opposite of FLUX/SDXL. Getting this backwards silently edits the face and preserves the teeth. |
| MediaPipe requires WebGL | Can't run in headless Chromium. Use Python mediapipe for server-side automation. |
| Tooth erase is mandatory | Without erasing existing teeth to dark, Ideogram generates a featureless slab (even BL1 teeth fail this). |
| Ideogram output is always ~3:1 AR | Input an unusual AR → Ideogram pads/crops and returns 3:1. Keep input near 3:1 or pay a sharpness penalty from double resampling. |
| HIPAA: face photos are identifiers | Public marketing embeds (visitor's selfie) are generally outside HIPAA scope. Chairside use by a practice on a patient's chart IS HIPAA-regulated. Replicate/fal.ai/Resend don't sign BAAs — genuine blocker for chairside HIPAA compliance. AWS S3 gives free BAA. |
| Instagram training data not licensed | The 600 pairs from a friend's Instagram need a written commercial license for commercial model training. Dr. D's own archive is clean. |

---

## Repo Structure

```
hallmark-smile/
├── smile-simulator.html    # All browser pipeline logic (~3000 lines)
├── worker.js               # Cloudflare Worker API proxy + all AI integrations
├── dashboard.html          # Lead management Kanban (dentist-facing)
├── legal/                  # Privacy, terms, disclaimer pages
│   ├── privacy.html
│   ├── terms.html
│   └── disclaimer.html
├── modal-model/
│   └── dental_app.py       # ControlNet+LoRA (defunded, weights on HF)
├── harness/
│   ├── server.mjs          # Local test server (port 8788)
│   ├── harness.html        # Test UI with mode/photo params
│   ├── landmarks.py        # Python MediaPipe (headless alternative)
│   ├── test-video.mjs      # End-to-end video generation test
│   └── frames.html         # Frame-strip inspection UI
├── test-photos/            # Gitignored — patient photos
├── test-outputs/           # Gitignored — cached generation intermediates
├── COLD_START.md           # Hard-won lessons + anti-patterns (read before touching pipeline)
├── DEVELOPER_HANDOFF.md    # Comprehensive technical handoff
└── COMPLIANCE.md           # HIPAA/BAA matrix and attorney review checklist
```

---

## Priority Order for a Developer Sprint

**If the goal is matching bitebot quality WITHOUT training data (1 week):**
1. Aperture parameter sweep across 10+ patient types — find stable ellipse rx/ry ceiling
2. Artifact detection + auto-retry (score threshold)
3. Gum-band anchor (global per-photo decision, production crop)
4. FLUX Kontext as alternative primary (proof-of-concept)

**If training data is available (3–4 weeks total):**
1. Curate + license 50+ pairs from Dr. D's archive
2. Fine-tune FLUX Kontext LoRA on Replicate
3. A/B test against current Ideogram pipeline on standard case set
4. If validated: replace primary path, keep Ideogram as fallback
5. Pairs-trained model should close the remaining bitebot gap entirely

---

*Document written June 2026. Check COLD_START.md before touching the pipeline — many of these lessons were learned the hard way.*
