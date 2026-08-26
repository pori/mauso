"""Shared ComfyUI plumbing used by both generate_image and edit_image:
uploading a source image into ComfyUI's input dir, and submit-a-graph/
poll-for-output. Split out once edit_image needed the same submit+poll
logic generate_image already had -- not speculative reuse."""
import asyncio

import httpx

from ..config import settings


class ComfyUIError(Exception):
    pass


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=settings.comfyui_base_url, timeout=settings.comfyui_timeout_seconds)


async def upload_source_image(filename: str, content_type: str, data: bytes) -> str:
    """Uploads bytes into ComfyUI's input directory; returns the filename a
    LoadImage node should reference."""
    async with _client() as client:
        try:
            resp = await client.post(
                "/upload/image",
                files={"image": (filename, data, content_type or "application/octet-stream")},
                data={"overwrite": "true"},
            )
        except httpx.RequestError as e:
            raise ComfyUIError(f"Could not reach ComfyUI at {settings.comfyui_base_url}: {e}") from e
    if resp.status_code != 200:
        raise ComfyUIError(f"ComfyUI upload failed: HTTP {resp.status_code}: {resp.text[:500]}")
    return resp.json()["name"]


async def submit_and_wait(graph: dict, timeout_polls: int | None = None) -> bytes:
    """Submits a workflow graph, polls until the first output image appears,
    and returns its raw bytes. Default timeout is settings.comfyui_timeout_seconds
    at 1s/poll -- the FLUX.2 Klein 9B workflow can take a few minutes,
    especially on a cold model load."""
    if timeout_polls is None:
        timeout_polls = int(settings.comfyui_timeout_seconds)
    async with _client() as client:
        try:
            resp = await client.post("/prompt", json={"prompt": graph})
        except httpx.RequestError as e:
            raise ComfyUIError(f"Could not reach ComfyUI at {settings.comfyui_base_url}: {e}") from e
    if resp.status_code != 200:
        raise ComfyUIError(f"ComfyUI /prompt failed: HTTP {resp.status_code}: {resp.text[:500]}")
    data = resp.json()
    prompt_id = data.get("prompt_id")
    if not prompt_id:
        raise ComfyUIError(f"ComfyUI response missing prompt_id: {data}")

    async with _client() as client:
        for _ in range(timeout_polls):
            await asyncio.sleep(1)
            hist_resp = await client.get(f"/history/{prompt_id}")
            if hist_resp.status_code != 200:
                continue
            entry = hist_resp.json().get(prompt_id)
            if not entry:
                continue
            outputs = entry.get("outputs", {})
            for node_out in outputs.values():
                images = node_out.get("images") or []
                if images:
                    img = images[0]
                    view_resp = await client.get("/view", params={
                        "filename": img["filename"],
                        "subfolder": img.get("subfolder", ""),
                        "type": img.get("type", "output"),
                    })
                    if view_resp.status_code != 200:
                        raise ComfyUIError(f"ComfyUI /view failed: HTTP {view_resp.status_code}")
                    return view_resp.content
            status = entry.get("status", {})
            if status.get("completed") is False and status.get("messages"):
                for msg in status["messages"]:
                    if isinstance(msg, list) and msg and msg[0] == "execution_error":
                        raise ComfyUIError("ComfyUI reported an execution error for this prompt.")
    raise ComfyUIError("Timed out waiting for ComfyUI to finish.")
