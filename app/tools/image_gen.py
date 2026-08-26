"""Image generation via the shared ComfyUI instance on the homellm network
(same host/service the `stills` stack talks to). Builds the FLUX.2 Klein 9B
Distilled text-to-image workflow this host's ComfyUI actually has weights
for (UNETLoader + CLIPLoader(type=flux2) + VAELoader, RandomNoise/CFGGuider/
SamplerCustomAdvanced rather than a plain KSampler) -- mirrors the workflow
graph exported from ComfyUI for this exact model, not a generic checkpoint
graph.

The CLIP and VAE filenames are fixed companions of this specific model
family (not independently swappable), so they're hardcoded. The UNET
filename can still be overridden via the Settings page's "ComfyUI
checkpoint" field if this host's model layout changes.
"""
import uuid

from sqlalchemy.orm import Session

from . import comfy_common
from ..chat_images import store_chat_image

DEFAULT_UNET = "flux-2-klein-9b-fp8.safetensors"
CLIP_NAME = "qwen_3_8b_fp8mixed.safetensors"
VAE_NAME = "full_encoder_small_decoder.safetensors"
DEFAULT_WIDTH = 1024
DEFAULT_HEIGHT = 1024


def _build_graph(unet_name: str, prompt: str, negative_prompt: str) -> dict:
    seed = uuid.uuid4().int & 0xFFFFFFFF
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": unet_name, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": CLIP_NAME, "type": "flux2", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE_NAME}},
        "4": {
            "class_type": "EmptyFlux2LatentImage",
            "inputs": {"width": DEFAULT_WIDTH, "height": DEFAULT_HEIGHT, "batch_size": 1},
        },
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": negative_prompt or "", "clip": ["2", 0]}},
        "7": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "8": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "9": {"class_type": "Flux2Scheduler", "inputs": {"steps": 20, "width": DEFAULT_WIDTH, "height": DEFAULT_HEIGHT}},
        "10": {
            "class_type": "CFGGuider",
            "inputs": {"cfg": 5, "model": ["1", 0], "positive": ["5", 0], "negative": ["6", 0]},
        },
        "11": {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise": ["7", 0], "guider": ["10", 0], "sampler": ["8", 0],
                "sigmas": ["9", 0], "latent_image": ["4", 0],
            },
        },
        "12": {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["3", 0]}},
        "13": {"class_type": "SaveImage", "inputs": {"filename_prefix": "mauso", "images": ["12", 0]}},
    }


async def run(args: dict, db: Session, comfyui_checkpoint: str) -> dict:
    prompt = (args.get("prompt") or "").strip()
    negative_prompt = (args.get("negative_prompt") or "").strip()
    if not prompt:
        return {"error": "No prompt given."}

    unet_name = comfyui_checkpoint.strip() if comfyui_checkpoint else DEFAULT_UNET
    graph = _build_graph(unet_name, prompt, negative_prompt)
    try:
        image_bytes = await comfy_common.submit_and_wait(graph)
    except comfy_common.ComfyUIError as e:
        return {"error": str(e)}

    record = store_chat_image(db, image_bytes, "image/png", prompt=prompt, source="generated")
    return {"image_id": record.id, "image_url": f"/api/chat-images/{record.id}", "prompt": prompt}
