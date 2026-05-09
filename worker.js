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

  const { image, width, height } = body;
  if (!image || !width || !height) {
    return new Response(JSON.stringify({ error: 'Missing image, width or height' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  // fal.ai queue does NOT accept data URIs — store image in KV and serve it from this worker
  let imageUrl;
  try {
    const [meta, b64] = image.split(',');
    const mimeType    = (meta.match(/:(.*?);/) || [])[1] || 'image/png';
    const imgId       = crypto.randomUUID();
    // Store base64 string + mime type in KV with 5-minute TTL
    await env.TEMP_IMAGES.put(imgId, JSON.stringify({ b64, mimeType }), { expirationTtl: 300 });
    // Build the public URL that fal.ai can fetch
    const workerHost = 'quiet-forest-e1f8.david-d73.workers.dev';
    imageUrl = `https://${workerHost}/api/img/${imgId}`;
  } catch (err) {
    return new Response(JSON.stringify({ error: `image store failed: ${err.message}` }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  // Teeth box: horizontal center 25–75%, vertical 61–82%
  const bx1 = Math.round(width  * 0.25);
  const by1 = Math.round(height * 0.61);
  const bx2 = Math.round(width  * 0.75);
  const by2 = Math.round(height * 0.82);
  const px  = Math.round(width  * 0.50);
  const py  = Math.round(height * 0.69);

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

  const { image, mask, width, height } = body;
  if (!image || !mask || !width || !height) {
    return new Response(JSON.stringify({ error: 'Missing image, mask, width, or height' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  // Upload a base64 data URI to fal.ai storage → returns a stable CDN URL
  async function uploadToFal(dataUri, filename) {
    const [meta, b64] = dataUri.split(',');
    const mimeType    = (meta.match(/:(.*?);/) || [])[1] || 'image/png';
    const bytes       = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const form        = new FormData();
    form.append('file', new Blob([bytes], { type: mimeType }), filename);
    const res  = await fetch('https://storage.fal.run', {
      method:  'POST',
      headers: { 'Authorization': `Key ${env.FAL_API_KEY}` },
      body:    form,
    });
    const data = await res.json();
    if (!data.url) throw new Error('fal storage upload failed: ' + JSON.stringify(data));
    return data.url;
  }

  let imageUrl, maskUrl;
  try {
    [imageUrl, maskUrl] = await Promise.all([
      uploadToFal(image, 'photo.png'),
      uploadToFal(mask,  'mask.png'),
    ]);
  } catch (err) {
    return new Response(JSON.stringify({ error: `fal upload failed: ${err.message}` }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  const prompt = 'Hollywood dental smile makeover, BL1 porcelain veneers, brilliant white teeth, dramatic transformation, perfect alignment, no gaps or crowding, full broad smile arc corner to corner, natural healthy pink gumline, photorealistic enamel with natural translucency at incisal edges, dental cosmetic marketing visualization, stunning jaw-dropping smile';

  try {
    const fal = await fetch('https://queue.fal.run/fal-ai/flux-pro/v1/fill', {
      method:  'POST',
      headers: { 'Authorization': `Key ${env.FAL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url:           imageUrl,
        mask_url:            maskUrl,
        prompt,
        num_inference_steps: 28,
        guidance_scale:      30,
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

// --- RunPod: ComfyUI dental workflow (Phase 2 — add RUNPOD_ENDPOINT_ID + RUNPOD_API_KEY secrets) ---
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
  try {
    const rp = await fetch(`https://api.runpod.ai/v2/${endpointId}/run`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RUNPOD_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: body }),
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

// --- Temp image serve: fal.ai fetches from here (no origin check needed) ---
async function handleTempImage(request, env, imgId) {
  try {
    const stored = await env.TEMP_IMAGES.get(imgId);
    if (!stored) return new Response('Not Found', { status: 404 });
    const { b64, mimeType } = JSON.parse(stored);
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    return new Response(bytes, {
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

    // RunPod ComfyUI pipeline (Phase 2 — wired up, awaiting developer endpoint)
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
