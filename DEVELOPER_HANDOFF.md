# Hallmark Smile Simulator — Developer Handoff

**Repo:** https://github.com/drdonelson/hallmark-smile  
**Live app:** https://drdonelson.github.io/hallmark-smile/smile-simulator.html  
**Goal:** Match the quality of [bitebot.io](https://bitebot.io) — pixel-precise tooth whitening/reshaping that looks like a real cosmetic dentistry "after" photo.

---

## What's Built

### Frontend — `smile-simulator.html` (GitHub Pages)
Single-page app. User uploads a photo, it runs through an AI pipeline and shows a before/after.

### Backend — `worker.js` (Cloudflare Worker)
Proxy that hides API keys and handles CORS. Routes:
- `POST /api/sam/start` — SAM2 image segmentation (fal.ai)
- `POST /api/flux/inpaint` — FLUX Pro Fill inpainting (fal.ai)
- `GET  /api/kling/status?falUrl=...` — fal.ai queue polling proxy
- `POST /api/runpod/generate` — ComfyUI on RunPod
- `GET  /api/runpod/status?jobId=...` — RunPod polling

### Deploy
- Worker auto-deploys to Cloudflare via GitHub Actions on push to `main` (`.github/workflows/deploy-worker.yml`)
- Frontend is static GitHub Pages, updates on push automatically
- Secrets needed in GitHub repo: `CLOUDFLARE_API_TOKEN`

### API Keys (in Cloudflare Worker env vars)
- `FAL_API_KEY` — fal.ai (SAM2 + FLUX Pro Fill)
- `RUNPOD_API_KEY` — RunPod (ComfyUI fallback)

---

## Current Pipeline (in order)

```
1. PRIMARY:   SAM2 segmentation → FLUX Pro Fill on mouth crop → composite back
2. FALLBACK1: FLUX Pro Fill on full image with brightness-based mask
3. FALLBACK2: RunPod ComfyUI (dreamshaper_8Inpainting, 120s timeout)
4. FALLBACK3: Client-side HSL whitening (last resort, barely visible)
```

### What's working
- FLUX Pro Fill (fal.ai `fal-ai/flux-pro/v1/fill`) runs successfully and produces visible whitening **when the mask is accurate**
- fal.ai queue polling pattern is solid (`status_url` → poll → fetch `response_url`)
- RunPod ComfyUI fallback works (slow but functional)
- GitHub Actions auto-deploy is wired up

### What's broken / not working well

#### 1. SAM2 upload keeps failing (the critical bug)
`handleSAMStart` in `worker.js` needs to give SAM2 an HTTP URL for the image — SAM2 doesn't reliably accept data URIs. We've tried:
- Cloudflare KV storage → `env.TEMP_IMAGES` was undefined (KV binding not in `wrangler.toml`)
- fal.ai multipart upload → wrong format, no `url` in response
- fal.ai raw binary upload → still 502ing

**What needs to happen:** Get a working image URL into `handleSAMStart`. Options:
- Add KV namespace to `wrangler.toml` and Cloudflare dashboard, then restore the KV approach (was working before CI deploy broke it)
- Use fal.ai's correct file upload endpoint — check their [JS client source](https://github.com/fal-ai/fal-js) for the exact format
- Upload to any public URL (S3, R2, etc.) with a short TTL

When SAM2 works, it returns `{ masks: ["https://v3.fal.media/files/...mask.png"] }` — a URL to a white-on-black PNG mask of exactly the tooth pixels.

#### 2. Brightness mask fails on stained/yellow teeth
`buildToothMask()` in `smile-simulator.html` (line ~1272) uses pixel brightness to detect teeth. It requires `cutoff/255 >= 0.42`. Stained or yellow teeth often fall below this threshold — the mask returns only ~628 pixels (vs ~3000+ for bright teeth), which is too small for FLUX to make a visible change.

This is the core quality bottleneck. SAM2 solves it completely — it detects tooth shape regardless of color.

#### 3. FLUX changes are too subtle for stained teeth
Even with a correct mask, FLUX Pro Fill at `guidance_scale: 18` doesn't always overcome heavy staining. The model balances prompt vs surrounding context — yellow teeth surrounding pixels pull the output back toward yellow.

---

## What's Needed to Reach bitebot.io Quality

### Step 1 — Fix SAM2 (highest leverage, ~2–4 hours)
Get `handleSAMStart` working. Once SAM2 delivers a pixel-precise tooth mask:
- Crop to mouth zone, scale up 2x, run FLUX on the crop, composite back
- This gives FLUX 4x the effective tooth resolution
- Works on stained/yellow/dark teeth regardless of brightness

See `runSAM2()` and `compositeResult()` in `smile-simulator.html` — the pipeline is fully wired, the only broken piece is the image URL into SAM2.

### Step 2 — Tune FLUX prompt + strength for stained teeth (~2–4 hours)
Once SAM2 mask is working on the crop:
- Test whether `guidance_scale: 18–20` produces visible whitening
- Consider a pre-brightening pass: HSL-boost the teeth pixels +30% lightness in the crop before sending to FLUX, so FLUX only needs to add texture/realism rather than overcome the full stain delta
- Prompt is in `worker.js` `handleFluxInpaint` — currently says "shade A1 bright white" and negates "yellow teeth, stained teeth"

### Step 3 — Replace FLUX with a dental fine-tuned model (bitebot-level quality, ~1–2 weeks)
FLUX Pro Fill is a general inpainting model. bitebot.io-level results require either:
- A LoRA fine-tuned on dental before/after pairs, loaded on top of FLUX or SDXL
- A dedicated dental inpainting model (there are a few on HuggingFace/CivitAI)
- An API that specializes in smile design (Remini has a "teeth" filter, but no API)

The crop+composite architecture from Step 1 is already designed for this — swap the FLUX call for any model that accepts image + mask.

---

## Key Files

| File | Purpose |
|------|---------|
| `smile-simulator.html` | Entire frontend — upload, pipeline, UI |
| `worker.js` | Cloudflare Worker proxy — all API calls go through here |
| `wrangler.toml` | Worker config — **missing KV binding, add it here** |
| `.github/workflows/deploy-worker.yml` | Auto-deploy on push |
| `Dockerfile` + `comfyui/` | RunPod ComfyUI container (secondary fallback) |

## Key Functions in `smile-simulator.html`

| Function | Line | What it does |
|----------|------|-------------|
| `generateSmile()` | ~1590 | Main pipeline orchestrator |
| `getMouthCropBox()` | ~1502 | Returns mouth zone crop coordinates |
| `cropToBox()` | ~1512 | Crops + scales image to 1024px wide |
| `runSAM2()` | ~1524 | Calls SAM2, polls, returns mask URL |
| `compositeResult()` | ~1552 | Blends FLUX crop back onto original |
| `buildToothMask()` | ~1272 | Brightness-based tooth detection (limited) |
| `pollFal()` | ~1252 | Polls fal.ai queue until COMPLETED |

## Key Functions in `worker.js`

| Function | Line | What it does |
|----------|------|-------------|
| `handleSAMStart()` | ~244 | **Broken** — needs working image URL for SAM2 |
| `handleFluxInpaint()` | ~314 | FLUX Pro Fill — accepts image+mask as data URI or URL |

---

## Quick Test Photos
- **Works OK:** Bright white or naturally light teeth — brightness mask finds enough pixels
- **Fails:** Yellow/stained teeth — brightness mask gets <1000px, FLUX change invisible

Send both types when testing any fix.
