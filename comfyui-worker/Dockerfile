FROM runpod/worker-comfyui:5.8.5-base

# Copy dental inpainting workflow as the default
COPY workflow_api.json /workflow_api.json

# Tell ComfyUI to also search the network volume for models
COPY extra_model_paths.yaml /comfyui/extra_model_paths.yaml
