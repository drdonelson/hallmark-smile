#!/bin/bash
# Symlink models from network volume into ComfyUI's checkpoints directory
VOLUME_CKPT="/runpod-volume/models/checkpoints"
COMFY_CKPT="/comfyui/models/checkpoints"

if [ -d "$VOLUME_CKPT" ]; then
  mkdir -p "$COMFY_CKPT"
  for f in "$VOLUME_CKPT"/*.safetensors "$VOLUME_CKPT"/*.ckpt; do
    [ -f "$f" ] && ln -sf "$f" "$COMFY_CKPT/" 2>/dev/null || true
  done
  echo "Linked models: $(ls $COMFY_CKPT)"
else
  echo "WARNING: $VOLUME_CKPT not found — no models available"
fi

# Hand off to the original runpod startup script
exec /start.sh "$@"
