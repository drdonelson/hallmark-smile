#!/usr/bin/env python3
"""GPT-generate + tooth composite — the production-viable smile path.

gpt-image-1 full-image gives the best teeth + lighting, but re-renders (and
beautifies) the whole face and shifts the mouth. This step keeps ONLY GPT's
mouth interior and grafts it back onto the ORIGINAL, untouched face:

  1. MediaPipe inner-lip landmarks on BOTH the original and the GPT result.
  2. Estimate an affine transform GPT-mouth -> original-mouth and warp the GPT
     image so its teeth line up with the original mouth opening.
  3. Composite the warped GPT mouth interior into the original inner-lip polygon
     (feathered), so the patient's real skin/eyes/lips/identity are preserved and
     only the teeth change.
  4. Light color-match of the grafted teeth to the original perioral highlight.

Runs on the CACHED gpt_fullface_*.png (no API cost). Reuses landmarks.py.

Usage: python3 harness/gpt_composite.py <original> [--gpt PATH] [--dir NAME]
"""
import sys, os, json, argparse, subprocess
import numpy as np
import cv2
from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = os.path.join(ROOT, 'harness', 'face_landmarker.task')

# MediaPipe inner-lip loop (the mouth opening).
INNER_LIP = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308,
             415, 310, 311, 312, 13, 82, 81, 80, 191]


def landmarks(img_path):
    r = subprocess.run(['python3', os.path.join(ROOT, 'harness', 'landmarks.py'),
                        img_path, MODEL], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError('landmarks.py: ' + r.stderr[-300:])
    return json.loads(r.stdout)['landmarks']


def pts(landmarks_list, w, h, idx=INNER_LIP):
    return np.array([[landmarks_list[i]['x'] * w, landmarks_list[i]['y'] * h]
                     for i in idx], dtype=np.float32)


def load_rgb(path):
    im = ImageOps.exif_transpose(Image.open(path)).convert('RGB')
    return np.array(im)[:, :, ::-1].copy()  # -> BGR for cv2


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('original')
    ap.add_argument('--gpt', default=None, help='GPT full-image result (defaults to cached)')
    ap.add_argument('--dir', default=None)
    ap.add_argument('--feather', type=float, default=0.16, help='mask feather as frac of mouth width')
    args = ap.parse_args()

    orig_path = args.original if os.path.isabs(args.original) else os.path.join(ROOT, args.original)
    stem = os.path.splitext(os.path.basename(orig_path))[0]
    out_dir = os.path.join(ROOT, 'test-outputs', args.dir or stem)
    gpt_path = args.gpt or os.path.join(out_dir, 'gpt_fullface_nomask.png')

    orig = load_rgb(orig_path)
    gpt = load_rgb(gpt_path)
    H, W = orig.shape[:2]
    # Save the original at a manageable size to match landmark space.
    scale = min(1.0, 1024 / max(H, W))
    if scale < 1.0:
        orig = cv2.resize(orig, (round(W * scale), round(H * scale)), interpolation=cv2.INTER_LANCZOS4)
        H, W = orig.shape[:2]
    gpt = cv2.resize(gpt, (W, H), interpolation=cv2.INTER_LANCZOS4)

    # Landmarks need file paths — write temp normalized copies.
    tmp_o = os.path.join(out_dir, '_tmp_orig.png'); Image.fromarray(orig[:, :, ::-1]).save(tmp_o)
    tmp_g = os.path.join(out_dir, '_tmp_gpt.png');  Image.fromarray(gpt[:, :, ::-1]).save(tmp_g)
    lm_o = landmarks(tmp_o)
    lm_g = landmarks(tmp_g)

    src = pts(lm_g, W, H)   # GPT mouth
    dst = pts(lm_o, W, H)   # original mouth
    M, _ = cv2.estimateAffine2D(src, dst, method=cv2.LMEDS)
    if M is None:
        M, _ = cv2.estimateAffinePartial2D(src, dst)
    gpt_aligned = cv2.warpAffine(gpt, M, (W, H), flags=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REPLICATE)

    # Mask = original inner-lip polygon, dilated a touch, feathered.
    poly = dst.astype(np.int32)
    mask = np.zeros((H, W), np.uint8)
    cv2.fillConvexPoly(mask, cv2.convexHull(poly), 255)
    mouth_w = dst[:, 0].max() - dst[:, 0].min()
    k = max(3, int(mouth_w * 0.04) | 1)
    mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    fr = max(3, int(mouth_w * args.feather) | 1)
    maskf = cv2.GaussianBlur(mask, (fr, fr), 0).astype(np.float32) / 255.0

    # Light color match: shift aligned-GPT mouth mean toward original mouth-region
    # mean (keeps teeth luminance, avoids a bright graft seam).
    m3 = (maskf > 0.2)
    if m3.sum() > 50:
        for c in range(3):
            og = orig[:, :, c][m3].mean()
            gg = gpt_aligned[:, :, c][m3].mean()
            gpt_aligned[:, :, c] = np.clip(gpt_aligned[:, :, c].astype(np.float32)
                                           + (og - gg) * 0.35, 0, 255).astype(np.uint8)

    m = maskf[:, :, None]
    comp = (orig.astype(np.float32) * (1 - m) + gpt_aligned.astype(np.float32) * m).astype(np.uint8)

    dest = os.path.join(out_dir, 'gpt_composite.jpg')
    Image.fromarray(comp[:, :, ::-1]).save(dest, quality=94)
    # Side-by-side original | composite for review.
    sxs = np.concatenate([orig, np.full((H, 8, 3), 20, np.uint8), comp], axis=1)
    Image.fromarray(sxs[:, :, ::-1]).save(os.path.join(out_dir, 'gpt_composite_sxs.jpg'), quality=90)
    for t in (tmp_o, tmp_g):
        try: os.remove(t)
        except OSError: pass
    print(f'✓ {dest}')


if __name__ == '__main__':
    main()
