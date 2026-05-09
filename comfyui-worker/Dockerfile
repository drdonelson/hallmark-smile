FROM runpod/worker-comfyui:3.1.0-base

# Copy dental inpainting workflow as the default
COPY workflow_api.json /workflow_api.json

# Download Dreamshaper 8 Inpainting model at build time
# (~2GB — baked into image so cold starts are fast)
RUN wget -q -O /comfyui/models/checkpoints/dreamshaper_8Inpainting.inpainting.safetensors \
    "https://huggingface.co/Lykon/dreamshaper-8-inpainting/resolve/main/dreamshaper_8Inpainting.inpainting.safetensors"
