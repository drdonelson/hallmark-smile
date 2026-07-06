# Hallmark Smile Simulator — Developer Status Brief
*For external developer onboarding — July 2026*

---

## What This Is

A patient-facing AI smile simulator embedded on dental practice websites. Patient takes a selfie in the dental chair; the simulator shows a photorealistic "after" image of a full cosmetic makeover (Dr. Apa–style: golden proportion symmetry, individually defined teeth with visible embrasures, BL1 whitening). The goal is to make the patient emotionally commit to treatment before leaving the chair.

Competing product: **bitebot.io** — same product category, further along on quality.

**Live demo:** https://drdonelson.github.io/hallmark-smile/smile-simulator.html  
**First client embed:** https://sevenbridgesdentalstudio.com  
**Key files:** `smile-simulator.html` (all browser logic), `worker.js` (Cloudflare Worker API proxy)

---

## Business Context

- SaaS platform model: dental practices subscribe via Lucid ROI (lucidroi.com)
- Dr. David Donelson (dentist/founder) edits this repo directly — always pull before pushing
- Worker deployed to Cloudflare; simulator hosted on GitHub Pages
- Cloudflare R2 bucket (`TEMP_IMAGES`) is the single storage layer: metering, media library, consent audit, practice registry
- Usage metering is live: per-tenant quotas enforced via R2 counters

---

## Pipeline Architecture (Current — July 2026)

```
Patient selfie (mobile camera)
    ↓
MediaPipe 468-point face mesh (browser WASM)
    → inner-lip geometry → tooth bounding box + landmarks
    ↓
gptCompositeMakeover() — PRIMARY PATH (July 2026)
    → full-face photo sent to gpt-image-1 (quality:medium, 40s abort)
    → MediaPipe run on BOTH original and GPT output
    → affine warp: GPT mouth landmarks → original mouth landmarks (solveAffine)
    → composite ONLY the mouth back onto the untouched original face
    → mask: OUTER-lip polygon grown ~16% + feathered 18% of mouth width
    → guard: reject if scale <0.55 or >1.8, or center shift >12% width
    ↓ (on GPT timeout, bad alignment, or throw)
ideogramCropMakeover() — FALLBACK 1
    → perioral ellipse edit zone (rx 0.85·tbW, ry 2.5·tbH) [ALL cases]
    → crop from full-res photo, scale to 1024px longest side (hires geometry)
    → tooth erase: fill tooth pixels rgb(20,12,12)
    → bib desaturation below ellipse
    → cant correction: rotate crop canvas by -tiltAngle (from interpupillary line)
    → Ideogram v2 inpaint (Replicate API via CF Worker)
    → best-of-2 parallel draws, scored by embrasure definition
    → pixel-precise blend mask (MP-only, +12% upward for perioral gingiva)
    → composite back to original face
    ↓
Remaining fallbacks (each fires only if previous throws):
  [2] FLUX Pro Fill crop-zoom (fal.ai)
  [3] gpt-image-2 crop-zoom (OpenAI)
  [4] Modal LoRA full-face img2img — DEAD (defunded)
  [5] FLUX Pro Fill full image
  [6] RunPod ComfyUI — DEAD (defunded)
  [7] Client-side HSL whitening (always works, lowest quality)
    ↓
After image displayed → video pregeneration starts immediately
    → Kling 2.5 Turbo Pro (fal.ai): 5–10s, best-in-class smile reveal + laugh
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

**As of July 2026, our GPT full-image + tooth composite primary is now competitive** on normal and moderate-damage cases. Severe missing/broken cases have historically been our biggest failure; GPT full-image solves them because it sees the full facial context when generating the replacement smile.

---

## Our Iteration History (From Inception)

### Attempt 1 — Brightness-threshold masking
Built `buildToothMask()` using HSV/brightness threshold to find white pixels. Finds ~628 pixels. Misses yellowish, stained, decayed teeth entirely. **Dead code. Never use.**

### Attempt 2 — ControlNet+LoRA full-face inpaint (Modal A10G)
SDXL + dental LoRA (drdonelson/dental-lora, 456MB, trained on ~600 Instagram before/after pairs from a dentist friend). Ran at 1024px full-face resolution — tooth region only ~200px wide. Cannot render individually defined tooth anatomy at 200px. Produces blurry, undefined blobs.

Additional failure: LoRA img2img had no workable strength range. Above 0.70 → white plastic slab. Below 0.70 → too subtle for damaged teeth. No sweet spot.

**Outcome: Demoted to Fallback. Now defunded (Modal/RunPod no longer active). LoRA weights survive on HuggingFace.**

### Attempt 3 — FLUX Pro Fill crop-zoom
Crop to mouth region, zoom to 1024px, FLUX inpaint. Mask convention: white=edit. Solid results but Ideogram outperformed it on tooth anatomy detail. Now Fallback 2.

### Attempt 4 — Ideogram v2 crop-zoom (became primary, now Fallback 1)
Key insight: crop to the tooth region at 2.0×/1.5× padding, scale to 1024px longest side. Ideogram v2 via Replicate.

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

Solved the icy pasted-on teeth problem. Key constraint: must sample WARM perioral skin only, not the whole crop. Note: this is disabled for the perioral path and not needed at all for the GPT primary path.

### Attempt 6 — Collapsed/edentulous detection
Patients with full-arch tooth loss have nearly closed mouths (upper/lower lips meet). The inner-lip bounding box is nearly horizontal — aspect ratio < 0.18 (normal smiles: 0.22–0.26). When collapsed:
- Use tighter crop (0.5×/1.0× padding, ~3:1 AR matching Ideogram's native output)
- Expand the edit zone vertically above and below bounds
- Switch to `perioralSmile` prompt variant
- Disable harmonization

### Attempt 7 — Perioral ellipse for collapsed cases
For true edentulous patients, tooth-confined inpainting couldn't restore lip support — inpainting is bounded by the original lip line. Fix: draw a perioral ellipse (center: tooth bbox center, rx=0.72·tbW, ry=2.2·tbH) covering the full mouth opening including lips. Ideogram regenerates the entire smile zone coherently. This is the approach closest to what bitebot does.

Validated 5/5 draws on reference edentulous photo. Shipped June 9.

### Attempt 8 — Best-of-2 QC
Ideogram has large run-to-run variance: same input → sometimes excellent, sometimes white slab or dark gaps at smile corners. Run two parallel draws, score both with `scoreToothGeneration()` (embrasure local-minima count + tonal stddev − cold-glare penalty + coverage/fill ratio), keep higher score. ~$0.16/run vs $0.08.

### Attempt 9 — Perioral ellipse for ALL normal cases (FAILED — reverted)
Attempt to close the bitebot gap by applying the perioral ellipse to all cases, not just edentulous. Used rx=0.85·tbW, ry=1.6·tbH. On patients with relatively intact teeth, Ideogram generated a grotesquely wide, anatomically impossible "clown smile." Reverted within hours. This was live on Seven Bridges Dental briefly.

**Why it failed on normal cases:** For edentulous patients, Ideogram has no competing tooth context — it generates freely. For patients with existing normal anatomy, the surrounding lip context constrains Ideogram's interpretation of "smile," and the ellipse shape tells Ideogram the smile is wider than it actually is.

### Attempt 10 — Hires geometry (shipped)
Production crop padding (2.0×/1.5×) spans nearly the full image → teeth at Ideogram are only ~205px wide, no real zoom benefit. Switch to: crop from the full-resolution photo (not the 1024px-downscaled working image), tight 0.5×/1.0× padding, ~3:1 aspect ratio matching Ideogram's native output. Teeth now hit Ideogram at ~500px. Dramatically sharper anatomy on most cases.

Previously blocked because severe full-arch decay cases artifacted (dark ticks/blotches) at tight crop — the tight crop loses facial context that anchors "healthy smile" generation. Now routing severe damage separately (see below).

### Attempt 11 — Perioral ellipse as default with larger aperture (Fallback 1 current)
Re-applied the perioral approach to all cases but with better calibration: rx=0.85·tbW, ry=2.5·tbH (larger vertical than the failed attempt 9's 1.6), using `openSmile` prompt. This time it worked without clown-face artifacts, validated across 7 case types. The larger ry prevents the ellipse from cutting through the smile arc.

### Attempt 12 — Severe damage routing
Added tooth brightness measurement (average brightness of original tooth pixels, pre-erase). If avgBright < 90 → routes to `fullArch` Ideogram variant instead of `normalSmile`. The `normalSmile` prompt explicitly negated "wider smile, different smile width" — the wrong constraint for heavily decayed teeth. The `fullArch` prompt explicitly requests "premolars visible toward the corners" and "broad confident smile arc filling the mouth opening."

### Attempt 13 — Dark gum band fix (shipped)
After attempt 11, the Ideogram fallback composite was showing a visible dark band at the gumline. Root cause: the blend mask included the gum expansion zone (used for the edit mask), so Ideogram's slightly-darker generated gum composited over the original face. Fix: use the MP-only tooth mask for the blend mask, regardless of what the edit mask is. Result: original gum shows naturally above the generated teeth, no dark band.

### Attempt 14 — Cant correction + gingival emergence fix (shipped)
Two problems on the same patient photo (Image 21):
1. **Canted occlusal plane**: Ideogram follows the tilt of the head in the crop → generated teeth were not parallel to the interpupillary line. Fix: compute tilt angle from eye corner landmarks (indices 33, 133, 362, 263), rotate the crop canvas by `-tiltAngle` before the Ideogram call (same rotation applied to the MP mask and blend mask draws). Threshold: < 0.5° skipped (no measurable benefit at that precision).
2. **Dark at gingival emergence**: For the perioral path, Ideogram regenerates clean pink gum tissue in the full ellipse, but the blend mask only composited the tooth pixels → original (darker) gum showed above the generated teeth. Fix: expand the blend mask 12% of tbH upward for perioral cases. This brings the new gum-tooth junction into the composite, not just the crowns.

### Attempt 15 — GPT full-image + tooth composite — CURRENT PRIMARY (July 2026)
The breakthrough that closed the bitebot quality gap on normal cases and solved severe-damage routing.

**Core insight:** `gpt-image-1` running on the FULL face (not a mouth crop) produces dramatically better teeth realism AND automatic lighting integration. The full-face context gives GPT everything it needs to generate teeth that belong to the face — something the crop-zoom approach has been fighting since attempt 4.

**The catch:** GPT re-renders the entire image, beautifying/de-aging the whole face. Shipping the full GPT image would give patients a photo of a younger, prettier different person. Unacceptable.

**The architecture:** Generate with GPT, composite only the mouth back. 
- Run MediaPipe on both the original and the GPT result
- Compute an affine warp from GPT's inner-lip landmarks to the original inner-lip landmarks (GPT shifts/widens the mouth — this brings it back into registration)
- Composite ONLY the mouth region using the **OUTER lip polygon** (grown ~16% + feathered ~18% of mouth width)
- The outer-lip mask is critical: using the inner-lip mask clips GPT's gingival emergence profile and incisal edges — a dentist WILL catch this. The blend must land on perioral skin, not across the teeth.

**Cost:** ~$0.04/sim at `quality:medium` — cheaper than Ideogram's $0.08.  
**Guard:** Reject and fall through to Ideogram if affine scale <0.55 or >1.8, or mouth-center shift >12% of image width.  
**30s Worker limit:** `quality:high` exceeds the 30s Cloudflare Worker subrequest limit. Production uses `quality:medium` with a 40s AbortController → Ideogram fallback.

Validated on 11 real office photos in the harness. Shipped to production.

### Attempt 16 — Kling 2.5 Turbo Pro video upgrade (July 2026)
Video model upgraded from Seedance v1 lite (weak motion) to `fal-ai/kling-video/v2.5-turbo/pro/image-to-video`. Best-in-class human-motion smile/laugh reveals, matching bitebot's video quality tier. Validated: natural reveal→laugh, identity preserved, teeth stable. 5s ~99s / 10s ~73s (queue variance), ~$0.35 for 5s.

---

## Current Quality Assessment

### What works well (July 2026):
- **Normal/mild discoloration** — GPT full-image generates clean BL1 teeth with natural lighting integration, no pasted-on look
- **Severe missing/broken teeth** — GPT full-image solves this; the crop-zoom approach failed here because tight crop loses facial context
- **Edentulous/collapsed cases** — GPT primary + Ideogram fallback with perioral ellipse both handle these
- **Lighting harmonization** — solved by GPT full-image architecture (no separate harmonization step needed)
- **Cant correction** — crop rotation aligns occlusal plane to interpupillary line
- **Video** — Kling 2.5 Turbo Pro delivers bitebot-quality motion; pregenerated by the time patient watches

### Where we're still short of bitebot:
1. **GPT mouth drift** — GPT widens/shifts the smile during generation. The affine warp corrects this, but large shifts (>12% of image width) trigger the guard and fall to Ideogram. These are the hardest cases. A better prompt (more explicit landmark anchoring) could raise the GPT hit rate.
2. **`quality:medium` ceiling** — `quality:high` would give better anatomy detail but exceeds the 30s Cloudflare Worker limit. Currently blocked at medium unless moved to a longer-timeout backend (Modal/Vercel function).
3. **Perioral skin halo** — the outer-lip mask brings a thin ring of GPT's slightly-smoothed perioral skin. Soft, not a seam; acceptable. Could be tightened on the upper-lip/philtrum side if a patient notices.
4. **Ideogram fallback run-to-run variance** — best-of-2 reduces but doesn't eliminate bad draws (~15% rate). When GPT falls through and Ideogram runs, quality is less consistent.

### Honest ceiling assessment
The current GPT primary path is near bitebot quality on the majority of cases. The remaining gap is:
- Cases where GPT's mouth drift exceeds the alignment guard → Ideogram fallback (lower quality)
- `quality:medium` vs `high` — maybe 10–15% anatomy improvement available
- Bitebot may be running `quality:high` or a fine-tuned model — we can't see their stack

Without training data, we are at or near the ceiling of what's achievable with zero-shot GPT + composite. The path to definitively matching or beating bitebot on all cases is FLUX Kontext LoRA fine-tuning (see below).

---

## Technical Architecture Details

### Infrastructure
- **GitHub Pages** — static hosting for simulator HTML
- **Cloudflare Worker** — API proxy for all AI calls (enforces origin-locked CORS, metering, rate limiting)
- **Cloudflare R2** — storage: temp images (5-10 min TTL), media library (30-day, hosted URLs for email), consent audit log, usage counters, practice registry
- **OpenAI** — `gpt-image-1` primary via `POST /api/gpt/edit?tenant=`. Always route through this endpoint (metered). Never use the generic `/v1/images/edits` passthrough (unmetered → tenant can burn past cap).
- **Replicate** — Ideogram v2 inpaint (Fallback 1). `POST /api/ideogram/inpaint` → Worker polls every 4s
- **fal.ai** — Kling 2.5 Turbo Pro video generation. `POST /api/kling/start` → client polls `/api/kling/status` via queue
- **Resend** — transactional email (before/after to patient + dentist)

### Key Cloudflare Worker Limits
- 30-second subrequest wall clock. `gpt-image-1 quality:medium` finishes within this. `quality:high` does not — observed timeout at exactly 300s client-side. Ideogram takes 20–90s → Worker cannot wait for it. Solution: Worker starts the Replicate prediction, returns prediction ID, browser polls `/api/replicate/status?id=X` every 4s directly. Same pattern for all long-running jobs.
- All AI calls are effectively async from the browser's perspective.

### MediaPipe Integration
- Loaded from CDN via `@mediapipe/tasks-vision` npm package baked into a script tag
- Uses the face_landmarker task (468 landmarks)
- Runs fully client-side — face landmarks never leave the browser
- Returns INNER_LIP polygon (indices 78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191) → drawn to canvas → white-on-black mask PNG
- OUTER_LIP polygon is used for the GPT composite mask
- Eye corner landmarks (33, 133, 362, 263) used for tilt angle in the Ideogram fallback
- Critical: headless Chromium cannot run this (no WebGL). For server-side automation, use Python `mediapipe` with `harness/landmarks.py`

### Ideogram v2 Specifics (Fallback 1)
- Model on Replicate: `ideogram-ai/ideogram-v2`
- Mask convention: **BLACK = edit zone, WHITE = preserve zone** (opposite of FLUX/SDXL)
- Output aspect ratio: always ~3:1 regardless of input. A 5:1 input comes back 3:1 with letterboxing → keep crop AR near 3:1 to avoid double-resampling quality loss
- Generation time: 20–90s (queue-dependent)
- Cost: ~$0.08/image, $0.16/run with best-of-2

### Prompt Variants (worker.js)
| Variant | Used for | Key difference |
|---|---|---|
| `openSmile` | All cases (perioral path, Fallback 1 default) | Full perioral zone, open parted lips, no "preserve width" constraint |
| `fullArch` | Severe decay (avgBright <90) | Full arch corner-to-corner, drops "same width" constraint |
| `perioralSmile` | Edentulous/collapsed | Perioral zone regeneration, lip support |
| `GPT_LOCK_PROMPT` | GPT primary | Hard identity-lock — explicit anchor of face, skin, eyes, hair |

---

## Local Development

```bash
# Test harness (runs worker proxy + serves harness.html)
node harness/server.mjs   # port 8788

# Harness URL params:
# photo=X.jpg             test photo from test-photos/ (gitignored)
# mode=baseline           original production path
# mode=hires              tight-crop high-res path (now production)
# mode=gpt                GPT full-image + composite path

# Harness Python scripts (run after first GPT generation, which is cached):
python harness/gpt_fullface.py <photo>    # generates full GPT image, caches
python harness/gpt_composite.py <photo>  # composites cached GPT → original

# MediaPipe in harness (headless Chromium can't run it):
python harness/landmarks.py <photo>   # outputs JSON landmarks to stdout
```

Harness caches all intermediates to `test-outputs/<photo>/`. First run costs ~$0.04 via Worker proxy (GPT) or ~$0.08 (Ideogram, spoofed Origin header). All subsequent iterations are free — reuses cached generation output.

Patient test photos go in `test-photos/` — gitignored (repo is public).

---

## Path Forward: Without Training Data

These improvements are achievable with the current zero-shot stack:

### 1. `quality:high` GPT in production (1–3 days)
Move the GPT call to a longer-timeout backend — Modal serverless function or Vercel edge function with a 120s timeout. Estimated +10–15% anatomy detail. This is the highest-value single improvement available without training data.

### 2. Better GPT alignment — fewer fallbacks to Ideogram (2–4 hours)
Cases where GPT's mouth drift exceeds the 12% width guard fall to Ideogram (lower quality). A more explicit prompt may reduce drift. Also: the affine guard threshold could be tuned — maybe 15% is acceptable on large-mouth shifts while still giving good dental anatomy.

### 3. Artifact detection + Ideogram auto-retry (3–5 hours)
`scoreToothGeneration()` already runs on both best-of-2 draws. Add a minimum acceptable score threshold — if both draws score below it, run a third draw. Catches the ~15% of fallback runs that produce slabs or partial arches.

### 4. Perioral skin halo reduction (2–4 hours)
The outer-lip mask brings a thin ring of GPT's smoother perioral skin. Asymmetric feathering — tighter on the upper lip/philtrum, still generous at the incisal edge — would reduce this while keeping the dental anatomy intact.

### 5. FLUX Kontext as alternative primary (exploratory, 1–2 days)
FLUX Dev Kontext takes a reference image and transforms it via instruction-following. No mask needed — describe "replace the teeth with BL1 veneers, keep everything else." Quality unknown for this use case. Worth a proof-of-concept run on the harness.

---

## Path Forward: With Training Data (Closes the Bitebot Gap Definitively)

This is the path to truly matching or beating bitebot on all cases, including the hardest ones.

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
4. Add `fluxKontextMakeover()` as new primary, move GPT composite to Fallback 1
5. Keep current pipeline as fallback for cases the trained model mishandles

**Cost estimate:** FLUX Kontext LoRA training on Replicate ~$30–80 for 100 pairs/2000 steps. Inference ~$0.06/image. Should outperform current pipeline at both quality and cost.

---

## Known Hard Constraints

| Constraint | Why It Matters |
|---|---|
| Cloudflare Worker 30s limit | All AI calls must be async (start job → return ID → browser polls). `gpt-image-1 quality:high` exceeds this — use medium in Worker, or move to longer-timeout backend. |
| Ideogram mask is BLACK=edit | Opposite of FLUX/SDXL. Getting this backwards silently edits the face and preserves the teeth. |
| GPT is NOT an inpainter | A mask does not constrain `gpt-image-1` — it re-renders the entire image anyway. Identity preservation requires compositing the mouth back onto the original face. |
| Outer-lip mask is mandatory for GPT composite | Inner-lip mask clips gingival emergence and incisal edges. A dentist will notice. Blend must land on perioral skin. |
| MediaPipe requires WebGL | Can't run in headless Chromium. Use Python mediapipe for server-side automation. |
| Tooth erase is mandatory for Ideogram | Without erasing existing teeth to dark, Ideogram generates a featureless slab (even BL1 teeth fail this). |
| Ideogram output is always ~3:1 AR | Input an unusual AR → Ideogram pads/crops and returns 3:1. Keep input near 3:1 or pay a sharpness penalty from double resampling. |
| GPT `/v1/images/edits` passthrough is UNMETERED | Always route production GPT sims through `POST /api/gpt/edit?tenant=`. The generic passthrough skips metering — tenants can burn past quota. |
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
│   ├── gpt_fullface.py     # GPT full-image generation + caching
│   ├── gpt_composite.py    # Composite cached GPT onto original
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

**If the goal is maximizing quality with the current zero-shot stack (3–5 days):**
1. `quality:high` GPT via longer-timeout backend (Modal/Vercel) — highest single improvement
2. Ideogram artifact detection + auto-retry (score threshold)
3. Better GPT alignment prompt to reduce fallthrough rate
4. Perioral skin halo reduction (asymmetric feathering)

**If training data is available (3–4 weeks total):**
1. Curate + license 50+ pairs from Dr. D's archive
2. Fine-tune FLUX Kontext LoRA on Replicate
3. A/B test against current GPT pipeline on standard case set
4. If validated: replace primary path, keep GPT composite as fallback
5. Pairs-trained model should close the remaining bitebot gap on all case types

---

*Document updated July 2026. Check COLD_START.md before touching the pipeline — many of these lessons were learned the hard way. §3.13–3.15 cover the July 2026 changes.*
