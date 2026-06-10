#!/usr/bin/env python3
"""Native MediaPipe face landmarks for the test harness.

Uses the same face_landmarker.task model as production (smile-simulator.html
loads it from the MediaPipe CDN). Headless Chromium can't create the WebGL
context MediaPipe's wasm build requires, so the harness computes landmarks
here instead and the browser page builds the identical INNER_LIP mask from
the returned normalized coordinates.

Usage: landmarks.py <image_path> <model_path>
Prints JSON: {"landmarks": [{"x":..,"y":..}, ... 478 pts]} or {"error": "..."}
"""
import sys, json
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision


def main():
    img_path, model_path = sys.argv[1], sys.argv[2]
    image = mp.Image.create_from_file(img_path)
    options = vision.FaceLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=model_path),
        running_mode=vision.RunningMode.IMAGE,
        num_faces=1,
    )
    with vision.FaceLandmarker.create_from_options(options) as landmarker:
        res = landmarker.detect(image)
    if not res.face_landmarks:
        print(json.dumps({"error": "no face detected"}))
        return
    pts = [{"x": p.x, "y": p.y} for p in res.face_landmarks[0]]
    print(json.dumps({"landmarks": pts}))


if __name__ == "__main__":
    main()
