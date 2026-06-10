// One-off: exercise the production Kling v3 video path end-to-end.
// Sends a real "after" composite to the worker, polls to completion,
// downloads the video to test-outputs/.
import { readFile, writeFile } from 'node:fs/promises';

const WORKER = 'https://quiet-forest-e1f8.david-d73.workers.dev';
const ORIGIN = 'https://drdonelson.github.io';
const SRC = process.argv[2] || 'test-outputs/_DSC1529/composite_peri4.jpg';
const OUT = process.argv[3] || 'test-outputs/_DSC1529/video_v3.mp4';

const buf = await readFile(SRC);
const image = 'data:image/jpeg;base64,' + buf.toString('base64');

const startRes = await fetch(`${WORKER}/api/kling/start`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Origin': ORIGIN },
  body: JSON.stringify({ image }),
});
const start = await startRes.json();
if (!start.request_id) { console.error('start failed:', JSON.stringify(start).slice(0, 500)); process.exit(1); }
console.log('queued:', start.request_id);

const t0 = Date.now();
let status = '';
while (Date.now() - t0 < 15 * 60 * 1000) {
  await new Promise(r => setTimeout(r, 8000));
  const sr = await fetch(`${WORKER}/api/kling/status?falUrl=${encodeURIComponent(start.status_url)}`, { headers: { 'Origin': ORIGIN } });
  const sd = await sr.json();
  status = (sd.status || '').toUpperCase();
  console.log(status, Math.round((Date.now() - t0) / 1000) + 's');
  if (status === 'COMPLETED') break;
  if (status === 'FAILED' || sd.error) { console.error('failed:', JSON.stringify(sd).slice(0, 800)); process.exit(1); }
}
if (status !== 'COMPLETED') { console.error('timed out'); process.exit(1); }

const rr = await fetch(`${WORKER}/api/kling/status?falUrl=${encodeURIComponent(start.response_url)}`, { headers: { 'Origin': ORIGIN } });
const result = await rr.json();
const url = result.video && result.video.url;
if (!url) { console.error('no video url:', JSON.stringify(result).slice(0, 800)); process.exit(1); }
console.log('video url:', url);
const vid = await fetch(url);
await writeFile(OUT, Buffer.from(await vid.arrayBuffer()));
console.log('saved:', OUT);
