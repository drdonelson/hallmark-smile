// Smile Simulator - Cloudflare Worker
// Secrets needed: OPENAI_API_KEY, FAL_API_KEY
// Add both in Worker Settings > Variables > Secrets

const ALLOWED_ORIGINS = new Set([
  'https://drdonelson.github.io',
  'https://hallmarkdds.com',
  'https://www.hallmarkdds.com',
  'https://hallmarkdental.com',
  'https://www.hallmarkdental.com',
  'https://lucidroi.com',
  'https://www.lucidroi.com',
]);

const OPENAI_BASE    = 'https://api.openai.com';
const RUNWAY_BASE    = 'https://api.dev.runwayml.com/v1';
const RUNWAY_VERSION = '2024-11-06';
const FAL_BASE       = 'https://queue.fal.run';
const KLING_MODEL    = 'fal-ai/kling-video/v1.6/standard/image-to-video';

// CORS headers added to every response
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

function getAllowedOrigin(request) {
  const origin = request.headers.get('Origin') || '';
  return ALLOWED_ORIGINS.has(origin) ? origin : null;
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

  const prompt =
    'person laughing with genuine delight and mouthing the words "I can\'t believe this", ' +
    'mouth opens wide showing upper and lower teeth moving naturally, tongue briefly visible, ' +
    'jaw drops and rises with natural speech movement, lips articulate the words fluidly, ' +
    'surprised and overjoyed expression, cheeks lifted, eyes wide with happy disbelief, ' +
    'natural head movement, photorealistic human face, soft studio lighting';

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
        image_url:    image,
        duration:     '5',
        aspect_ratio: '9:16',
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

  const prompt = 'Complete cosmetic dental makeover result. Full smile transformation: replace the teeth with ideal porcelain veneer quality — perfect golden proportion tooth widths, central incisors dominant, lateral incisors slightly narrower, canines tapering naturally. Ovoid tooth shape. Broad full smile arc filling buccal corridors completely. Bright naturally white shade. Smooth incisal edges with subtle natural translucency. Realistic enamel surface texture with individual tooth variation — not uniform. Correct midline alignment. Healthy natural gingival margins. Photorealistic cosmetic dentistry case photo — the kind a top cosmetic dentist would use in their portfolio.';

  const negative_prompt = 'subtle change, minor whitening, existing tooth shape, crowding, gaps, missing teeth, broken teeth, yellow, stained, plastic slab, denture look, flat texture, uniform blob, artificial glow, AI artifacts, altered lips, altered skin, altered face, smile widening, face reshaping, uncanny smoothness';

  try {
    const fal = await fetch('https://queue.fal.run/fal-ai/flux-pro/v1/fill', {
      method:  'POST',
      headers: { 'Authorization': `Key ${env.FAL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url:           imageUrl,
        mask_url:            maskUrl,
        prompt,
        negative_prompt,
        num_inference_steps: 30,
        guidance_scale:      20,
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

// --- Replicate: SDXL Inpainting (lucataco/sdxl-inpainting) ---
// Uploads image + mask to R2, submits to Replicate, returns prediction ID for polling.
const REPLICATE_SDXL_VERSION = 'a5b13068cc81a89a4fbeefeccc774869fcb34df4dbc92c1555e0f2771d49dde7';
// Set DENTAL_MODEL_VERSION in Worker secrets after deploying the dental LoRA to Replicate.
// Format: "username/model-name:version-hash"  e.g. "drdonelson/dental-inpaint:abc123..."
// When unset, /api/dental/inpaint falls back to the generic SDXL inpainting model.
const WORKER_HOST = 'quiet-forest-e1f8.david-d73.workers.dev';

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

  const prompt = 'Photorealistic cosmetic dental result photo. Upper teeth whitened to shade BL1 bright natural white. Same smile width and natural mouth shape as original — do not widen smile or add extra teeth. Central incisors dominant width, lateral incisors slightly narrower, canines tapered — golden proportion. Individual tooth edges clearly defined with natural inter-dental shadows. Realistic enamel surface texture with subtle micro-variation and translucency at incisal edges. Healthy pink gingival margins intact. Midline centered. Clinical macro dental photography, authentic cosmetic dentistry result.';
  const negative_prompt = 'yellow teeth, stained teeth, discolored teeth, flat uniform white blob, no tooth detail, all teeth same width, plastic texture, denture, fake teeth, wider smile than original, extra teeth, dark buccal corridor, black corners of mouth, shadow at mouth corners, AI artifacts, altered lips, altered skin, altered face, tilted teeth, canted smile, wrong proportions, cartoon, painting, blurry';

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

// --- Main handler ---
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Public temp-image endpoint — fal.ai fetches from here, no Origin required
    const imgMatch = url.pathname.match(/^\/api\/img\/([a-f0-9-]{36})$/);
    if (imgMatch && request.method === 'GET') {
      return handleTempImage(request, env, imgMatch[1]);
    }

    const origin = getAllowedOrigin(request);

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

    // SAM teeth segmentation
    if (url.pathname === '/api/sam/start' && request.method === 'POST') {
      return handleSAMStart(request, env, origin);
    }

    // FLUX Pro Fill inpainting (Phase 1 AI path)
    if (url.pathname === '/api/flux/inpaint' && request.method === 'POST') {
      return handleFluxInpaint(request, env, origin);
    }

    // Replicate SDXL Inpainting (primary AI path)
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
