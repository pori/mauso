"""Edits an existing ChatImage (a prior generate_image/edit_image result, or
one the user uploaded) using a text instruction, via ComfyUI. Builds the
FLUX.2 Klein 9B Distilled *image-edit* workflow this host's ComfyUI has
weights for: the source image is scaled to ~1MP, VAE-encoded, and the edit
instruction is wired in via ReferenceLatent conditioning (not a classic
partial-denoise img2img KSampler) -- the negative conditioning side is a
zeroed-out copy of the same encode, per the exported workflow, so there's no
separate negative-prompt input and no "denoise strength" knob for this
model; steps/cfg are fixed at the values the distilled model expects.

Same model-filename notes as image_gen.py apply (CLIP/VAE fixed, UNET
overridable via the Settings page).
"""
import uuid

from sqlalchemy.orm import Session

from . import comfy_common
from ..chat_images import read_chat_image_bytes, store_chat_image
from ..models import ChatImage
from .image_gen import CLIP_NAME, DEFAULT_UNET, VAE_NAME


def _build_graph(unet_name: str, loaded_filename: str, prompt: str) -> dict:
    seed = uuid.uuid4().int & 0xFFFFFFFF
    return {
        "1": {"class_type": "LoadImage", "inputs": {"image": loaded_filename}},
        "2": {
            "class_type": "ImageScaleToTotalPixels",
            "inputs": {"upscale_method": "nearest-exact", "megapixels": 1, "resolution_steps": 1, "image": ["1", 0]},
        },
        "3": {"class_type": "GetImageSize", "inputs": {"image": ["2", 0]}},
        "4": {"class_type": "UNETLoader", "inputs": {"unet_name": unet_name, "weight_dtype": "default"}},
        "5": {"class_type": "CLIPLoader", "inputs": {"clip_name": CLIP_NAME, "type": "flux2", "device": "default"}},
        "6": {"class_type": "VAELoader", "inputs": {"vae_name": VAE_NAME}},
        "7": {"class_type": "VAEEncode", "inputs": {"pixels": ["2", 0], "vae": ["6", 0]}},
        "8": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["5", 0]}},
        "9": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["8", 0]}},
        "10": {"class_type": "ReferenceLatent", "inputs": {"conditioning": ["8", 0], "latent": ["7", 0]}},
        "11": {"class_type": "ReferenceLatent", "inputs": {"conditioning": ["9", 0], "latent": ["7", 0]}},
        "12": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "13": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "14": {"class_type": "Flux2Scheduler", "inputs": {"steps": 4, "width": ["3", 0], "height": ["3", 1]}},
        "15": {
            "class_type": "CFGGuider",
            "inputs": {"cfg": 1, "model": ["4", 0], "positive": ["10", 0], "negative": ["11", 0]},
        },
        "16": {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise": ["12", 0], "guider": ["15", 0], "sampler": ["13", 0],
                "sigmas": ["14", 0], "latent_image": ["7", 0],
            },
        },
        "17": {"class_type": "VAEDecode", "inputs": {"samples": ["16", 0], "vae": ["6", 0]}},
        "18": {"class_type": "SaveImage", "inputs": {"filename_prefix": "mauso_edit", "images": ["17", 0]}},
    }


async def run(args: dict, db: Session, comfyui_checkpoint: str) -> dict:
    source_image_id = args.get("source_image_id")
    prompt = (args.get("prompt") or "").strip()

    if not source_image_id:
        return {"error": "No source_image_id given -- reference a prior generate_image/edit_image result's id, or an uploaded image's id."}
    if not prompt:
        return {"error": "No edit instruction given."}

    try:
        source_id = int(source_image_id)
    except (TypeError, ValueError):
        return {"error": f"source_image_id must be a number, got: {source_image_id!r}"}

    source = db.get(ChatImage, source_id)
    if not source:
        return {"error": f"No image with id {source_id} found in this conversation."}

    unet_name = comfyui_checkpoint.strip() if comfyui_checkpoint else DEFAULT_UNET
    try:
        uploaded_filename = await comfy_common.upload_source_image(
            f"mauso_source_{source.id}.png", source.content_type, read_chat_image_bytes(source),
        )
        graph = _build_graph(unet_name, uploaded_filename, prompt)
        image_bytes = await comfy_common.submit_and_wait(graph)
    except comfy_common.ComfyUIError as e:
        return {"error": str(e)}

    record = store_chat_image(db, image_bytes, "image/png", prompt=prompt, source="edited")
    return {
        "image_id": record.id, "image_url": f"/api/chat-images/{record.id}",
        "prompt": prompt, "source_image_id": source.id,
    }
