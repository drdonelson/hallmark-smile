import io
import base64
import time

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
        "fastapi[standard]==0.115.0",
        "peft==0.9.0",
        "opencv-python-headless",
    )
)

app = modal.App("dental-lora", image=image)

WEIGHTS_PATH      = "/weights"
SDXL_BASE_ID      = "stabilityai/stable-diffusion-xl-base-1.0"
CONTROLNET_ID     = "diffusers/controlnet-canny-sdxl-1.0"
LORA_REPO_ID      = "drdonelson/dental-lora"
LORA_FILENAME     = "dental-lora.safetensors"


@app.cls(
    gpu="A10G",
    volumes={WEIGHTS_PATH: volume},
    timeout=600,
    scaledown_window=300,
    min_containers=1,
)
class DentalModel:

    @modal.enter()
    def load_model(self):
        import os
        from diffusers import StableDiffusionXLControlNetInpaintPipeline, ControlNetModel
        from huggingface_hub import hf_hub_download
        import torch

        sdxl_path       = f"{WEIGHTS_PATH}/sdxl-base"
        controlnet_path = f"{WEIGHTS_PATH}/controlnet-canny-sdxl"
        lora_path       = f"{WEIGHTS_PATH}/lora/{LORA_FILENAME}"
        # Marker written by download_weights.py after saving SDXL via the base
        # pipeline class — ensures the model_index.json is compatible with
        # StableDiffusionXLControlNetInpaintPipeline.from_pretrained().
        ready_marker    = f"{WEIGHTS_PATH}/.controlnet-v1-ready"

        # Re-download SDXL base if it was saved under the old img2img class
        if not os.path.exists(ready_marker):
            print("First ControlNet run: downloading SDXL base with correct class (~7GB)...")
            import shutil
            if os.path.exists(sdxl_path):
                shutil.rmtree(sdxl_path)
            from diffusers import StableDiffusionXLPipeline
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

        if not os.path.exists(lora_path):
            print("Downloading dental LoRA...")
            os.makedirs(f"{WEIGHTS_PATH}/lora", exist_ok=True)
            hf_hub_download(
                repo_id=LORA_REPO_ID,
                filename=LORA_FILENAME,
                local_dir=f"{WEIGHTS_PATH}/lora",
            )
            volume.commit()
            print("LoRA saved.")

        print("Loading ControlNet...")
        controlnet = ControlNetModel.from_pretrained(
            controlnet_path,
            torch_dtype=torch.float16,
            local_files_only=True,
        )

        print("Loading pipeline...")
        self.pipe = StableDiffusionXLControlNetInpaintPipeline.from_pretrained(
            sdxl_path,
            controlnet=controlnet,
            torch_dtype=torch.float16,
            local_files_only=True,
            use_safetensors=True,
        ).to("cuda")

        print("Loading dental LoRA...")
        self.pipe.load_lora_weights(lora_path, adapter_name="dental")
        self.pipe.set_adapters(["dental"], adapter_weights=[0.8])
        self.pipe.enable_attention_slicing()
        print("Model ready.")

    @modal.fastapi_endpoint(method="POST")
    def inpaint(self, body: dict):
        from PIL import Image
        import torch
        import cv2
        import numpy as np

        def b64_to_pil(s, mode="RGB"):
            if "," in s:
                s = s.split(",")[1]
            return Image.open(io.BytesIO(base64.b64decode(s))).convert(mode)

        image_pil = b64_to_pil(body["image"], "RGB")
        mask_pil  = b64_to_pil(body["mask"],  "L")

        prompt = body.get("prompt", (
            "photorealistic cosmetic dentistry result photo. "
            "Open smile, mouth open, upper and lower teeth fully visible. "
            "Upper teeth whitened to BL1 bright natural white. "
            "Every tooth individually defined with visible dark inter-dental "
            "embrasures and shadows between each tooth. "
            "Golden proportion tooth widths: central incisors widest, lateral "
            "incisors slightly narrower, canines tapered. Ovoid tooth shape. "
            "Smooth incisal edges with subtle natural translucency at tips. "
            "Realistic enamel surface: fine perikymata texture, natural "
            "micro-variation, slight gloss highlights. "
            "Healthy pink gingival scalloping at each tooth's emergence profile. "
            "Correct midline alignment. "
            "Lips, skin, face, and smile width identical to original. "
            "Clinical cosmetic dental photography, authentic before-and-after."
        ))
        neg_prompt = body.get("negative_prompt", (
            "closed mouth, closed lips, no teeth showing, mouth closed, "
            "yellow teeth, stained teeth, discolored teeth, "
            "uniform white slab, fused teeth, no embrasures, plastic texture, "
            "artificial glow, flat brightness, cartoon, denture plate, "
            "altered lips, altered skin, altered face, wider smile, "
            "different smile width, more teeth showing, changed mouth shape, "
            "tongue, open throat, blurry, low quality"
        ))

        steps            = int(body.get("steps", 30))
        guidance         = float(body.get("guidance_scale", 7.5))
        # strength near 1.0: fully regenerate the masked tooth region.
        # ControlNet edge conditioning handles structure preservation so we
        # don't need to hold back strength to protect tooth positions.
        strength         = float(body.get("strength", 0.99))
        # controlnet_conditioning_scale 0.7-0.9: strong edge guidance so the
        # generated teeth follow the patient's existing tooth boundaries.
        controlnet_scale = float(body.get("controlnet_conditioning_scale", 0.8))
        lora_scale       = float(body.get("lora_scale", 0.8))
        seed             = body.get("seed")

        orig_w, orig_h = image_pil.size
        scale = min(1024 / orig_w, 1024 / orig_h, 1.0)
        new_w = max(512, round(orig_w * scale / 64) * 64)
        new_h = max(512, round(orig_h * scale / 64) * 64)
        image_pil = image_pil.resize((new_w, new_h), Image.LANCZOS)
        mask_pil  = mask_pil.resize((new_w, new_h), Image.LANCZOS)

        # Extract canny edges from the original image for ControlNet conditioning.
        # CRITICAL: blank the canny signal inside the mask region.
        # Patients with missing or severely damaged teeth have no usable edge
        # structure inside the mask — ControlNet would condition on garbage edges
        # (dark gaps, broken stumps) and the model generates a closed mouth.
        # By zeroing edges inside the mask, ControlNet only guides face structure
        # outside the mask; the LoRA + prompt have full control over tooth generation.
        img_gray   = np.array(image_pil.convert("L"))
        edges      = cv2.Canny(img_gray, 50, 150)
        mask_array = np.array(mask_pil)   # L mode: 255=edit zone, 0=preserve
        edges[mask_array > 128] = 0
        control_image = Image.fromarray(
            np.stack([edges, edges, edges], axis=-1)
        )

        self.pipe.set_adapters(["dental"], adapter_weights=[lora_scale])

        generator = torch.Generator("cuda")
        generator.manual_seed(int(seed) if seed else int(time.time()) % (2**32))

        result = self.pipe(
            prompt=prompt,
            negative_prompt=neg_prompt,
            image=image_pil,
            mask_image=mask_pil,
            control_image=control_image,
            num_inference_steps=steps,
            guidance_scale=guidance,
            strength=strength,
            controlnet_conditioning_scale=controlnet_scale,
            generator=generator,
        ).images[0]

        buf = io.BytesIO()
        result.save(buf, format="PNG")
        return {"image": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()}
