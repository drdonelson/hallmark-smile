/**
 * ============================================================
 *  HALLMARK DENTAL — SMILE SIMULATOR
 *  Cloudflare Worker: OpenAI Proxy
 * ============================================================
 *
 *  DEPLOY INSTRUCTIONS
 *  ───────────────────
 *  1. Log in to https://dash.cloudflare.com → Workers & Pages
 *  2. Create a new Worker and paste this file
 *  3. Go to Settings → Variables → add a Secret named:
 *       OPENAI_API_KEY   (value: your sk-... key)
 *  4. Deploy — copy the *.workers.dev URL
 *  5. Paste that URL into index.html as PROXY_URL
 *
 *  ALLOWED ORIGINS (edit as needed)
 *  ─────────────────────────────────
 *  Update ALLOWED_ORIGINS below if you host the app elsewhere.
 */

const ALLOWED_ORIGINS = new Set([
  'https://drdonelson.github.io',
  'https://hallmarkdental.com',
  'https://www.hallmarkdental.com',
]);

const OPENAI_BASE = 'https://api.openai.com';

// CORS headers added to every response
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

function getAllowedOrigin(request) {
  const origin = request.headers.get('Origin') || '';
  return ALLOWED_ORIGINS.has(origin) ? origin : null;
}

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

    // Only allow POST
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: corsHeaders(origin),
      });
    }

    // Build the upstream URL by stripping the worker origin
    const url      = new URL(request.url);
    const upstream = `${OPENAI_BASE}${url.pathname}${url.search}`;

    // Forward the request to OpenAI, injecting the API key
    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstream, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
          // Forward Content-Type as-is (multipart/form-data with boundary)
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

    // Stream the OpenAI response back to the browser
    const responseHeaders = new Headers(upstreamResponse.headers);
    Object.entries(corsHeaders(origin)).forEach(([k, v]) => responseHeaders.set(k, v));

    return new Response(upstreamResponse.body, {
      status:  upstreamResponse.status,
      headers: responseHeaders,
    });
  },
};
