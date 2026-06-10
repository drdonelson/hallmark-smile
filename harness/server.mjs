// Local test harness server for the smile simulator pipeline.
// - Serves the repo statically (harness page, test photos, cached outputs)
// - POST /save        {file, dataUrl|json}  → writes under test-outputs/ only
// - POST /api/ideogram {image, mask, dir}   → forwards to the Cloudflare Worker
//   (with an allowed Origin header, since the worker CORS-locks to production
//   origins), polls Replicate to completion, downloads the result, and saves
//   it as test-outputs/<dir>/ideo_raw.png so iteration after this call is free.
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT   = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT    = path.join(ROOT, 'test-outputs');
const WORKER = 'https://quiet-forest-e1f8.david-d73.workers.dev';
const ORIGIN = 'https://drdonelson.github.io';
const PORT   = 8788;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

function safeOut(rel) {
  const r = path.normalize(path.join(OUT, rel));
  if (!r.startsWith(OUT + path.sep)) throw new Error('path escapes test-outputs');
  return r;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

async function handleSave(body) {
  const { file, dataUrl, json } = JSON.parse(body.toString());
  const dest = safeOut(file);
  await mkdir(path.dirname(dest), { recursive: true });
  if (json !== undefined) {
    await writeFile(dest, JSON.stringify(json, null, 2));
  } else {
    const m = dataUrl.match(/^data:[\w/+.-]+;base64,(.*)$/s);
    if (!m) throw new Error('bad dataUrl');
    await writeFile(dest, Buffer.from(m[1], 'base64'));
  }
  return { ok: true, file };
}

// Native MediaPipe landmarks — headless Chromium can't run the wasm build (no WebGL).
async function handleLandmarks(body) {
  const { file } = JSON.parse(body.toString());
  const img = safeOut(file);
  const script = path.join(ROOT, 'harness', 'landmarks.py');
  const model = path.join(ROOT, 'harness', 'face_landmarker.task');
  const out = await new Promise((resolve, reject) => {
    const p = spawn('python3', [script, img, model]);
    let so = '', se = '';
    p.stdout.on('data', d => so += d);
    p.stderr.on('data', d => se += d);
    p.on('close', code => code === 0 ? resolve(so) : reject(new Error('landmarks.py: ' + se.slice(-300))));
  });
  return JSON.parse(out);
}

async function handleIdeogram(body) {
  const { image, mask, dir } = JSON.parse(body.toString());
  const startRes = await fetch(`${WORKER}/api/ideogram/inpaint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': ORIGIN },
    body: JSON.stringify({ image, mask }),
  });
  const startText = await startRes.text();
  if (!startRes.ok) throw new Error(`worker ${startRes.status}: ${startText.slice(0, 300)}`);
  const startData = JSON.parse(startText);
  if (startData.error) throw new Error('ideogram: ' + startData.error);
  if (!startData.id) throw new Error('no prediction id: ' + startText.slice(0, 300));

  const t0 = Date.now();
  let outUrl = null;
  while (Date.now() - t0 < 180000) {
    await new Promise(r => setTimeout(r, 4000));
    const sr = await fetch(`${WORKER}/api/replicate/status?id=${encodeURIComponent(startData.id)}`,
      { headers: { 'Origin': ORIGIN } });
    const sd = await sr.json();
    console.log(`[ideogram ${dir}]`, sd.status, Math.round((Date.now() - t0) / 1000) + 's');
    if (sd.status === 'succeeded') { outUrl = Array.isArray(sd.output) ? sd.output[0] : sd.output; break; }
    if (sd.status === 'failed' || sd.status === 'canceled') throw new Error('ideogram failed: ' + JSON.stringify(sd.error));
  }
  if (!outUrl) throw new Error('ideogram timed out');

  const imgRes = await fetch(outUrl);
  if (!imgRes.ok) throw new Error(`download ${imgRes.status}`);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  const dest = safeOut(path.join(dir, 'ideo_raw.png'));
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return { ok: true, url: `/test-outputs/${dir}/ideo_raw.png` };
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type });
    res.end(type === 'application/json' ? JSON.stringify(obj) : obj);
  };
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (req.method === 'POST' && url.pathname === '/save') {
      return send(200, await handleSave(await readBody(req)));
    }
    if (req.method === 'POST' && url.pathname === '/api/ideogram') {
      return send(200, await handleIdeogram(await readBody(req)));
    }
    if (req.method === 'POST' && url.pathname === '/api/landmarks') {
      return send(200, await handleLandmarks(await readBody(req)));
    }
    if (req.method === 'GET') {
      const rel = decodeURIComponent(url.pathname);
      const file = path.normalize(path.join(ROOT, rel));
      if (!file.startsWith(ROOT + path.sep)) return send(403, { error: 'forbidden' });
      const data = await readFile(file);
      return send(200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    }
    send(404, { error: 'not found' });
  } catch (e) {
    console.error(req.method, req.url, '→', e.message);
    send(500, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`harness server on http://localhost:${PORT}`));
