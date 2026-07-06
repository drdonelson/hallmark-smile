// Smile Simulator - Cloudflare Worker
// Secrets needed: OPENAI_API_KEY, FAL_API_KEY
// Add both in Worker Settings > Variables > Secrets

const ALLOWED_ORIGINS = new Set([
  'https://drdonelson.github.io',
  'https://hallmarkdds.com',
  'https://www.hallmarkdds.com',
  'https://lucidroi.com',
  'https://www.lucidroi.com',
  'https://app.lucidroi.com',
  'https://sevenbridgesdentalstudio.com',
  'https://www.sevenbridgesdentalstudio.com',
]);

const OPENAI_BASE    = 'https://api.openai.com';
const RUNWAY_BASE    = 'https://api.dev.runwayml.com/v1';
const RUNWAY_VERSION = '2024-11-06';
const FAL_BASE       = 'https://queue.fal.run';
// Kling 2.5 Turbo Pro: cinematic image-to-video with best-in-class human
// motion fluidity (ideal for a natural smile/laugh reveal) — the quality tier
// to match/beat competitors on Veo/Kling. Runs on fal's queue (submit returns
// immediately, the client polls kling/status), so generation time is a UX wait,
// not a Worker-timeout concern. Input aspect ratio is taken from the image.
// Schema: { prompt, image_url, duration:'5'|'10', negative_prompt, cfg_scale }.
const KLING_MODEL    = 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video';
const KLING_DURATION = '5';   // 5s = $0.35, +$0.07/s. 10s for a longer reveal.

// CORS headers added to every response
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age':       '86400',
  };
}

async function getAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  // Check dynamic registry for practice websites added via /api/onboard
  try {
    const domain = origin.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
    const key = `origins/${domain.replace(/[^a-z0-9.-]/gi, '_')}.json`;
    const rec = await env.TEMP_IMAGES.get(key);
    if (rec) return origin;
  } catch { /* fail closed */ }
  return null;
}

// --- Runway: Start video generation ---
async function handleVideoStart(request, env, origin) {
  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  const { image } = body;
  if (!image) {
    return new Response(JSON.stringify({ error: 'Missing image field' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  const promptText =
    'person laughing with genuine delight and mouthing the words "I can\'t believe this", ' +
    'mouth opens wide showing upper and lower teeth moving naturally, tongue briefly visible, ' +
    'jaw drops and rises with natural speech movement, lips articulate the words fluidly, ' +
    'surprised and overjoyed expression, cheeks lifted, eyes wide with happy disbelief, ' +
    'natural head movement, photorealistic human face, soft studio lighting';

  let runway;
  try {
    runway = await fetch(`${RUNWAY_BASE}/image_to_video`, {
      method: 'POST',
      headers: {
        'Authorization':    `Bearer ${env.RUNWAY_API_KEY}`,
        'X-Runway-Version': RUNWAY_VERSION,
        'Content-Type':     'application/json',
      },
      body: JSON.stringify({
        model:       'gen4_turbo',
        promptImage: image,
        promptText,
        ratio:       '720:1280',
        duration:    5,
      }),
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  const data = await runway.json();
  return new Response(JSON.stringify(data), {
    status:  runway.status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// --- Kling (fal.ai): Start video generation ---
async function handleKlingStart(request, env, origin) {
  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  const { image } = body;
  if (!image) {
    return new Response(JSON.stringify({ error: 'Missing image field' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  const blockedVid = await meter(env, request, tenantOf(body), 'videos', origin);
  if (blockedVid) return blockedVid;

  // Video line is configurable per request (?videoLine=); defaults to "this is amazing".
  // Short phrases read clearer on the lips since Seedance is visual-only (no audio).
  const line = (body.videoLine || 'this is amazing').replace(/["\\]/g, '');
  // Style presets — the patient can pick the vibe of the shareable clip.
  const STYLE_PROMPTS = {
    laugh:
      'The person turns their head slightly to show off their new smile, then faces the camera. ' +
      `Looking at the camera with a delighted, surprised expression, they clearly mouth the words "${line}" ` +
      'with deliberate, natural lip and jaw movement, then break into a big warm genuine laugh — ' +
      'head tilting back a little, cheeks lifting, eyes crinkling with joy, shoulders relaxing. ' +
      'Broad bright smile showing their new teeth the whole time. Joyful, confident, celebratory energy, ' +
      'natural blinking, photorealistic human face, soft studio lighting, camera static.',
    reveal:
      'The person looks down briefly, then lifts their head to face the camera and slowly breaks into a ' +
      'confident, radiant closed-then-open smile, showing off their new teeth. Subtle, elegant, self-assured — ' +
      'a gentle head tilt, calm steady eye contact, a small satisfied nod. Photorealistic human face, ' +
      'soft flattering studio lighting, minimal head movement, camera static.',
    talk:
      'The person faces the camera and speaks naturally as if telling a friend about their new smile, ' +
      `warmly mouthing the words "${line}" with clear, relaxed lip and jaw movement and expressive eyebrows, ` +
      'finishing with a bright confident smile showing their new teeth. Friendly, conversational, genuine energy, ' +
      'natural blinking and small head movements, photorealistic human face, soft studio lighting, camera static.',
  };
  const style = STYLE_PROMPTS[body.style] ? body.style : 'laugh';
  const prompt = STYLE_PROMPTS[style];

  let fal;
  try {
    fal = await fetch(`${FAL_BASE}/${KLING_MODEL}`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${env.FAL_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        prompt,
        image_url:       image,
        duration:        (body.duration === '10' ? '10' : KLING_DURATION),
        negative_prompt: 'blur, distortion, low quality, deformed or extra teeth, ' +
          'changing tooth color, morphing face, identity change, warping, flicker, artifacts',
        cfg_scale:       0.5,
      }),
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  const text = await fal.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text }; }

  return new Response(JSON.stringify(data), {
    status:  fal.status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// --- Kling (fal.ai): Poll status + fetch result ---
// Proxies any fal.ai URL directly — uses status_url from the start response
async function handleKlingStatus(request, env, origin) {
  try {
    if (!env.FAL_API_KEY) {
      return new Response(JSON.stringify({ error: 'FAL_API_KEY secret not configured' }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
    const url     = new URL(request.url);
    const falUrl  = url.searchParams.get('falUrl');

    if (!falUrl) {
      return new Response(JSON.stringify({ error: 'Missing falUrl param' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    const fal = await fetch(decodeURIComponent(falUrl), {
      headers: { 'Authorization': `Key ${env.FAL_API_KEY}` },
    });

    const text = await fal.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text }; }

    return new Response(JSON.stringify(data), {
      status:  fal.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, type: err.name, detail: String(err) }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
}

// --- Runway: Poll video task status ---
async function handleVideoStatus(request, env, origin) {
  const url    = new URL(request.url);
  const taskId = url.searchParams.get('taskId');

  if (!taskId) {
    return new Response(JSON.stringify({ error: 'Missing taskId param' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  let runway;
  try {
    runway = await fetch(`${RUNWAY_BASE}/tasks/${taskId}`, {
      headers: {
        'Authorization':    `Bearer ${env.RUNWAY_API_KEY}`,
        'X-Runway-Version': RUNWAY_VERSION,
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  const data = await runway.json();
  return new Response(JSON.stringify(data), {
    status:  runway.status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// --- Image proxy: fetch external URL with our CORS headers ---
// Needed so the browser can call getImageData() on SAM mask images (canvas CORS policy)
async function handleProxyImage(request, env, origin) {
  const url      = new URL(request.url);
  const imageUrl = decodeURIComponent(url.searchParams.get('url') || '');

  // Only allow fal.ai / Google Cloud Storage URLs (where SAM masks live)
  const allowed = ['https://fal.ai/', 'https://v3.fal.media/', 'https://storage.googleapis.com/', 'https://fal.run/'];
  if (!imageUrl || !allowed.some(p => imageUrl.startsWith(p))) {
    return new Response('Forbidden', { status: 403, headers: corsHeaders(origin) });
  }

  try {
    const res  = await fetch(imageUrl);
    const data = await res.arrayBuffer();
    return new Response(data, {
      headers: {
        'Content-Type':  res.headers.get('Content-Type') || 'image/png',
        'Cache-Control': 'public, max-age=3600',
        ...corsHeaders(origin),
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
}

// --- SAM: Segment teeth pixels from image ---
// Sends data URI directly to SAM2 (no storage upload needed — fal accepts data URIs).
// Returns the queue envelope {status_url, response_url} for the client to poll.
async function handleSAMStart(request, env, origin) {
  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  const { image, width, height, boxPrompt, pointPrompt } = body;
  if (!image || !width || !height) {
    return new Response(JSON.stringify({ error: 'Missing image, width or height' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  // Store image in R2 and serve it via this worker so SAM2 can fetch it by URL
  let imageUrl;
  try {
    const [meta, b64] = image.split(',');
    const mimeType = (meta.match(/:(.*?);/) || [])[1] || 'image/png';
    const bytes    = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const imgId    = crypto.randomUUID();
    await env.TEMP_IMAGES.put(imgId, bytes, {
      httpMetadata: { contentType: mimeType },
      customMetadata: { expires: String(Date.now() + 300_000) },
    });
    const workerHost = 'quiet-forest-e1f8.david-d73.workers.dev';
    imageUrl = `https://${workerHost}/api/img/${imgId}`;
  } catch (err) {
    return new Response(JSON.stringify({ error: `R2 store failed: ${err.message}` }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  // Allow caller to supply box/point prompts (used for crop-relative coordinates).
  // Default: teeth box at horizontal center 25–75%, vertical 61–82% of full face.
  const [bx1, by1, bx2, by2] = boxPrompt || [
    Math.round(width * 0.25), Math.round(height * 0.61),
    Math.round(width * 0.75), Math.round(height * 0.82),
  ];
  const [px, py] = pointPrompt || [Math.round(width * 0.50), Math.round(height * 0.69)];

  try {
    const samRes = await fetch('https://queue.fal.run/fal-ai/sam2/image', {
      method:  'POST',
      headers: {
        'Authorization': `Key ${env.FAL_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        image_url:             imageUrl,
        box_prompts:           [[bx1, by1, bx2, by2]],
        point_prompts:         [[px, py, 1]],
        return_multiple_masks: false,
      }),
    });
    const text = await samRes.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text }; }
    return new Response(JSON.stringify(data), {
      status:  samRes.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
}

// --- fal.ai: FLUX Pro Fill inpainting ---
// Uploads image + mask to fal.ai storage (no KV needed), then calls FLUX fill.
async function handleFluxInpaint(request, env, origin) {
  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  const { image, mask, mask_url, width, height } = body;
  if (!image || (!mask && !mask_url) || !width || !height) {
    return new Response(JSON.stringify({ error: 'Missing image, mask (or mask_url), width, or height' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  // mask_url (fal.ai hosted URL) takes priority over mask (data URI)
  const imageUrl = image;
  const maskUrl  = mask_url || mask;

  const prompt = 'Cosmetic dental makeover photo. Every upper tooth is individually distinct: visible dark inter-dental embrasures between each tooth, natural gingival scalloping at each tooth\'s emergence profile. Central incisors widest, lateral incisors narrower, canines tapering. Ovoid tooth shape. Smooth incisal edges with subtle translucency at tips. Tooth color: bright natural white, BL1 shade, clean white enamel — not yellow, not ivory, not stained. Realistic enamel surface: fine horizontal texture ridges, natural micro-variation, slight gloss highlights. Broad smile arc filling buccal corridors. Correct midline alignment. Healthy pink gingival margins. Photorealistic cosmetic dentistry case photo — individual tooth crowns clearly visible, not a single white block.';

  const negative_prompt = 'tongue, tongue visible, pink mouth interior, open throat, uvula, denture plate, false teeth, uniform white slab, fused teeth, missing embrasures, plastic texture, artificial glow, flat brightness, AI artifacts, altered lips, altered skin, altered face, face reshaping, Hollywood glow, cartoon teeth, blue teeth, blue tint, cyan teeth, teal teeth, cool color cast, neon white, blue-white, yellow teeth, yellow tint, amber teeth, stained teeth, ivory teeth, warm yellow';

  try {
    const fal = await fetch('https://queue.fal.run/fal-ai/flux-pro/v1/fill', {
      method:  'POST',
      headers: { 'Authorization': `Key ${env.FAL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url:           imageUrl,
        mask_url:            maskUrl,
        prompt,
        negative_prompt,
        num_inference_steps: 40,
        guidance_scale:      12,
        output_format:       'jpeg',
        sync_mode:           false,
      }),
    });
    const text = await fal.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text }; }
    return new Response(JSON.stringify(data), {
      status: fal.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
}

// ComfyUI workflow sent with every RunPod job (5.x requires it in the request)
const COMFY_WORKFLOW = {
  "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "dreamshaper_8Inpainting.inpainting.safetensors" } },
  "2": { "class_type": "CLIPTextEncode", "inputs": { "text": "professional dental photo, perfect Hollywood smile, BL1 porcelain veneers, brilliant white teeth, perfectly aligned teeth, full broad smile, natural healthy pink gumline, photorealistic, 8k uhd, sharp focus, studio lighting", "clip": ["1", 1] } },
  "3": { "class_type": "CLIPTextEncode", "inputs": { "text": "yellow teeth, stained teeth, crooked teeth, missing teeth, gaps, dark teeth, bad teeth, decay, cartoon, painting, illustration, deformed, distorted, blurry, low quality", "clip": ["1", 1] } },
  "4": { "class_type": "LoadImage", "inputs": { "image": "photo.png", "upload": "image" } },
  "5": { "class_type": "LoadImage", "inputs": { "image": "mask.png", "upload": "image" } },
  "6": { "class_type": "ImageToMask", "inputs": { "image": ["5", 0], "channel": "red" } },
  "7": { "class_type": "VAEEncodeForInpaint", "inputs": { "pixels": ["4", 0], "vae": ["1", 2], "mask": ["6", 0], "grow_mask_by": 12 } },
  "8": { "class_type": "KSampler", "inputs": { "model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["7", 0], "seed": 0, "control_after_generate": "randomize", "steps": 15, "cfg": 8.0, "sampler_name": "dpmpp_2m", "scheduler": "karras", "denoise": 1.0 } },
  "9": { "class_type": "VAEDecode", "inputs": { "samples": ["8", 0], "vae": ["1", 2] } },
  "10": { "class_type": "SaveImage", "inputs": { "images": ["9", 0], "filename_prefix": "dental_result" } }
};

// --- RunPod: ComfyUI dental workflow ---
// Expects { image: "base64...", mask: "base64..." }
// Formats for runpod/worker-comfyui which accepts { images: [{name, image}] }
async function handleRunpodGenerate(request, env, origin) {
  const endpointId = env.RUNPOD_ENDPOINT_ID;
  if (!endpointId) {
    return new Response(JSON.stringify({ error: 'RUNPOD_ENDPOINT_ID secret not configured' }), {
      status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  const { image, mask } = body;
  if (!image || !mask) {
    return new Response(JSON.stringify({ error: 'Missing image or mask' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  // Strip data URI prefix — runpod/worker-comfyui expects raw base64
  const stripPrefix = d => d.includes(',') ? d.split(',')[1] : d;
  try {
    const rp = await fetch(`https://api.runpod.ai/v2/${endpointId}/run`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RUNPOD_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: {
          workflow: COMFY_WORKFLOW,
          images: [
            { name: 'photo.png', image: stripPrefix(image) },
            { name: 'mask.png',  image: stripPrefix(mask)  },
          ],
        },
      }),
    });
    const text = await rp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text }; }
    return new Response(JSON.stringify(data), {
      status: rp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
}

async function handleRunpodStatus(request, env, origin) {
  const endpointId = env.RUNPOD_ENDPOINT_ID;
  if (!endpointId) {
    return new Response(JSON.stringify({ error: 'RUNPOD_ENDPOINT_ID secret not configured' }), {
      status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  const url   = new URL(request.url);
  const jobId = url.searchParams.get('jobId');
  if (!jobId) {
    return new Response(JSON.stringify({ error: 'Missing jobId' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  try {
    const rp = await fetch(`https://api.runpod.ai/v2/${endpointId}/status/${jobId}`, {
      headers: { 'Authorization': `Bearer ${env.RUNPOD_API_KEY}` },
    });
    const text = await rp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text }; }
    return new Response(JSON.stringify(data), {
      status: rp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
}

// --- Modal: Dental LoRA inpainting (synchronous, no polling) ---
const MODAL_DENTAL_URL = 'https://drdonelson--dental-lora-dentalmodel-inpaint.modal.run';

async function handleModalInpaint(request, env, origin) {
  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  const { image, mask } = body;
  if (!image || !mask) {
    return new Response(JSON.stringify({ error: 'Missing image or mask' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  try {
    const res  = await fetch(MODAL_DENTAL_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ image, mask }),
    });
    const data = await res.json();
    return new Response(JSON.stringify(data), {
      status:  res.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
}

// --- Replicate: Ideogram v2 Inpainting ---
// Mask convention: black=edit (teeth), white=preserve (face). Opposite of FLUX.
async function handleIdeogramInpaint(request, env, origin) {
  if (!env.REPLICATE_API_TOKEN) {
    return new Response(JSON.stringify({ error: 'REPLICATE_API_TOKEN not configured' }), {
      status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  const { image, mask, variant, shade } = body;
  if (!image || !mask) {
    return new Response(JSON.stringify({ error: 'Missing image or mask' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  const blocked = await meter(env, request, tenantOf(body), 'sims', origin);
  if (blocked) return blocked;
  let imageUrl, maskUrl;
  try {
    [imageUrl, maskUrl] = await Promise.all([r2Upload(env, image), r2Upload(env, mask)]);
  } catch (err) {
    return new Response(JSON.stringify({ error: 'R2 upload failed: ' + err.message }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  let prompt = 'Photorealistic cosmetic dental result. Upper teeth: BL1 bright natural white, individually defined with visible dark inter-dental shadows and embrasures between each tooth. Golden proportion widths — central incisors widest, lateral incisors slightly narrower, canines tapered. Ovoid tooth shape. Smooth incisal edges with subtle translucency. Realistic enamel surface texture and slight gloss. Smooth bright pink healthy gingiva visible above the teeth with no dark gum border — gum tissue transitions naturally into the upper lip. Correct midline. Lips, face, and smile width exactly as in original photo. Clinical dental photography.';
  let negative_prompt = 'yellow teeth, stained teeth, discolored teeth, denture plate, uniform white slab, fused teeth, no embrasures, plastic texture, artificial glow, cartoon, altered lips, altered skin, altered face, wider smile, different smile width, more teeth showing, different mouth opening, tongue, open throat, dark gum line, dark shadow above teeth, dark band above teeth, dark gum border, dark marks at gum line, dark gingival marks, black line above teeth';
  if (variant === 'openSmile') {
    // Aperture-opening variant — bitebot's move: don't cram teeth into the
    // existing lip gap (which clips them short); OPEN the smile so a full-height
    // ideal arch can be inlaid. Explicitly demands full tooth height + gum.
    prompt = 'Photorealistic broad open confident smile after a complete smile makeover. The lips are parted into a generous wide smile that OPENS to frame a full arch of teeth — revealing the FULL HEIGHT of each upper tooth from the gum line down to the incisal edge, with healthy bright pink gingiva smoothly emerging above each crown with no dark border. Teeth: BL1 bright natural white, individually defined with dark inter-dental embrasures, golden proportion (central incisors widest, laterals narrower, canines tapered), premolars filling toward each corner, ovoid shapes, subtle incisal translucency. The occlusal plane is level and horizontal, parallel to the interpupillary line — no cant, no tilt. The teeth are NOT clipped or cut off by the lips — the smile opens to show them completely. Upper lip lifts naturally; lip color, skin, eyes, nose, and hair exactly as the original person. Clinical dental photography, natural lighting.';
    negative_prompt = 'teeth cut off, clipped teeth, short teeth, half teeth, teeth hidden behind lip, lip covering teeth, narrow smile, closed mouth, tiny teeth, uniform white slab, fused teeth, no embrasures, dark buccal corners, dark empty corners, metallic sheen, pearl glare, glossy plastic, altered skin, altered nose, altered eyes, different person, lipstick, tongue, open throat, dark gum line, dark band above teeth, black line above teeth, dark gingival margin, dark emergence, black gum border, canted smile, tilted occlusal plane, asymmetric smile plane';
  } else if (variant === 'perioralSmile') {
    // Perioral hybrid (edentulous prototype): the edit mask includes the LIPS,
    // letting the model repaint a parted, lip-supported broad smile — bitebot's
    // effect without regenerating the whole face.
    prompt = 'Photorealistic broad natural smile after complete full-arch dental restoration. Lips gently parted in a wide confident smile revealing a complete upper arch of teeth: BL1 bright natural white, individually defined with dark inter-dental embrasures, golden proportion, natural dark buccal corridor at each corner, subtle incisal translucency, healthy pink gingiva. The lips keep the same shape, color, fullness, and texture as the original person, now naturally supported by the new teeth. Skin, stubble, chin, and everything outside the lips exactly as in the original photo. Clinical dental photography.';
    negative_prompt = 'closed mouth, narrow smile, tiny teeth, uniform white slab, fused teeth, no embrasures, metallic sheen, pearl glare, glossy plastic, different skin, different chin, added beard, added mustache, lipstick, altered nose, cartoon, tongue, open throat';
  } else if (variant === 'normalSmile') {
    // Standard veneer/makeover case using perioral ellipse — teeth + gum + lips
    // regenerated as one unit so there is no gum-tooth seam.
    prompt = 'Photorealistic cosmetic veneer result. The same person now smiling confidently: upper teeth BL1 bright natural white, each tooth individually defined with dark inter-dental embrasures, golden proportion (central incisors widest, lateral incisors narrower, canines tapered). Smooth bright pink healthy gingiva above the teeth — no dark gum border. Lips natural and relaxed, supported by the new smile. Same face, same eyes, same skin, same hair. Clinical dental photography.';
    negative_prompt = 'yellow teeth, stained teeth, discolored teeth, denture plate, uniform white slab, fused teeth, no embrasures, plastic texture, artificial glow, cartoon, altered face, altered nose, altered eyes, different person, tongue, open throat, dark gum line, dark shadow above teeth, dark gum border, dark band above teeth, dark gingival marks, black line above teeth';
  } else if (variant === 'fullArch') {
    // Severe damage / full-arch restoration cases. The normalSmile prompt forbids
    // "wider smile" — exactly wrong when existing teeth are heavily damaged/decayed.
    // This prompt expects a broad transformation: full arch, all visible teeth, natural integration.
    prompt = 'Photorealistic cosmetic dental result showing complete smile transformation. Full upper arch of bright natural white teeth BL1 shade, every tooth individually defined with dark inter-dental embrasures and shadows between each crown. Golden proportion — central incisors widest, lateral incisors slightly narrower, canines tapered, first premolars visible toward each corner with natural dark buccal corridor shadow. Ovoid tooth shapes, smooth incisal edges with subtle enamel translucency, realistic fine texture, soft gloss. Healthy pink gingiva scalloping naturally above each crown, no dark gum border. Broad confident smile arc filling the mouth opening from corner to corner. The person\'s face, lips, skin, eyes, and hair are exactly as in the original photo — only the teeth change. Clinical dental photography, natural lighting.';
    negative_prompt = 'yellow teeth, stained teeth, discolored teeth, brown teeth, decayed teeth, missing teeth, black spots, uniform white slab, fused teeth, no embrasures, single sliver of teeth, tiny narrow smile, only front teeth, four teeth, partial arch, dark empty corners, metallic sheen, pearl glare, glossy plastic, artificial glow, cartoon, altered skin, altered face, altered lips, altered nose, different person, tongue, open throat, dark gum line, dark shadow above teeth, dark band above teeth';
  }
  // Hollywood Bright shade: replace natural white language with ultra-bright
  if (shade === 'hollywood') {
    prompt = prompt
      .replace('BL1 bright natural white', 'ultra-bright Hollywood white, brilliant dazzling enamel, maximum whiteness BL1+')
      .replace('bright natural white, BL1 shade', 'ultra-bright Hollywood white, brilliant dazzling enamel, maximum whiteness BL1+');
    negative_prompt += ', dull teeth, off-white, ivory, natural shade, warm white, subtle white';
  }
  try {
    const rep = await fetch('https://api.replicate.com/v1/models/ideogram-ai/ideogram-v2/predictions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.REPLICATE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: {
          image:                imageUrl,
          mask:                 maskUrl,
          prompt,
          negative_prompt,
          style_type:           'Realistic',
          magic_prompt_option:  'Off',
        },
      }),
    });
    const data = await rep.json();
    if (!rep.ok) {
      return new Response(JSON.stringify({ error: data.detail || 'Ideogram error', detail: data }), {
        status: rep.status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
    return new Response(JSON.stringify({ id: data.id, status: data.status }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
}

// --- Replicate: SDXL Inpainting (lucataco/sdxl-inpainting) ---
// Uploads image + mask to R2, submits to Replicate, returns prediction ID for polling.
const REPLICATE_SDXL_VERSION = 'a5b13068cc81a89a4fbeefeccc774869fcb34df4dbc92c1555e0f2771d49dde7';
// Set DENTAL_MODEL_VERSION in Worker secrets after deploying the dental LoRA to Replicate.
// Format: "username/model-name:version-hash"  e.g. "drdonelson/dental-inpaint:abc123..."
// When unset, /api/dental/inpaint falls back to the generic SDXL inpainting model.
const WORKER_HOST = 'quiet-forest-e1f8.david-d73.workers.dev';

// ── Usage metering ──────────────────────────────────────────────
// R2-backed counters (reuses the TEMP_IMAGES bucket — no new infra).
// Counts are best-effort (concurrent increments may rarely lose one);
// the goal is cost protection and per-tenant accounting, not billing-
// grade precision. 'sims' are counted in API CALLS — best-of-2 means
// 2 calls per patient simulation, so caps are 2× the intended run count.
// Built-in tenants (caps only; login via DASH_PASSWORDS). Onboarded practices
// live in the R2 registry instead — email+password, self-serve settings, and
// super-admin reset/delete. Seven Bridges was migrated to an onboarded account.
const TENANTS = {
  hallmark:     { sims: 2000, videos: 100 },   // ≈1000 simulations/mo
  lucid:        { sims: 1000, videos: 50 },    // ≈500 simulations/mo
  unknown:      { sims: 200,  videos: 10 },    // direct opens / unrecognized embeds
};
const IP_DAILY = { sims: 30, videos: 6, shares: 12 };  // per-visitor abuse stop (≈15 sims/day)

// Agency (Lucid) gets BCC'd on every lead + result for delivery management,
// regardless of which practice/CRM the lead belongs to. Move to the practice
// registry later if per-agency routing is ever needed.
const AGENCY_EMAIL = 'ritesh@affordabledentistmarketing.com';

async function registryGet(env, slug) {
  try {
    const obj = await env.TEMP_IMAGES.get(`registry/${slug}.json`);
    return obj ? await obj.json() : null;
  } catch { return null; }
}

function tenantOf(body) {
  const t = ((body && body.tenant) || '').toLowerCase();
  return (TENANTS[t] || t) ? t : 'unknown';
}

// Returns caps for a tenant — checks static TENANTS first, then R2 registry.
async function tenantCaps(env, slug) {
  if (TENANTS[slug]) return TENANTS[slug];
  const rec = await registryGet(env, slug);
  return rec ? { sims: rec.sims || 500, videos: rec.videos || 25 } : TENANTS.unknown;
}

// ── White-label config ──────────────────────────────────────────
// Per-practice config lives on the registry record (rec.config). The
// simulator fetches the public projection via GET /api/config; the dashboard
// reads/writes the full object via /api/dashboard/settings. Every field here
// is public-safe by design — no secrets (password/hash/email live as sibling
// keys on the record and are never returned by /api/config).
const KNOWN_TENANT_NAMES = {
  hallmark: 'Hallmark Dental',
  lucid: 'Lucid ROI',
  sevenbridges: 'Seven Bridges Dental Studio',
};
function prettyTenant(slug) {
  return KNOWN_TENANT_NAMES[slug] || (slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : 'Your Practice');
}
function defaultConfig(rec = {}) {
  const name = rec.name || prettyTenant(rec.slug || '');
  return {
    branding: {
      name,
      tagline: 'AI Smile Simulator',
      showName: true,       // header practice-name show/hide toggle
      showTagline: true,    // header tagline show/hide toggle
      logoUrl: '',
      poweredByLabel: 'Powered by Lucid',
      colors: {},   // empty → simulator uses its built-in default palette
    },
    booking: { url: '', ctaLabel: 'Book Your Free Consultation', ctaFallback: 'lead-capture' },
    // Where to send the patient after they finish (post-result). Blank = stay.
    thankYouUrl: '',
    // Floating popup / CTA widget (cta-widget.js) customization. ctaUrl overrides
    // where the popup opens (blank = the practice's own simulator URL).
    widget: { heading: 'Ready for a New Smile?', sub: 'See your smile makeover in seconds — free, no obligation.', avatarUrl: '', theme: 'hallmark', ctaUrl: '' },
    leads: { notifyEmails: rec.leadEmail ? [rec.leadEmail] : [] },
    treatments: [
      { id: 'veneers',   label: 'Veneers',              enabled: true },
      { id: 'implants',  label: 'Dental Implants',      enabled: true },
      { id: 'whitening', label: 'Teeth Whitening',      enabled: true },
      { id: 'makeover',  label: 'Full Smile Makeover',  enabled: true },
      { id: 'unsure',    label: 'Not Sure Yet',         enabled: true },
    ],
    shades: [
      { id: 'natural',   label: 'Natural White',    desc: 'Subtle, realistic enhancement that looks naturally beautiful' },
      { id: 'hollywood', label: 'Hollywood Bright', desc: 'Brilliant, ultra-white smile for maximum impact' },
    ],
    qualification: [],   // [{ q, options:[...], disqualifyValues:[...], disqualifyMsg, bookUrl }]
    legal: { companyName: 'Lucid ROI', supportEmail: 'support@lucidroi.com', legalBaseUrl: '' },
    locale: 'en',
    video: { styles: ['laugh'] },
    // Future monetization (option 3) slots in here without a schema change.
    plan: { type: 'caps', simsCap: rec.sims || 1000, videosCap: rec.videos || 50 },
  };
}
// Clamp incoming config to the known shape/sizes so a compromised or buggy
// client cannot bloat the record. Unknown top-level keys are dropped.
function sanitizeConfig(input, rec = {}) {
  const d = defaultConfig(rec);
  const c = (input && typeof input === 'object') ? input : {};
  const str = (v, max, fb) => (typeof v === 'string' ? v.slice(0, max) : fb);
  const b = c.branding || {};
  const colors = {};
  if (b.colors && typeof b.colors === 'object') {
    for (const k of Object.keys(d.branding.colors).concat(
      ['navy','navyDark','navyMid','navyLight','gold','goldLight','goldDark','goldGlow','goldRgb','offWhite','lightGrey'])) {
      if (typeof b.colors[k] === 'string') colors[k] = b.colors[k].slice(0, 40);
    }
  }
  const bk = c.booking || {};
  const lg = c.legal || {};
  const leadEmails = Array.isArray(c.leads?.notifyEmails)
    ? c.leads.notifyEmails.filter(e => typeof e === 'string' && e.includes('@')).slice(0, 10).map(e => e.slice(0, 120))
    : d.leads.notifyEmails;
  const treatments = Array.isArray(c.treatments)
    ? c.treatments.slice(0, 12).map(t => ({ id: str(t.id, 24, 'opt'), label: str(t.label, 60, 'Option'), enabled: t.enabled !== false }))
    : d.treatments;
  const shades = Array.isArray(c.shades)
    ? c.shades.slice(0, 6).map(s => ({ id: str(s.id, 24, 'shade'), label: str(s.label, 60, 'Shade'), desc: str(s.desc, 160, '') }))
    : d.shades;
  const qualification = Array.isArray(c.qualification)
    ? c.qualification.slice(0, 6).map(q => ({
        q: str(q.q, 200, ''),
        options: Array.isArray(q.options) ? q.options.slice(0, 8).map(o => str(o, 80, '')) : [],
        disqualifyValues: Array.isArray(q.disqualifyValues) ? q.disqualifyValues.slice(0, 8).map(o => str(o, 80, '')) : [],
        disqualifyMsg: str(q.disqualifyMsg, 300, ''),
        bookUrl: str(q.bookUrl, 300, ''),
      })).filter(q => q.q)
    : [];
  const styles = Array.isArray(c.video?.styles) ? c.video.styles.slice(0, 6).map(s => str(s, 24, 'laugh')) : d.video.styles;
  const w = c.widget || {};
  return {
    branding: {
      name: str(b.name, 80, d.branding.name),
      tagline: str(b.tagline, 80, d.branding.tagline),
      showName: b.showName !== false,
      showTagline: b.showTagline !== false,
      logoUrl: str(b.logoUrl, 300, ''),
      poweredByLabel: str(b.poweredByLabel, 60, d.branding.poweredByLabel),
      colors,
    },
    booking: {
      url: str(bk.url, 400, ''),
      ctaLabel: str(bk.ctaLabel, 60, d.booking.ctaLabel),
      ctaFallback: (bk.ctaFallback === 'hidden') ? 'hidden' : 'lead-capture',
    },
    thankYouUrl: str(c.thankYouUrl, 400, ''),
    widget: {
      heading:   str(w.heading, 80, d.widget.heading),
      sub:       str(w.sub, 160, d.widget.sub),
      avatarUrl: str(w.avatarUrl, 300, ''),
      theme:     str(w.theme, 24, d.widget.theme),
      ctaUrl:    str(w.ctaUrl, 400, ''),
    },
    leads: { notifyEmails: leadEmails },
    treatments,
    shades,
    qualification,
    legal: {
      companyName: str(lg.companyName, 80, d.legal.companyName),
      supportEmail: str(lg.supportEmail, 120, d.legal.supportEmail),
      legalBaseUrl: str(lg.legalBaseUrl, 200, ''),
    },
    locale: (['en','fr','es'].includes(c.locale) ? c.locale : 'en'),
    video: { styles },
    plan: d.plan,
  };
}
function publicConfig(env, slug, rec) {
  const name = rec?.name || prettyTenant(slug);
  const config = (rec && rec.config) ? rec.config : defaultConfig(rec || { slug, name });
  return { slug, name, config };
}

// ── Password hashing (PBKDF2-SHA256, salted) ────────────────────
// Replaces the legacy plaintext registry password. Login migrates legacy
// records transparently on first successful sign-in.
function _hex(buf) { return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join(''); }
function _unhex(h) { return Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16))); }
async function hashPassword(password, saltHex) {
  const salt = saltHex ? _unhex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, km, 256);
  return { hash: _hex(bits), salt: _hex(salt) };
}
async function verifyPassword(password, saltHex, hashHex) {
  if (!saltHex || !hashHex || typeof password !== 'string') return false;
  const { hash } = await hashPassword(password, saltHex);
  if (hash.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}
function emailKey(email) { return String(email || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '_'); }
async function usageRead(env, key) {
  try {
    const o = await env.TEMP_IMAGES.get(key);
    return o ? await o.json() : { sims: 0, videos: 0 };
  } catch { return { sims: 0, videos: 0 }; }
}
// Returns null when allowed (and records the use), or a 429 Response.
async function meter(env, request, tenant, kind, origin) {
  try {
    const now = new Date().toISOString();
    const tKey  = `usage/${tenant}/${now.slice(0, 7)}.json`;
    const ipKey = `usage/ip/${now.slice(0, 10)}/${request.headers.get('CF-Connecting-IP') || 'noip'}.json`;
    const [tUse, ipUse, caps] = await Promise.all([usageRead(env, tKey), usageRead(env, ipKey), tenantCaps(env, tenant)]);
    const tCap = caps[kind];   // may be undefined (e.g. 'shares' is IP-only)
    if (tCap != null && (tUse[kind] || 0) >= tCap) {
      return new Response(JSON.stringify({ error: 'This site has reached its monthly simulation limit. Please contact the practice.' }), {
        status: 429, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
    if (IP_DAILY[kind] != null && (ipUse[kind] || 0) >= IP_DAILY[kind]) {
      return new Response(JSON.stringify({ error: 'Daily limit reached for this device. Please try again tomorrow.' }), {
        status: 429, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
    tUse[kind] = (tUse[kind] || 0) + 1; ipUse[kind] = (ipUse[kind] || 0) + 1;
    await Promise.all([
      env.TEMP_IMAGES.put(tKey, JSON.stringify(tUse)),
      env.TEMP_IMAGES.put(ipKey, JSON.stringify(ipUse)),
    ]);
    return null;
  } catch (e) {
    return null;   // fail-open: metering must never take the product down
  }
}
async function handleUsage(request, env, origin) {
  const url = new URL(request.url);
  const tenant = (url.searchParams.get('tenant') || '').toLowerCase();
  const isRegistered = TENANTS[tenant] || await registryGet(env, tenant);
  if (!tenant || !isRegistered) {
    return new Response(JSON.stringify({ error: 'Unknown tenant', tenants: Object.keys(TENANTS) }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  const caps = await tenantCaps(env, tenant);
  const month = new Date().toISOString().slice(0, 7);
  const use = await usageRead(env, `usage/${tenant}/${month}.json`);
  return new Response(JSON.stringify({ tenant, month, used: use, caps }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

async function r2Upload(env, dataUrl) {
  const [header, b64] = dataUrl.split(',');
  const mimeType = header.match(/:(.*?);/)?.[1] || 'image/png';
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const imgId = crypto.randomUUID();
  await env.TEMP_IMAGES.put(imgId, bytes, {
    httpMetadata: { contentType: mimeType },
    customMetadata: { expires: String(Date.now() + 600_000) },
  });
  return `https://${WORKER_HOST}/api/img/${imgId}`;
}

async function handleReplicateInpaint(request, env, origin) {
  if (!env.REPLICATE_API_TOKEN) {
    return new Response(JSON.stringify({ error: 'REPLICATE_API_TOKEN not configured in Worker secrets' }), {
      status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  const { image, mask, width, height } = body;
  if (!image || !mask || !width || !height) {
    return new Response(JSON.stringify({ error: 'Missing image, mask, width, or height' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  let imageUrl, maskUrl;
  try {
    [imageUrl, maskUrl] = await Promise.all([r2Upload(env, image), r2Upload(env, mask)]);
  } catch (err) {
    return new Response(JSON.stringify({ error: 'R2 upload failed: ' + err.message }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  const prompt = 'Photorealistic cosmetic dental result photo. Upper teeth whitened to shade BL1 bright natural white. Same smile width and natural mouth shape as original — do not widen smile or add extra teeth. Central incisors dominant width, lateral incisors slightly narrower, canines tapered — golden proportion. Individual tooth edges clearly defined with natural inter-dental shadows. Realistic enamel surface texture with subtle micro-variation and translucency at incisal edges. Healthy pink gingival margins intact. Midline centered. Clinical macro dental photography, authentic cosmetic dentistry result.';
  const negative_prompt = 'yellow teeth, stained teeth, discolored teeth, flat uniform white blob, no tooth detail, all teeth same width, plastic texture, denture, fake teeth, wider smile than original, extra teeth, dark buccal corridor, black corners of mouth, shadow at mouth corners, AI artifacts, altered lips, altered skin, altered face, tilted teeth, canted smile, wrong proportions, cartoon, painting, blurry';

  try {
    const rep = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.REPLICATE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: REPLICATE_SDXL_VERSION,
        input: {
          image:           imageUrl,
          mask:            maskUrl,
          prompt,
          negative_prompt,
          guidance_scale:  9.0,
          strength:        0.85,
          steps:           30,
          scheduler:       'K_EULER',
          num_outputs:     1,
        },
      }),
    });
    const data = await rep.json();
    if (!rep.ok) {
      return new Response(JSON.stringify({ error: data.detail || 'Replicate error', detail: data }), {
        status: rep.status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
    return new Response(JSON.stringify({ id: data.id, status: data.status }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
}

async function handleReplicateStatus(request, env, origin) {
  if (!env.REPLICATE_API_TOKEN) {
    return new Response(JSON.stringify({ error: 'REPLICATE_API_TOKEN not configured' }), {
      status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  const url = new URL(request.url);
  const id  = url.searchParams.get('id');
  if (!id) {
    return new Response(JSON.stringify({ error: 'Missing id param' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  try {
    const rep = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
      headers: { 'Authorization': `Bearer ${env.REPLICATE_API_TOKEN}` },
    });
    const data = await rep.json();
    return new Response(JSON.stringify(data), {
      status: rep.status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
}

async function handleDentalInpaint(request, env, origin) {
  if (!env.REPLICATE_API_TOKEN) {
    return new Response(JSON.stringify({ error: 'REPLICATE_API_TOKEN not configured' }), {
      status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  const { image, mask, width, height } = body;
  if (!image || !mask || !width || !height) {
    return new Response(JSON.stringify({ error: 'Missing image, mask, width, or height' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  let imageUrl, maskUrl;
  try {
    [imageUrl, maskUrl] = await Promise.all([r2Upload(env, image), r2Upload(env, mask)]);
  } catch (err) {
    return new Response(JSON.stringify({ error: 'R2 upload failed: ' + err.message }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  const prompt = 'Cosmetic dental makeover photo. Every upper tooth is individually distinct: visible dark inter-dental embrasures between each tooth, natural gingival scalloping at each tooth\'s emergence profile, slight shade variation — central incisors brightest, lateral incisors slightly warmer, canines slightly darker. Central incisors widest, lateral incisors narrower, canines tapering. Ovoid tooth shape. Smooth incisal edges with subtle blue-white translucency at tips. Realistic enamel surface: fine horizontal texture ridges, natural micro-variation, slight gloss highlights. Broad smile arc filling buccal corridors. Correct midline alignment. Healthy pink gingival margins. Photorealistic cosmetic dentistry case photo — individual tooth crowns clearly visible, not a single white block.';
  const negative_prompt = 'tongue, tongue visible, pink mouth interior, open throat, uvula, denture plate, false teeth, uniform white slab, fused teeth, missing embrasures, plastic texture, artificial glow, flat brightness, AI artifacts, altered lips, altered skin, altered face, face reshaping, Hollywood glow, over-whitening, cartoon teeth';

  // Use the trained dental LoRA model if available, otherwise fall back to generic SDXL
  const dentalVersion = env.DENTAL_MODEL_VERSION;
  const replicateBody = dentalVersion
    ? { version: dentalVersion, input: { image: imageUrl, mask: maskUrl, prompt, negative_prompt, steps: 30, guidance_scale: 8.5, strength: 0.88 } }
    : { version: REPLICATE_SDXL_VERSION, input: { image: imageUrl, mask: maskUrl, prompt, negative_prompt, guidance_scale: 9.0, strength: 0.85, steps: 30, scheduler: 'K_EULER', num_outputs: 1 } };

  try {
    const rep = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.REPLICATE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(replicateBody),
    });
    const data = await rep.json();
    if (!rep.ok) {
      return new Response(JSON.stringify({ error: data.detail || 'Replicate error', detail: data }), {
        status: rep.status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
    return new Response(JSON.stringify({ id: data.id, status: data.status, model: dentalVersion ? 'dental-lora' : 'sdxl-generic' }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
}

// --- Temp image serve: fal.ai fetches from here (no origin check needed) ---
async function handleTempImage(request, env, imgId) {
  try {
    const obj = await env.TEMP_IMAGES.get(imgId);
    if (!obj) return new Response('Not Found', { status: 404 });
    const mimeType = obj.httpMetadata?.contentType || 'image/png';
    return new Response(obj.body, {
      headers: { 'Content-Type': mimeType, 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return new Response('Error', { status: 500 });
  }
}

// ── Media library (R2) ──────────────────────────────────────────
// Persistent, access-controlled storage for results the patient asked us to
// email/host. Distinct from the minutes-long processing relay (r2Upload):
// these live under the `media/` prefix with a non-guessable token key and a
// configurable retention (default 30 days). Storage is abstracted here so the
// backend can later be swapped to a BAA-covered store (e.g. AWS S3) without
// touching callers — see COMPLIANCE.md.
const MEDIA_TTL_DAYS = 30;
function randomToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}
// Accepts a data URL, stores bytes, returns { id, url, contentType }.
async function storeMedia(env, dataUrl, ttlDays = MEDIA_TTL_DAYS) {
  const [header, b64] = dataUrl.split(',');
  const contentType = header.match(/:(.*?);/)?.[1] || 'image/jpeg';
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const id = randomToken();
  await env.TEMP_IMAGES.put(`media/${id}`, bytes, {
    httpMetadata: { contentType, cacheControl: 'private, max-age=86400' },
    customMetadata: { expires: String(Date.now() + ttlDays * 86400_000) },
  });
  return { id, url: `https://${WORKER_HOST}/api/m/${id}`, contentType };
}
// Serve hosted media by opaque token; enforces retention (deletes if expired).
async function handleStoredMedia(env, id) {
  try {
    const obj = await env.TEMP_IMAGES.get(`media/${id}`);
    if (!obj) return new Response('Not Found', { status: 404 });
    const exp = Number(obj.customMetadata?.expires || 0);
    if (exp && Date.now() > exp) {
      await env.TEMP_IMAGES.delete(`media/${id}`).catch(() => {});
      return new Response('Expired', { status: 410 });
    }
    return new Response(obj.body, {
      headers: {
        'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
        'Cache-Control': 'private, max-age=86400',
        'X-Robots-Tag': 'noindex',
        // The opaque token is the access control; any origin can already
        // render this via <img>. ACAO lets the dashboard fetch it as a blob
        // for the download button.
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch { return new Response('Error', { status: 500 }); }
}

// ── Consent audit log ───────────────────────────────────────────
// Append-only-style record (one object per consent) for defensibility.
async function logConsent(env, rec) {
  try {
    const id = randomToken();
    const day = new Date().toISOString().slice(0, 10);
    await env.TEMP_IMAGES.put(`consent/${day}/${id}.json`, JSON.stringify(rec), {
      customMetadata: { expires: String(Date.now() + 365 * 86400_000) },  // keep 1yr
    });
    return id;
  } catch { return null; }
}
async function handleConsent(request, env, origin) {
  let body; try { body = await request.json(); } catch { body = {}; }
  const id = await logConsent(env, {
    ts: new Date().toISOString(),
    ip: request.headers.get('CF-Connecting-IP') || null,
    tenant: tenantOf(body),
    version: body.version || 'v1',
    scope: body.scope || null,         // e.g. ['ai_processing','email_share']
    practice: body.practice || null,
    patientEmail: body.patientEmail || null,
  });
  return new Response(JSON.stringify({ ok: true, id }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// ── Share: email the before/after to patient and/or dentist ─────
// POST { beforeImage, afterImage, videoUrl?, patientEmail?, patientName?,
//        dentistEmail?, practice?, tenant?, consent: true }
// Gated on explicit consent. Stores images in the media library (30d) and
// emails hosted https links + inline preview with the SIMULATION label.
async function handleShare(request, env, origin) {
  if (!env.RESEND_API_KEY) {
    return new Response(JSON.stringify({ error: 'Email not configured' }), {
      status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  let body; try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  if (body.consent !== true) {
    return new Response(JSON.stringify({ error: 'Consent required to share results.' }), {
      status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  const limited = await meter(env, request, tenantOf(body), 'shares', origin);
  if (limited) return limited;

  const {
    beforeImage, afterImage, videoUrl,
    patientEmail = '', patientName = '',
    dentistEmail = 'david@hallmarkdds.com', practice = 'Hallmark Dental',
  } = body;
  if (!afterImage) {
    return new Response(JSON.stringify({ error: 'Missing afterImage' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  // Persist to the media library (hosted https links survive the email).
  let beforeUrl = null, afterUrl = null;
  try {
    if (beforeImage) beforeUrl = (await storeMedia(env, beforeImage)).url;
    afterUrl = (await storeMedia(env, afterImage)).url;
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Storage failed: ' + e.message }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  await logConsent(env, {
    ts: new Date().toISOString(), ip: request.headers.get('CF-Connecting-IP') || null,
    tenant: tenantOf(body), version: body.version || 'v1',
    scope: ['ai_processing', 'email_share'], practice, patientEmail: patientEmail || null,
    action: 'share', afterId: afterUrl,
  });

  // Enrich the dashboard lead record with the media URLs.
  if (body.leadId) {
    await updateLead(env, tenantOf(body), body.leadId, { beforeUrl, afterUrl, videoUrl: videoUrl || null }).catch(() => {});
  }

  // Per-practice legal branding (falls back to the Lucid operator defaults).
  const rec = await registryGet(env, tenantOf(body));
  const legalCfg = (rec && rec.config && rec.config.legal) || {};
  const LEGAL = (legalCfg.legalBaseUrl || 'https://app.lucidroi.com/legal').replace(/\/$/, '');
  const label = `<div style="margin:14px 0 4px;font:600 12px sans-serif;letter-spacing:.04em;color:#8a6d12;background:#fff8e6;border:1px solid #e3c659;border-radius:6px;padding:8px 11px;display:inline-block">AI SIMULATION &mdash; NOT A CLINICAL OUTCOME</div>`;
  const baBlock = `
    <table style="border-collapse:collapse"><tr>
      ${beforeUrl ? `<td style="padding:6px;text-align:center"><img src="${beforeUrl}" alt="Before" width="240" style="border-radius:10px;display:block"><div style="font:600 12px sans-serif;color:#6b7a90;margin-top:6px">BEFORE</div></td>` : ''}
      <td style="padding:6px;text-align:center"><img src="${afterUrl}" alt="After — AI simulation" width="240" style="border-radius:10px;display:block"><div style="font:600 12px sans-serif;color:#1B3A5C;margin-top:6px">AFTER (simulation)</div></td>
    </tr></table>
    ${videoUrl ? `<p style="font:14px sans-serif"><a href="${videoUrl}">&#9658; View the shareable video</a></p>` : ''}
    ${label}
    <p style="font:12px sans-serif;color:#6b7a90;margin-top:14px">This AI visualization is for cosmetic education only and is not a medical diagnosis, treatment plan, or guarantee. Individual results vary by anatomy and clinician technique. See the <a href="${LEGAL}/disclaimer.html">Disclaimer</a> &amp; <a href="${LEGAL}/privacy.html">Privacy Policy</a>. Links expire in ${MEDIA_TTL_DAYS} days.</p>`;

  const sends = [];
  if (patientEmail) {
    sends.push(fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Smile Simulator <leads@lucidroi.com>',
        to: [patientEmail],
        subject: `Your smile preview from ${practice}`,
        html: `<h2 style="font-family:Georgia,serif;color:#1B3A5C">${patientName ? patientName + ', here' : 'Here'}'s your smile preview</h2>
          <p style="font:15px sans-serif;color:#36465c">Thanks for trying the smile simulator. Here is your before/after &mdash; share it with ${practice} at your consultation.</p>
          ${baBlock}`,
      }),
    }).catch(() => null));
  }
  // Always notify the dentist for review/evaluation.
  sends.push(fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Smile Simulator <leads@lucidroi.com>',
      to: [dentistEmail],
      bcc: [AGENCY_EMAIL],
      subject: `Smile simulation for review${patientName ? ' — ' + patientName : ''}`,
      html: `<h2 style="font-family:Georgia,serif;color:#1B3A5C">Smile simulation for review</h2>
        <p style="font:14px sans-serif;color:#36465c"><strong>Practice:</strong> ${practice}${patientName ? `<br><strong>Patient:</strong> ${patientName}` : ''}${patientEmail ? `<br><strong>Patient email:</strong> ${patientEmail}` : ''}</p>
        ${baBlock}`,
    }),
  }).catch(() => null));

  await Promise.all(sends);
  return new Response(JSON.stringify({ ok: true, beforeUrl, afterUrl }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// ── Central lead store (R2) ─────────────────────────────────────
// One object per lead at leads/<tenant>/<id>.json so the dashboard can list
// per practice. 180-day retention. Created on /api/lead, enriched with media
// URLs on /api/share, status advanced from the dashboard.
async function saveLead(env, tenant, id, rec) {
  await env.TEMP_IMAGES.put(`leads/${tenant}/${id}.json`, JSON.stringify(rec), {
    customMetadata: { expires: String(Date.now() + 180 * 86400_000) },
  });
}
async function updateLead(env, tenant, id, patch) {
  const key = `leads/${tenant}/${id}.json`;
  const obj = await env.TEMP_IMAGES.get(key);
  const rec = obj ? await obj.json() : { id, tenant, ts: new Date().toISOString(), status: 'new' };
  Object.assign(rec, patch, { updatedAt: new Date().toISOString() });
  await env.TEMP_IMAGES.put(key, JSON.stringify(rec), {
    customMetadata: { expires: String(Date.now() + 180 * 86400_000) },
  });
}

// ── Dashboard auth (HMAC-signed token; password → tenant) ───────
async function dashSign(env, payload) {
  const body = btoa(JSON.stringify(payload)).replace(/=+$/, '');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.DASH_SECRET || ''),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const s = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return body + '.' + s;
}
async function dashVerify(env, token) {
  if (!token || !env.DASH_SECRET) return null;
  const [body, s] = token.split('.');
  if (!body || !s) return null;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.DASH_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sigBytes = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const ok = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(body));
    if (!ok) return null;
    const payload = JSON.parse(atob(body));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}
function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}
// Login: resolves a tenant, then verifies the password against a salted PBKDF2
// hash on the registry record. Legacy plaintext records are migrated on first
// successful sign-in. env.DASH_PASSWORDS (JSON map slug→password) still backs
// the "admin" all-tenant login and any static tenants without a registry hash.
// Accepts { password, tenant? , email? } — tenant OR email resolves the record.
async function handleDashLogin(request, env, origin) {
  let body; try { body = await request.json(); } catch { body = {}; }
  const password = typeof body.password === 'string' ? body.password : '';
  const j401 = () => new Response(JSON.stringify({ error: 'Incorrect email or password' }), {
    status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
  // Fail loudly if the signing secret is missing. Without it dashSign issues a
  // token the same worker can't verify, so every authenticated call 401s and
  // the dashboard bounces straight back to login — indistinguishable from a
  // wrong password. A clear 503 makes that misconfiguration debuggable.
  if (!env.DASH_SECRET) {
    return new Response(JSON.stringify({ error: 'Dashboard auth is not configured (DASH_SECRET missing). Set it with: wrangler secret put DASH_SECRET' }), {
      status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  // 1) Static/admin logins from the env password map (exact match).
  //    - 'admin'  → super-admin, scope '*' (all practices, token management)
  //    - 'ritesh' → admin, scope '*' (all practices, token management)
  //    - any other slug → that practice's client login
  let pwmap = {}; try { pwmap = JSON.parse(env.DASH_PASSWORDS || '{}'); } catch {}
  for (const [slug, pw] of Object.entries(pwmap)) {
    if (pw && password && password === pw) {
      const isSuper = slug === 'admin';
      const isAdmin = isSuper || slug === 'ritesh';
      const t = isAdmin ? '*' : slug;
      const role = isSuper ? 'superadmin' : (isAdmin ? 'admin' : 'client');
      const token = await dashSign(env, { t, role, exp: Date.now() + 12 * 3600_000 });
      return new Response(JSON.stringify({ token, scope: t, role }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
  }

  // 2) Resolve a registry tenant by explicit slug, or by email index.
  let slug = (body.tenant || '').toLowerCase();
  if (!slug && body.email) {
    try {
      const idx = await env.TEMP_IMAGES.get(`emailidx/${emailKey(body.email)}.json`);
      if (idx) slug = (await idx.json()).slug;
    } catch { /* no index */ }
  }
  if (!slug || !password) return j401();

  const rec = await registryGet(env, slug);
  if (!rec) return j401();

  let ok = false;
  if (rec.passwordHash) {
    ok = await verifyPassword(password, rec.passwordSalt, rec.passwordHash);
  } else if (rec.password) {
    // Legacy plaintext record — verify then migrate to a salted hash and
    // backfill the email index so email-based login works afterward.
    ok = (password === rec.password);
    if (ok) {
      const { hash, salt } = await hashPassword(password);
      rec.passwordHash = hash; rec.passwordSalt = salt; delete rec.password;
      if (!rec.email && rec.leadEmail) rec.email = String(rec.leadEmail).toLowerCase().trim();
      await env.TEMP_IMAGES.put(`registry/${slug}.json`, JSON.stringify(rec),
        { httpMetadata: { contentType: 'application/json' } }).catch(() => {});
      if (rec.email) {
        await env.TEMP_IMAGES.put(`emailidx/${emailKey(rec.email)}.json`, JSON.stringify({ slug }),
          { httpMetadata: { contentType: 'application/json' } }).catch(() => {});
      }
    }
  }
  if (!ok) return j401();

  // role: 'client' scopes to this practice only. Admin/super-admin roles are
  // issued by the DASH_PASSWORDS path above ('admin'/'ritesh') with scope '*'.
  const token = await dashSign(env, { t: slug, role: 'client', exp: Date.now() + 12 * 3600_000 });
  return new Response(JSON.stringify({ token, scope: slug, role: 'client' }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// Resolve the tenant a dashboard token may act on. Admin scope ('*') must name
// a tenant explicitly (query ?tenant= or body.tenant); others are pinned.
function scopeTenant(payload, request, body) {
  if (payload.t !== '*') return payload.t;
  const fromBody = body && typeof body.tenant === 'string' ? body.tenant : '';
  const fromQuery = new URL(request.url).searchParams.get('tenant') || '';
  return (fromBody || fromQuery).toLowerCase();
}
// Role helpers. Legacy tokens (issued before roles) have no `role`: infer from
// scope so existing sessions keep working — '*' ⇒ admin-class, else client.
function roleOf(payload) {
  if (payload && payload.role) return payload.role;
  return (payload && payload.t === '*') ? 'admin' : 'client';
}
function isAdmin(payload) { const r = roleOf(payload); return r === 'admin' || r === 'superadmin'; }
function isSuperAdmin(payload) { return roleOf(payload) === 'superadmin'; }

// GET /api/dashboard/practices — admin+ only. Lists every registered practice
// (slug, name, email, caps) so admins can manage ANY practice, not just those
// that already have leads.
async function handleDashPractices(request, env, origin) {
  const payload = await dashVerify(env, bearer(request));
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
  if (!payload) return json({ error: 'Unauthorized' }, 401);
  if (!isAdmin(payload)) return json({ error: 'Forbidden' }, 403);
  const out = [];
  // Static tenants that may not have a registry record yet.
  for (const slug of Object.keys(TENANTS)) {
    if (slug === 'unknown') continue;
    out.push({ slug, name: prettyTenant(slug), caps: TENANTS[slug], static: true });
  }
  try {
    const list = await env.TEMP_IMAGES.list({ prefix: 'registry/', limit: 1000 });
    const recs = await Promise.all(list.objects.map(o =>
      env.TEMP_IMAGES.get(o.key).then(r => r && r.json()).catch(() => null)));
    for (const rec of recs.filter(Boolean)) {
      const i = out.findIndex(p => p.slug === rec.slug);
      const entry = { slug: rec.slug, name: rec.name || prettyTenant(rec.slug), email: rec.email || rec.leadEmail || null,
        caps: { sims: rec.sims || 1000, videos: rec.videos || 50 }, static: false };
      if (i >= 0) out[i] = entry; else out.push(entry);
    }
  } catch { /* return what we have */ }
  out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return json({ practices: out });
}

// POST /api/dashboard/practice/delete — SUPER-ADMIN only (destructive).
// Removes a practice's registry record + its email index. Leads/media are left
// under retention. Ritesh-tier admins are intentionally blocked here.
async function handleDashPracticeDelete(request, env, origin) {
  const payload = await dashVerify(env, bearer(request));
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
  if (!payload) return json({ error: 'Unauthorized' }, 401);
  if (!isSuperAdmin(payload)) return json({ error: 'Only the super-admin can delete practices' }, 403);
  let body; try { body = await request.json(); } catch { body = {}; }
  const slug = (body.tenant || '').toLowerCase();
  if (!slug || TENANTS[slug]) return json({ error: 'Cannot delete this tenant' }, 400);
  const rec = await registryGet(env, slug);
  if (rec && rec.email) await env.TEMP_IMAGES.delete(`emailidx/${emailKey(rec.email)}.json`).catch(() => {});
  await env.TEMP_IMAGES.delete(`registry/${slug}.json`).catch(() => {});
  return json({ ok: true });
}

// POST /api/dashboard/practice/reset-password — SUPER-ADMIN only.
// Sets a new dashboard password for a client practice (auto-generated unless a
// custom one is supplied). Stores only the salted hash, refreshes the email
// index, and emails the practice the new credentials. Returns the plaintext
// once so the super-admin can relay it too.
async function handleDashResetPassword(request, env, origin) {
  const payload = await dashVerify(env, bearer(request));
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
  if (!payload) return json({ error: 'Unauthorized' }, 401);
  if (!isSuperAdmin(payload)) return json({ error: 'Only the super-admin can reset passwords' }, 403);
  let body; try { body = await request.json(); } catch { body = {}; }
  const slug = (body.tenant || '').toLowerCase();
  if (!slug || TENANTS[slug]) return json({ error: 'Pick a practice account (built-in tenants use DASH_PASSWORDS)' }, 400);
  const rec = await registryGet(env, slug);
  if (!rec) return json({ error: 'Practice not found' }, 404);

  // Custom password (min 8 chars) or auto-generate a 12-char one.
  let password = (typeof body.newPassword === 'string' && body.newPassword.trim().length >= 8)
    ? body.newPassword.trim() : null;
  if (!password) {
    const b = crypto.getRandomValues(new Uint8Array(9));
    password = Array.from(b, x => x.toString(36).padStart(2, '0')).join('').slice(0, 12);
  }
  const { hash, salt } = await hashPassword(password);
  rec.passwordHash = hash; rec.passwordSalt = salt; delete rec.password;
  if (!rec.email && rec.leadEmail) rec.email = String(rec.leadEmail).toLowerCase().trim();
  await env.TEMP_IMAGES.put(`registry/${slug}.json`, JSON.stringify(rec),
    { httpMetadata: { contentType: 'application/json' } });
  if (rec.email) {
    await env.TEMP_IMAGES.put(`emailidx/${emailKey(rec.email)}.json`, JSON.stringify({ slug }),
      { httpMetadata: { contentType: 'application/json' } }).catch(() => {});
  }

  let emailed = false;
  if (env.RESEND_API_KEY && rec.email) {
    try {
      const dashUrl = `https://drdonelson.github.io/hallmark-smile/dashboard.html?t=${slug}&email=${encodeURIComponent(rec.email)}`;
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Lucid ROI <onboarding@lucidroi.com>', to: [rec.email],
          subject: `Your dashboard password was reset — ${rec.name || slug}`,
          html: `<div style="font-family:sans-serif;color:#0A1628">
            <p>Your Smile Simulator dashboard password has been reset.</p>
            <p><strong>Sign in with</strong><br>Email: <code>${rec.email}</code><br>New password: <code>${password}</code></p>
            <p><a href="${dashUrl}" style="color:#2D6FFF">${dashUrl}</a></p></div>`,
        }),
      });
      emailed = res.ok;
    } catch { /* best-effort */ }
  }
  return json({ ok: true, password, email: rec.email || null, emailed });
}

// GET/POST /api/dashboard/settings — read or write a practice's white-label
// config. Authenticated. Upserts a registry record for static tenants that
// have none yet (so hallmark/lucid/etc. can be customized too).
async function handleDashSettings(request, env, origin) {
  const payload = await dashVerify(env, bearer(request));
  if (!payload) return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });

  const admin = isAdmin(payload);

  if (request.method === 'GET') {
    const t = scopeTenant(payload, request, null);
    if (!t) return json({ error: 'Missing tenant' }, 400);
    const rec = await registryGet(env, t);
    const config = (rec && rec.config) ? rec.config : defaultConfig(rec || { slug: t });
    const caps = await tenantCaps(env, t);
    // caps are surfaced to everyone (read-only for clients) but only admins may write them.
    return json({ slug: t, name: rec?.name || prettyTenant(t), config, caps, role: roleOf(payload), canEditCaps: admin });
  }

  // POST — write.
  let body; try { body = await request.json(); } catch { body = {}; }
  const t = scopeTenant(payload, request, body);
  if (!t) return json({ error: 'Missing tenant' }, 400);
  const rec = (await registryGet(env, t)) || { slug: t, name: prettyTenant(t), createdAt: new Date().toISOString() };
  rec.config = sanitizeConfig(body.config, rec);
  // Keep top-level name in sync with branding for onboard emails / listings.
  if (rec.config.branding?.name) rec.name = rec.config.branding.name;
  // Token management: usage caps (sims/videos) are ADMIN-ONLY. A client posting
  // caps is ignored, not rejected, so their branding save still succeeds.
  if (admin && body.caps && typeof body.caps === 'object') {
    const n = (v, fb) => (Number.isFinite(+v) && +v >= 0 ? Math.min(1_000_000, Math.round(+v)) : fb);
    rec.sims   = n(body.caps.sims,   rec.sims   || 1000);
    rec.videos = n(body.caps.videos, rec.videos || 50);
    // Mirror into config.plan for the future credit system.
    if (rec.config.plan) { rec.config.plan.simsCap = rec.sims; rec.config.plan.videosCap = rec.videos; }
  }
  await env.TEMP_IMAGES.put(`registry/${t}.json`, JSON.stringify(rec),
    { httpMetadata: { contentType: 'application/json' } });
  return json({ ok: true, config: rec.config, caps: { sims: rec.sims, videos: rec.videos } });
}

// POST /api/dashboard/logo — store a practice logo persistently (~10y) and
// return its hosted URL. The dashboard then saves it into config.branding.logoUrl.
async function handleDashLogo(request, env, origin) {
  const payload = await dashVerify(env, bearer(request));
  if (!payload) return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
  let body; try { body = await request.json(); } catch { body = {}; }
  const t = scopeTenant(payload, request, body);
  const dataUrl = body.dataUrl || '';
  if (!t || !/^data:image\//.test(dataUrl)) {
    return new Response(JSON.stringify({ error: 'Missing tenant or image' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  if (dataUrl.length > 1_200_000) {
    return new Response(JSON.stringify({ error: 'Logo too large (max ~800KB). Please upload a smaller image.' }), {
      status: 413, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  try {
    const media = await storeMedia(env, dataUrl, 3650);   // ~10 years (effectively persistent)
    return new Response(JSON.stringify({ ok: true, url: media.url }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Storage failed: ' + e.message }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
}

// GET /api/config?tenant= — PUBLIC white-label config for the simulator/widgets.
// Public-safe fields only (no password/email). Permissive CORS + short cache.
async function handleConfig(request, env) {
  const url = new URL(request.url);
  const t = (url.searchParams.get('tenant') || '').toLowerCase();
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=60',
  };
  if (!t) return new Response(JSON.stringify({ error: 'tenant required' }), { status: 400, headers });
  const rec = await registryGet(env, t);
  return new Response(JSON.stringify(publicConfig(env, t, rec)), { headers });
}
async function handleDashLeads(request, env, origin) {
  const payload = await dashVerify(env, bearer(request));
  if (!payload) return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
  const prefix = payload.t === '*' ? 'leads/' : `leads/${payload.t}/`;
  const list = await env.TEMP_IMAGES.list({ prefix, limit: 1000 });
  const objs = await Promise.all(list.objects.map(o =>
    env.TEMP_IMAGES.get(o.key).then(r => r && r.json()).catch(() => null)));
  const leads = objs.filter(Boolean).sort((a, b) => (b.ts || '').localeCompare(a.ts || '')).slice(0, 300);
  return new Response(JSON.stringify({ leads, scope: payload.t }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}
async function handleDashStatus(request, env, origin) {
  const payload = await dashVerify(env, bearer(request));
  if (!payload) return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
  let body; try { body = await request.json(); } catch { body = {}; }
  const allowed = ['new', 'contacted', 'booked', 'closed'];
  if (!allowed.includes(body.status)) return new Response(JSON.stringify({ error: 'Bad status' }), {
    status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
  const t = payload.t === '*' ? (body.tenant || '').toLowerCase() : payload.t;
  if (!t) return new Response(JSON.stringify({ error: 'Missing tenant' }), {
    status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
  await updateLead(env, t, body.id, { status: body.status });
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}
async function handleDashDelete(request, env, origin) {
  const payload = await dashVerify(env, bearer(request));
  if (!payload) return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
  let body; try { body = await request.json(); } catch { body = {}; }
  const t = payload.t === '*' ? (body.tenant || '').toLowerCase() : payload.t;
  if (!t || !body.id) return new Response(JSON.stringify({ error: 'Missing id/tenant' }), {
    status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
  await env.TEMP_IMAGES.delete(`leads/${t}/${body.id}.json`).catch(() => {});
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// Shared onboarding core. Creates the registry account (hashed password),
// email + origin indexes, and welcome emails. Returns a plain result object
// ({ error, status } on failure) so both the admin-key page (/api/onboard) and
// the session-authorized dashboard (/api/dashboard/practice/create) can call it.
async function createPractice(env, body) {
  const { practiceName, leadEmail, website } = body;
  if (!practiceName || !leadEmail) return { error: 'practiceName and leadEmail are required', status: 400 };
  const loginEmail = (body.email || leadEmail).toLowerCase().trim();

  const slug = (body.slug || practiceName).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
  if (!slug) return { error: 'Cannot derive slug from practiceName', status: 400 };

  const existing = await env.TEMP_IMAGES.get(`registry/${slug}.json`);
  if (existing) return { error: `Tenant '${slug}' already exists — use a different slug`, status: 409 };

  // Random 12-char password. Emailed once; only the salted hash is persisted.
  const pwBytes = crypto.getRandomValues(new Uint8Array(9));
  const password = Array.from(pwBytes, b => b.toString(36).padStart(2, '0')).join('').slice(0, 12);
  const { hash: passwordHash, salt: passwordSalt } = await hashPassword(password);

  const sims   = body.simsPerMonth   || 1000;
  const videos = body.videosPerMonth || 50;
  const createdAt = new Date().toISOString();

  const record = {
    slug, name: practiceName, email: loginEmail, leadEmail,
    website: website || null, sims, videos, passwordHash, passwordSalt, createdAt,
    config: defaultConfig({ slug, name: practiceName, leadEmail, sims, videos }),
  };
  if (body.bookingUrl) record.config.booking.url = String(body.bookingUrl).slice(0, 400);
  await env.TEMP_IMAGES.put(`registry/${slug}.json`, JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } });

  await env.TEMP_IMAGES.put(`emailidx/${emailKey(loginEmail)}.json`, JSON.stringify({ slug }),
    { httpMetadata: { contentType: 'application/json' } }).catch(() => {});

  if (website) {
    const domain = website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
    const idx = JSON.stringify({ slug });
    const domainKey = domain.replace(/[^a-z0-9.-]/gi, '_');
    await Promise.all([
      env.TEMP_IMAGES.put(`origins/${domainKey}.json`,      idx, { httpMetadata: { contentType: 'application/json' } }),
      env.TEMP_IMAGES.put(`origins/www.${domainKey}.json`,  idx, { httpMetadata: { contentType: 'application/json' } }),
    ]);
  }

  const base    = 'https://drdonelson.github.io/hallmark-smile';
  const simUrl  = `${base}/smile-simulator.html?leadEmail=${encodeURIComponent(leadEmail)}&practice=${encodeURIComponent(practiceName)}&tenant=${slug}`;
  const dashUrl = `${base}/dashboard.html?t=${slug}&email=${encodeURIComponent(loginEmail)}`;
  const embedCode = `<iframe\n  src="${simUrl}"\n  width="100%" height="900"\n  allow="camera"\n  style="border:none;display:block"\n></iframe>`;

  if (env.RESEND_API_KEY) {
    const welcomeHtml = `
<div style="font-family:sans-serif;max-width:560px;color:#0A1628">
  <h2 style="color:#2D6FFF">Your Smile Simulator is ready!</h2>
  <p>Hi ${practiceName},</p>
  <p>Your AI smile simulator is set up and ready to go. Here's everything you need:</p>
  <h3 style="margin-top:24px">Direct link (share on social, email, ads)</h3>
  <p><a href="${simUrl}" style="color:#2D6FFF">${simUrl}</a></p>
  <h3>Website embed code</h3>
  <pre style="background:#f5f7ff;padding:14px;border-radius:8px;font-size:12px;overflow:auto">${embedCode.replace(/</g,'&lt;')}</pre>
  <h3>Dashboard &amp; customization</h3>
  <p>Manage leads and customize your simulator's branding, booking link, and treatments here:</p>
  <p><a href="${dashUrl}" style="color:#2D6FFF">${dashUrl}</a></p>
  <p><strong>Sign in with</strong><br>
     Email: <code style="background:#f0f0f0;padding:2px 6px;border-radius:4px">${loginEmail}</code><br>
     Password: <code style="background:#f0f0f0;padding:2px 6px;border-radius:4px">${password}</code></p>
  <p style="color:#888;font-size:12px">For your security this password isn't stored anywhere in plain text — keep this email or reset it later.</p>
  <p style="color:#888;font-size:13px;margin-top:32px">Questions? Reply to this email or contact your Lucid ROI account manager.</p>
</div>`;
    await Promise.all([
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Lucid ROI <onboarding@lucidroi.com>', to: [loginEmail], subject: `Your Smile Simulator is ready — ${practiceName}`, html: welcomeHtml }),
      }),
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Lucid ROI <onboarding@lucidroi.com>', to: ['dr.donelson@lucidroi.com'], subject: `New practice onboarded: ${practiceName}`, html: `<p><strong>${practiceName}</strong> (${slug}) onboarded. Lead email: ${leadEmail}. Dashboard: <a href="${dashUrl}">${dashUrl}</a>. Password: <code>${password}</code></p>` }),
      }),
    ]).catch(() => {});
  }

  return { ok: true, slug, simUrl, dashUrl, embedCode, password, leadEmail, loginEmail };
}

// --- Practice onboarding (admin-key gated, no origin check) ---
// POST { adminKey, practiceName, leadEmail, website?, bookingUrl?, slug?, simsPerMonth?, videosPerMonth? }
async function handleOnboard(request, env) {
  const json = h => ({ 'Content-Type': 'application/json', ...h });
  let body; try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: json() });
  }
  if (!env.ONBOARD_ADMIN_KEY || body.adminKey !== env.ONBOARD_ADMIN_KEY) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: json() });
  }
  const result = await createPractice(env, body);
  return new Response(JSON.stringify(result), { status: result.error ? (result.status || 400) : 200, headers: json() });
}

// POST /api/dashboard/practice/create — session-authorized onboarding for
// admins (you + Ritesh). No ONBOARD_ADMIN_KEY needed — the dashboard token's
// role is the gate. Deleting practices stays super-admin-only.
async function handleDashPracticeCreate(request, env, origin) {
  const payload = await dashVerify(env, bearer(request));
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
  if (!payload) return json({ error: 'Unauthorized' }, 401);
  if (!isAdmin(payload)) return json({ error: 'Only admins can create practices' }, 403);
  let body; try { body = await request.json(); } catch { body = {}; }
  const result = await createPractice(env, body);
  return json(result, result.error ? (result.status || 400) : 200);
}

// --- Lead email routing via Resend ---
// Expects POST { to, practice, firstName, lastName, email, phone, interest, tenant, leadId }
// `to` defaults to david@hallmarkdds.com when omitted (direct GitHub Pages access)
async function handleLead(request, env, origin) {
  if (!env.RESEND_API_KEY) {
    return new Response(JSON.stringify({ error: 'RESEND_API_KEY not configured' }), {
      status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  const {
    to       = 'david@hallmarkdds.com',
    practice = 'Hallmark Dental',
    firstName = '',
    lastName  = '',
    email     = '',
    phone     = '',
    interest  = '',
  } = body;

  // Persist to the central lead store for the dashboard.
  const tenant = tenantOf(body);
  const leadId = body.leadId || randomToken();
  await saveLead(env, tenant, leadId, {
    id: leadId, ts: new Date().toISOString(), tenant, practice,
    firstName, lastName, email, phone, interest,
    consentVersion: body.version || null, status: 'new',
  }).catch(() => {});

  const name    = [firstName, lastName].filter(Boolean).join(' ') || 'Unknown';
  const subject = `New Smile Simulator Lead — ${name}`;
  const html = `
<h2 style="color:#0A1628;font-family:sans-serif">New Smile Simulator Lead</h2>
<p style="font-family:sans-serif"><strong>Practice:</strong> ${practice}</p>
<table style="border-collapse:collapse;width:100%;max-width:480px;font-family:sans-serif">
  <tr style="background:#f5f7ff"><td style="padding:10px 14px;border:1px solid #dde3f0"><strong>Name</strong></td><td style="padding:10px 14px;border:1px solid #dde3f0">${name}</td></tr>
  <tr><td style="padding:10px 14px;border:1px solid #dde3f0"><strong>Email</strong></td><td style="padding:10px 14px;border:1px solid #dde3f0">${email}</td></tr>
  <tr style="background:#f5f7ff"><td style="padding:10px 14px;border:1px solid #dde3f0"><strong>Phone</strong></td><td style="padding:10px 14px;border:1px solid #dde3f0">${phone}</td></tr>
  <tr><td style="padding:10px 14px;border:1px solid #dde3f0"><strong>Interest</strong></td><td style="padding:10px 14px;border:1px solid #dde3f0">${interest}</td></tr>
</table>
<p style="font-family:sans-serif;color:#666;font-size:13px;margin-top:20px">
  Sent by Lucid ROI Smile Simulator
</p>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    'Smile Simulator <leads@lucidroi.com>',
        to:      [to],
        bcc:     [AGENCY_EMAIL],
        subject,
        html,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      return new Response(JSON.stringify({ error: 'Resend error', detail: data }), {
        status: res.status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
    return new Response(JSON.stringify({ ok: true, id: data.id }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
}

// Metered GPT image-edit proxy — the primary generation path. Meters a 'sim'
// per tenant (tenant via ?tenant=), then streams the multipart body to OpenAI
// with the key injected. The multipart body isn't read here (meter uses only
// headers/IP), so the stream reaches OpenAI intact.
// Short-lived HMAC token authorizing ONE Modal GPT-smile generation. Issued only
// after a successful meter, so the (public-URL) Modal endpoint can't be abused to
// burn OpenAI spend — Modal verifies this with the shared secret before running.
function _b64url(str) { return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function _b64urlBytes(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return _b64url(s); }
async function signMeterToken(env, tenant) {
  // Dedicated shared secret for the Modal endpoint (set MODAL_SHARED_SECRET to a
  // fresh value on BOTH the worker and Modal). Falls back to DASH_SECRET if unset.
  const secret = env.MODAL_SHARED_SECRET || env.DASH_SECRET || '';
  const body = _b64url(JSON.stringify({ t: tenant, exp: Date.now() + 120000 }));  // 2 min TTL
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return body + '.' + _b64urlBytes(new Uint8Array(sig));
}

// Meter a use (sim/video) without generating — the browser calls this before
// hitting the Modal GPT-smile endpoint directly (Modal has no metering). Returns
// 200 {ok:true, token} when allowed (and records the use) or the 429 from meter().
async function handleMeter(request, env, origin) {
  const url = new URL(request.url);
  const tenant = (url.searchParams.get('tenant') || 'unknown').toLowerCase();
  const kind = url.searchParams.get('kind') === 'videos' ? 'videos' : 'sims';
  const limited = await meter(env, request, tenant, kind, origin);
  if (limited) return limited;
  const token = await signMeterToken(env, tenant);
  return new Response(JSON.stringify({ ok: true, token }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

async function handleGptEdit(request, env, origin) {
  const tenant = (new URL(request.url).searchParams.get('tenant') || 'unknown').toLowerCase();
  const limited = await meter(env, request, tenant, 'sims', origin);
  if (limited) return limited;
  let res;
  try {
    res = await fetch(`${OPENAI_BASE}/v1/images/edits`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        ...(request.headers.get('Content-Type') ? { 'Content-Type': request.headers.get('Content-Type') } : {}),
      },
      body: request.body,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  const h = new Headers(res.headers);
  Object.entries(corsHeaders(origin)).forEach(([k, v]) => h.set(k, v));
  return new Response(res.body, { status: res.status, headers: h });
}

// --- Main handler ---
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Public temp-image endpoint — fal.ai fetches from here, no Origin required
    const imgMatch = url.pathname.match(/^\/api\/img\/([a-f0-9-]{36})$/);
    if (imgMatch && request.method === 'GET') {
      return handleTempImage(request, env, imgMatch[1]);
    }

    // Public hosted-media endpoint — email clients / <img> tags fetch with no
    // Origin; opaque 48-hex token + retention check is the access control.
    const mMatch = url.pathname.match(/^\/api\/m\/([a-f0-9]{48})$/);
    if (mMatch && request.method === 'GET') {
      return handleStoredMedia(env, mMatch[1]);
    }

    // Practice onboarding — admin-key gated, no origin check required
    if (url.pathname === '/api/onboard' && request.method === 'POST') {
      return handleOnboard(request, env);
    }

    // Public white-label config — the simulator/widgets fetch this from any
    // embedding origin, so it runs before the origin gate with permissive CORS.
    if (url.pathname === '/api/config' && request.method === 'GET') {
      return handleConfig(request, env);
    }

    const origin = await getAllowedOrigin(request, env);

    // Reject requests from disallowed origins
    if (!origin) {
      return new Response('Forbidden', { status: 403 });
    }

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin),
      });
    }

    if (url.pathname === '/api/dashboard/login' && request.method === 'POST') {
      return handleDashLogin(request, env, origin);
    }
    if (url.pathname === '/api/dashboard/leads' && request.method === 'GET') {
      return handleDashLeads(request, env, origin);
    }
    if (url.pathname === '/api/dashboard/status' && request.method === 'POST') {
      return handleDashStatus(request, env, origin);
    }
    if (url.pathname === '/api/dashboard/delete' && request.method === 'POST') {
      return handleDashDelete(request, env, origin);
    }
    if (url.pathname === '/api/dashboard/settings' && (request.method === 'GET' || request.method === 'POST')) {
      return handleDashSettings(request, env, origin);
    }
    if (url.pathname === '/api/dashboard/logo' && request.method === 'POST') {
      return handleDashLogo(request, env, origin);
    }
    if (url.pathname === '/api/dashboard/practices' && request.method === 'GET') {
      return handleDashPractices(request, env, origin);
    }
    if (url.pathname === '/api/dashboard/practice/create' && request.method === 'POST') {
      return handleDashPracticeCreate(request, env, origin);
    }
    if (url.pathname === '/api/dashboard/practice/delete' && request.method === 'POST') {
      return handleDashPracticeDelete(request, env, origin);
    }
    if (url.pathname === '/api/dashboard/practice/reset-password' && request.method === 'POST') {
      return handleDashResetPassword(request, env, origin);
    }
    if (url.pathname === '/api/consent' && request.method === 'POST') {
      return handleConsent(request, env, origin);
    }
    if (url.pathname === '/api/share' && request.method === 'POST') {
      return handleShare(request, env, origin);
    }
    if (url.pathname === '/api/lead' && request.method === 'POST') {
      return handleLead(request, env, origin);
    }

    // SAM teeth segmentation
    if (url.pathname === '/api/sam/start' && request.method === 'POST') {
      return handleSAMStart(request, env, origin);
    }

    // FLUX Pro Fill inpainting
    if (url.pathname === '/api/flux/inpaint' && request.method === 'POST') {
      return handleFluxInpaint(request, env, origin);
    }

    // Ideogram v2 inpainting (primary AI path)
    if (url.pathname === '/api/ideogram/inpaint' && request.method === 'POST') {
      return handleIdeogramInpaint(request, env, origin);
    }
    if (url.pathname === '/api/usage' && request.method === 'GET') {
      return handleUsage(request, env, origin);
    }

    // Replicate SDXL Inpainting
    if (url.pathname === '/api/replicate/inpaint' && request.method === 'POST') {
      return handleReplicateInpaint(request, env, origin);
    }
    if (url.pathname === '/api/replicate/status' && request.method === 'GET') {
      return handleReplicateStatus(request, env, origin);
    }

    // Modal dental LoRA inpainting (synchronous, no polling needed)
    if (url.pathname === '/api/modal/inpaint' && request.method === 'POST') {
      return handleModalInpaint(request, env, origin);
    }

    // Dental LoRA inpainting (uses DENTAL_MODEL_VERSION secret when available)
    if (url.pathname === '/api/dental/inpaint' && request.method === 'POST') {
      return handleDentalInpaint(request, env, origin);
    }

    // RunPod ComfyUI pipeline (fallback)
    if (url.pathname === '/api/runpod/generate' && request.method === 'POST') {
      return handleRunpodGenerate(request, env, origin);
    }
    if (url.pathname === '/api/runpod/status' && request.method === 'GET') {
      return handleRunpodStatus(request, env, origin);
    }

    // Image proxy — lets the browser load cross-origin images into canvas safely
    if (url.pathname === '/api/proxy' && request.method === 'GET') {
      return handleProxyImage(request, env, origin);
    }

    // Kling / fal.ai video endpoints
    // Metered GPT image edit (primary generation path). Counts a 'sim' against
    // the tenant cap (the generic OpenAI proxy below is NOT metered).
    if (url.pathname === '/api/gpt/edit' && request.method === 'POST') {
      return handleGptEdit(request, env, origin);
    }
    // Meter a sim/video without generating — used before the browser calls the
    // Modal GPT-smile endpoint directly (Modal has no metering). 200 ok / 429.
    if (url.pathname === '/api/meter') {
      return handleMeter(request, env, origin);
    }
    if (url.pathname === '/api/kling/start' && request.method === 'POST') {
      return handleKlingStart(request, env, origin);
    }
    if (url.pathname === '/api/kling/status' && request.method === 'GET') {
      return handleKlingStatus(request, env, origin);
    }

    // Runway video endpoints (legacy)
    if (url.pathname === '/api/video/start' && request.method === 'POST') {
      return handleVideoStart(request, env, origin);
    }
    if (url.pathname === '/api/video/status' && request.method === 'GET') {
      return handleVideoStatus(request, env, origin);
    }

    // OpenAI proxy
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method Not Allowed', path: url.pathname, method: request.method }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    const upstream = `${OPENAI_BASE}${url.pathname}${url.search}`;

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstream, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
          ...(request.headers.get('Content-Type')
            ? { 'Content-Type': request.headers.get('Content-Type') }
            : {}),
        },
        body: request.body,
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    const responseHeaders = new Headers(upstreamResponse.headers);
    Object.entries(corsHeaders(origin)).forEach(([k, v]) => responseHeaders.set(k, v));

    return new Response(upstreamResponse.body, {
      status:  upstreamResponse.status,
      headers: responseHeaders,
    });
  },
};
