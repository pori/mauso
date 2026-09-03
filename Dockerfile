# Base image is pinned to Google's public Docker Hub pull-through mirror
# rather than a bare `python:3.12-slim` (docker.io) tag: some build
# environments here have Docker Hub's CDN egress-blocked, and mirror.gcr.io
# is reachable where docker.io isn't. It serves the identical upstream
# image. See tests/test_dockerfile.py.
FROM mirror.gcr.io/library/python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
