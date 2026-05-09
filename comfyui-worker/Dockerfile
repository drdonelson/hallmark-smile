FROM runpod/worker-comfyui:5.8.5-base

# Copy dental inpainting workflow as the default
COPY workflow_api.json /workflow_api.json

# Startup wrapper: symlink network-volume models into ComfyUI's path before launch
COPY start.sh /start-hallmark.sh
RUN chmod +x /start-hallmark.sh
ENTRYPOINT ["/start-hallmark.sh"]
