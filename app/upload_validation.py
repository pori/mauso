"""Cheap magic-byte sniffing for user-supplied uploads, on top of the
Content-Type header the client (or a fetched remote server) claims. A
browser field, curl, or a remote HTTP response can set Content-Type to
anything regardless of the actual bytes, so routers/files.py and
routers/images.py use these to check the bytes actually look like what
they claim to be before storing/parsing them.

Deliberately not using the stdlib `imghdr` module: it's deprecated since
3.11 and removed in 3.13, so the signatures are inlined here instead.
"""

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_JPEG_SIGNATURE = b"\xff\xd8\xff"
_GIF_SIGNATURES = (b"GIF87a", b"GIF89a")
PDF_SIGNATURE = b"%PDF-"


def sniff_image_type(data: bytes) -> str | None:
    """Returns the detected image mime type from magic bytes, or None if
    the data doesn't match any supported image signature."""
    if data.startswith(_PNG_SIGNATURE):
        return "image/png"
    if data.startswith(_JPEG_SIGNATURE):
        return "image/jpeg"
    if data.startswith(_GIF_SIGNATURES):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def is_valid_image(data: bytes) -> bool:
    return sniff_image_type(data) is not None


def is_valid_pdf(data: bytes) -> bool:
    return data.startswith(PDF_SIGNATURE)


def looks_binary(data: bytes) -> bool:
    """Heuristic for "this isn't actually a text file" -- a NUL byte
    doesn't appear in valid UTF-8/ASCII text, so its presence in the
    first chunk is a reliable enough tell for rejecting mislabeled binary
    uploads without needing a full encoding-detection library."""
    return b"\x00" in data[:8192]
