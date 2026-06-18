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
// Seedance v1 lite: 8s duration, 720p, strong prompt-driven human motion,
// and FAST (~60-90s delivery — Kling v3 Pro took 3+ min, v1.6 standard
// ignored motion direction entirely). No audio — visual mouthing only.
const KLING_MODEL    = 'fal-ai/bytedance/seedance/v1/lite/image-to-video';

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

  const prompt =
    'The person slowly turns their head to the left showing their new smile in profile, ' +
    'then turns back to face the camera directly, smiling broadly the whole time. ' +
    'Looking at the camera, they mouth the words "this smile is absolutely amazing" ' +
    'with natural lip and jaw articulation, then laugh warmly and naturally. ' +
    'Joyful confident energy, eyes sparkling, natural blinking, ' +
    'photorealistic human face, soft studio lighting, camera static.';

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
        duration:     '8',
        resolution:   '720p',
        camera_fixed: true,
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
  if (variant === 'perioralSmile') {
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
const TENANTS = {
  hallmark:     { sims: 2000, videos: 100 },   // ≈1000 simulations/mo
  lucid:        { sims: 1000, videos: 50 },    // ≈500 simulations/mo
  sevenbridges: { sims: 1000, videos: 50 },    // Lucid client — Dr. Fariha Qureshi, Seven Bridges Dental Studio
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
  if (!TENANTS[tenant]) {
    return new Response(JSON.stringify({ error: 'Unknown tenant', tenants: Object.keys(TENANTS) }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  const month = new Date().toISOString().slice(0, 7);
  const use = await usageRead(env, `usage/${tenant}/${month}.json`);
  return new Response(JSON.stringify({ tenant, month, used: use, caps: TENANTS[tenant] }), {
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

  const LEGAL = 'https://app.lucidroi.com/legal';
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
// Single-password login: the password identifies the tenant (env.DASH_PASSWORDS
// is a JSON map slug→password). The "admin" slug grants all-tenant access ('*').
async function handleDashLogin(request, env, origin) {
  let body; try { body = await request.json(); } catch { body = {}; }
  let pwmap = {}; try { pwmap = JSON.parse(env.DASH_PASSWORDS || '{}'); } catch {}
  let matched = null;
  for (const [slug, pw] of Object.entries(pwmap)) {
    if (pw && typeof body.password === 'string' && body.password === pw) { matched = slug; break; }
  }
  // Dynamic tenants: if body.tenant is provided and not found in DASH_PASSWORDS, check registry
  if (!matched && body.tenant && typeof body.password === 'string') {
    const rec = await registryGet(env, body.tenant.toLowerCase());
    if (rec && rec.password && body.password === rec.password) matched = rec.slug;
  }
  if (!matched) {
    return new Response(JSON.stringify({ error: 'Incorrect password' }), {
      status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
  const t = matched === 'admin' ? '*' : matched;
  const token = await dashSign(env, { t, exp: Date.now() + 12 * 3600_000 });
  return new Response(JSON.stringify({ token, scope: t }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
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

// --- Practice onboarding (admin-key gated, no origin check) ---
// POST { adminKey, practiceName, leadEmail, website?, simsPerMonth?, videosPerMonth? }
// Creates R2 registry entry + origins index, sends welcome email, returns all links.
async function handleOnboard(request, env) {
  const json = h => ({ 'Content-Type': 'application/json', ...h });
  let body; try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: json() });
  }
  if (!env.ONBOARD_ADMIN_KEY || body.adminKey !== env.ONBOARD_ADMIN_KEY) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: json() });
  }
  const { practiceName, leadEmail, website } = body;
  if (!practiceName || !leadEmail) {
    return new Response(JSON.stringify({ error: 'practiceName and leadEmail are required' }), { status: 400, headers: json() });
  }

  // Derive slug: lowercase alphanum only, max 24 chars
  const slug = (body.slug || practiceName).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
  if (!slug) return new Response(JSON.stringify({ error: 'Cannot derive slug from practiceName' }), { status: 400, headers: json() });

  // Prevent duplicate slugs
  const existing = await env.TEMP_IMAGES.get(`registry/${slug}.json`);
  if (existing) return new Response(JSON.stringify({ error: `Tenant '${slug}' already exists — use a different slug` }), { status: 409, headers: json() });

  // Random 12-char password (base36, URL-safe)
  const pwBytes = crypto.getRandomValues(new Uint8Array(9));
  const password = Array.from(pwBytes, b => b.toString(36).padStart(2, '0')).join('').slice(0, 12);

  const sims   = body.simsPerMonth   || 1000;
  const videos = body.videosPerMonth || 50;
  const createdAt = new Date().toISOString();

  // Persist registry entry
  const record = { slug, name: practiceName, leadEmail, website: website || null, sims, videos, password, createdAt };
  await env.TEMP_IMAGES.put(`registry/${slug}.json`, JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } });

  // Index website domain(s) for dynamic CORS lookup
  if (website) {
    const domain = website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
    const idx = JSON.stringify({ slug });
    const domainKey = domain.replace(/[^a-z0-9.-]/gi, '_');
    await Promise.all([
      env.TEMP_IMAGES.put(`origins/${domainKey}.json`,      idx, { httpMetadata: { contentType: 'application/json' } }),
      env.TEMP_IMAGES.put(`origins/www.${domainKey}.json`,  idx, { httpMetadata: { contentType: 'application/json' } }),
    ]);
  }

  // Build deliverables
  const base    = 'https://drdonelson.github.io/hallmark-smile';
  const simUrl  = `${base}/smile-simulator.html?leadEmail=${encodeURIComponent(leadEmail)}&practice=${encodeURIComponent(practiceName)}&tenant=${slug}`;
  const dashUrl = `${base}/dashboard.html?t=${slug}`;
  const embedCode = `<iframe\n  src="${simUrl}"\n  width="100%" height="900"\n  allow="camera"\n  style="border:none;display:block"\n></iframe>`;

  // Welcome email to practice
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
  <h3>Lead dashboard</h3>
  <p><a href="${dashUrl}" style="color:#2D6FFF">${dashUrl}</a></p>
  <p><strong>Password:</strong> <code style="background:#f0f0f0;padding:2px 6px;border-radius:4px">${password}</code></p>
  <p style="color:#888;font-size:13px;margin-top:32px">Questions? Reply to this email or contact your Lucid ROI account manager.</p>
</div>`;
    await Promise.all([
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Lucid ROI <onboarding@lucidroi.com>', to: [leadEmail], subject: `Your Smile Simulator is ready — ${practiceName}`, html: welcomeHtml }),
      }),
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Lucid ROI <onboarding@lucidroi.com>', to: ['dr.donelson@lucidroi.com'], subject: `New practice onboarded: ${practiceName}`, html: `<p><strong>${practiceName}</strong> (${slug}) onboarded. Lead email: ${leadEmail}. Dashboard: <a href="${dashUrl}">${dashUrl}</a>. Password: <code>${password}</code></p>` }),
      }),
    ]).catch(() => {});
  }

  return new Response(JSON.stringify({ ok: true, slug, simUrl, dashUrl, embedCode, password, leadEmail }), {
    headers: json(),
  });
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
