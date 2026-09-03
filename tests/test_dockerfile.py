"""Guards the Dockerfile base image.

`docker compose up -d --build` is how every change actually reaches the
running site (see CLAUDE.md), but some build environments have Docker Hub's
CDN egress-blocked. The base image is therefore pinned to Google's public
pull-through mirror (`mirror.gcr.io/library/...`), which serves the same
upstream image and is reachable where `docker.io` isn't. This test fails if
someone reverts to a bare Docker Hub tag.
"""
import re
from pathlib import Path

DOCKERFILE = Path(__file__).resolve().parent.parent / "Dockerfile"


def _from_lines():
    lines = []
    for raw in DOCKERFILE.read_text().splitlines():
        line = raw.strip()
        if line.upper().startswith("FROM "):
            lines.append(line)
    return lines


def test_dockerfile_has_a_single_from():
    assert len(_from_lines()) == 1, _from_lines()


def test_base_image_uses_gcr_mirror_not_bare_docker_hub():
    from_line = _from_lines()[0]
    image_ref = from_line.split()[1]

    assert image_ref.startswith("mirror.gcr.io/"), (
        f"Dockerfile base image {image_ref!r} must come from the "
        "mirror.gcr.io pull-through mirror, not Docker Hub -- Docker Hub's "
        "CDN is egress-blocked in some build environments here."
    )
    # A bare `python:3.12-slim` / `library/python:...` with no registry host
    # resolves against docker.io; that's exactly what we're avoiding.
    assert not re.match(r"^(library/)?python:", image_ref), image_ref
