#!/usr/bin/env python3
"""Controlled GPT full-image smile-transformation test path.

Milestone from the Carthago (Amor) proposal: add a controlled GPT test path,
compare against the current Ideogram/LoRA/Modal outputs, decide if GPT should
become primary. This tests the developer's hypothesis directly: send the FULL
face to gpt-image (not the mouth crop) so the model has full-image lighting
context — the thing the crop-zoom pipeline never solved.

Two variants:
  nomask  — full image + prompt only. GPT regenerates guided by the prompt.
  mask    — full image + a loose, feathered mouth mask (transparent = editable),
            so the face/eyes/hair/background are preserved pixel-for-pixel while
            GPT still sees the whole image for lighting.

Routes through the Cloudflare Worker's OpenAI proxy (keeps the key server-side),
with an allowed Origin header. Saves the result under test-outputs/<dir>/ so
comparison/iteration afterward is free.

Usage:
  python3 harness/gpt_fullface.py <image> [--variant nomask|mask] [--model gpt-image-1]
                                          [--dir NAME] [--quality high|medium|low]
"""
import sys, os, io, json, argparse, subprocess
import numpy as np
from PIL import Image, ImageOps, ImageFilter, ImageDraw
import requests

ROOT   = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKER = 'https://quiet-forest-e1f8.david-d73.workers.dev'
ORIGIN = 'https://drdonelson.github.io'
MODEL_PATH = os.path.join(ROOT, 'harness', 'face_landmarker.task')

# Outer-lip landmark indices (MediaPipe face mesh) — enough for a mouth bbox.
LIP_IDX = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291,
           409, 270, 269, 267, 0, 37, 39, 40, 185, 78, 308, 13, 14]

PROMPT = (
    "Retouch this exact photo. Change ONLY the teeth surfaces that are already visible "
    "between the lips. Make them straight, even, and bright natural white (shade BL1-BL2, "
    "not gray, not blue, not yellow), with individual teeth defined by natural "
    "inter-dental shadows and subtle incisal translucency, and healthy pink gums. "
    "Repair chips, decay, and gaps on the teeth that are visible. "
    "CRITICAL identity lock: this must remain the SAME photograph of the SAME person. "
    "Do NOT change the mouth shape, do NOT open the mouth wider, do NOT change the smile "
    "width or the lip position or the amount of teeth showing. Keep the exact same "
    "expression, the exact same lips, skin, freckles, wrinkles, facial hair, hair, eyes, "
    "age, head angle, framing, lighting, shadows, clothing, and background. Do not smooth "
    "or beautify the skin. Only the teeth pixels change; everything else is pixel-identical "
    "to the input. Photorealistic, identical lighting to the original."
)


def get_landmarks(img_path):
    out = subprocess.run(['python3', os.path.join(ROOT, 'harness', 'landmarks.py'),
                          img_path, MODEL_PATH], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError('landmarks.py failed: ' + out.stderr[-300:])
    return json.loads(out.stdout)['landmarks']


def build_mouth_mask(size, landmarks):
    """Loose feathered mask: transparent (editable) over the mouth region."""
    w, h = size
    xs = [lm['x'] * w for lm in (landmarks[i] for i in LIP_IDX)]
    ys = [lm['y'] * h for lm in (landmarks[i] for i in LIP_IDX)]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    mw, mh = x1 - x0, y1 - y0
    # Generous padding so gums + smile arc are inside the editable zone.
    ex, ey = mw * 0.55, mh * 0.9
    box = [x0 - ex, y0 - ey, x1 + ex, y1 + ey]
    m = Image.new('L', (w, h), 0)          # 0 = opaque(keep) after invert below
    d = ImageDraw.Draw(m)
    d.ellipse(box, fill=255)               # 255 = the region to edit
    m = m.filter(ImageFilter.GaussianBlur(max(6, int(mw * 0.06))))
    # OpenAI edits: transparent alpha = edit. Build RGBA where alpha=0 in region.
    rgba = Image.new('RGBA', (w, h), (0, 0, 0, 255))
    alpha = Image.eval(m, lambda v: 255 - v)   # region -> low alpha (editable)
    rgba.putalpha(alpha)
    return rgba


def prep_image(img_path, max_side=1024):
    im = ImageOps.exif_transpose(Image.open(img_path)).convert('RGB')
    w, h = im.size
    s = min(1.0, max_side / max(w, h))
    if s < 1.0:
        im = im.resize((round(w * s), round(h * s)), Image.LANCZOS)
    return im


def to_png_bytes(im):
    b = io.BytesIO(); im.save(b, 'PNG'); return b.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('image')
    ap.add_argument('--variant', default='nomask', choices=['nomask', 'mask'])
    ap.add_argument('--model', default='gpt-image-1')
    ap.add_argument('--quality', default='high')
    ap.add_argument('--dir', default=None)
    args = ap.parse_args()

    img_path = args.image if os.path.isabs(args.image) else os.path.join(ROOT, args.image)
    stem = os.path.splitext(os.path.basename(img_path))[0]
    out_dir = os.path.join(ROOT, 'test-outputs', args.dir or stem)
    os.makedirs(out_dir, exist_ok=True)

    im = prep_image(img_path)
    files = {'image': ('face.png', to_png_bytes(im), 'image/png')}

    if args.variant == 'mask':
        lms = get_landmarks(img_path)
        mask = build_mouth_mask(im.size, lms)
        files['mask'] = ('mask.png', to_png_bytes(mask), 'image/png')
        mask.save(os.path.join(out_dir, 'gpt_mask.png'))

    data = {'model': args.model, 'prompt': PROMPT, 'n': '1',
            'size': 'auto', 'quality': args.quality}
    print(f'→ {args.model} / {args.variant} / {im.size}  (posting to worker proxy)…')
    r = requests.post(f'{WORKER}/v1/images/edits',
                      headers={'Origin': ORIGIN}, files=files, data=data, timeout=300)
    if r.status_code != 200:
        print(f'ERROR {r.status_code}: {r.text[:500]}'); sys.exit(1)
    payload = r.json()
    item = payload['data'][0]
    if item.get('b64_json'):
        import base64
        raw = base64.b64decode(item['b64_json'])
    else:
        raw = requests.get(item['url'], timeout=120).content
    dest = os.path.join(out_dir, f'gpt_fullface_{args.variant}.png')
    with open(dest, 'wb') as f:
        f.write(raw)
    print(f'✓ saved {dest}  ({len(raw)//1024} KB)')


if __name__ == '__main__':
    main()
