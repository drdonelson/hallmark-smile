// Smile Simulator - Cloudflare Worker
// Secrets needed: OPENAI_API_KEY, FAL_API_KEY
// Add both in Worker Settings > Variables > Secrets

const ALLOWED_ORIGINS = new Set([
  'https://drdonelson.github.io',
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

// --- Main handler ---
export default {
  async fetch(request, env) {
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

    const url = new URL(request.url);

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
