"""Run once to pre-download SDXL base + ControlNet + dental LoRA into the persistent volume."""
import modal

volume = modal.Volume.from_name("dental-lora-weights", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("numpy<2")
    .pip_install(
        "torch==2.1.2",
        "torchvision==0.16.2",
        extra_index_url="https://download.pytorch.org/whl/cu118",
    )
    .pip_install(
        "diffusers==0.27.2",
        "transformers==4.38.2",
        "accelerate==0.27.2",
        "huggingface-hub==0.21.4",
        "safetensors==0.4.2",
        "Pillow==10.2.0",
    )
)

app = modal.App("dental-lora-downloader", image=image)

WEIGHTS_PATH      = "/weights"
SDXL_BASE_ID      = "stabilityai/stable-diffusion-xl-base-1.0"
CONTROLNET_ID     = "diffusers/controlnet-canny-sdxl-1.0"
LORA_REPO_ID      = "drdonelson/dental-lora"
LORA_FILENAME     = "dental-lora.safetensors"


@app.function(
    gpu="A10G",
    volumes={WEIGHTS_PATH: volume},
    timeout=900,
)
def download_weights():
    import os
    import shutil
    import torch
    from diffusers import StableDiffusionXLPipeline, ControlNetModel
    from huggingface_hub import hf_hub_download

    sdxl_path       = f"{WEIGHTS_PATH}/sdxl-base"
    controlnet_path = f"{WEIGHTS_PATH}/controlnet-canny-sdxl"
    lora_path       = f"{WEIGHTS_PATH}/lora/{LORA_FILENAME}"
    ready_marker    = f"{WEIGHTS_PATH}/.controlnet-v1-ready"

    # SDXL base must be saved via StableDiffusionXLPipeline so model_index.json
    # is compatible with StableDiffusionXLControlNetInpaintPipeline.from_pretrained().
    if not os.path.exists(ready_marker):
        print("Downloading SDXL base with correct class (~7GB)...")
        if os.path.exists(sdxl_path):
            shutil.rmtree(sdxl_path)
        pipe = StableDiffusionXLPipeline.from_pretrained(
            SDXL_BASE_ID,
            torch_dtype=torch.float16,
            variant="fp16",
            use_safetensors=True,
        )
        pipe.save_pretrained(sdxl_path, safe_serialization=True)
        del pipe
        with open(ready_marker, "w") as f:
            f.write("controlnet-v1")
        volume.commit()
        print("SDXL base saved.")
    else:
        print("SDXL base already present (controlnet-v1 marker found).")

    if not os.path.exists(f"{controlnet_path}/config.json"):
        print("Downloading ControlNet canny SDXL (~1.5GB)...")
        controlnet = ControlNetModel.from_pretrained(
            CONTROLNET_ID,
            torch_dtype=torch.float16,
        )
        controlnet.save_pretrained(controlnet_path)
        del controlnet
        volume.commit()
        print("ControlNet saved.")
    else:
        print("ControlNet already present.")

    if not os.path.isfile(lora_path):
        print("Downloading dental LoRA...")
        os.makedirs(f"{WEIGHTS_PATH}/lora", exist_ok=True)
        if os.path.lexists(lora_path):
            os.unlink(lora_path)
        cached = hf_hub_download(
            repo_id=LORA_REPO_ID,
            filename=LORA_FILENAME,
        )
        shutil.copy2(os.path.realpath(cached), lora_path)
        volume.commit()
        print(f"LoRA saved ({os.path.getsize(lora_path)/1e6:.0f} MB).")
    else:
        print(f"LoRA already present ({os.path.getsize(lora_path)/1e6:.0f} MB).")

    print("Volume contents:")
    for root, dirs, files in os.walk(WEIGHTS_PATH):
        for f in files:
            full = os.path.join(root, f)
            try:
                size_mb = os.path.getsize(full) / 1e6
                print(f"  {full} ({size_mb:.1f} MB)")
            except OSError:
                print(f"  {full} (broken symlink or unreadable)")

    print("Done.")


@app.local_entrypoint()
def main():
    download_weights.remote()
