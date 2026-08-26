"""One-time migration: encrypts any ChatImage rows written before at-rest
encryption was added to chat_images.store_chat_image (see that module and
crypto.py). New rows are always encrypted going forward -- this is only for
rows that predate that change, which read_chat_image_bytes() otherwise
serves as legacy plaintext indefinitely rather than migrating on read.

Safe to re-run: a row already holding a valid Fernet token is left alone.

Run inside the container:
    docker compose exec mauso python3 -m app.migrate_encrypt_images
"""
from cryptography.fernet import InvalidToken

from . import crypto
from .db import SessionLocal
from .models import ChatImage


def main() -> None:
    db = SessionLocal()
    try:
        rows = db.query(ChatImage).all()
        migrated = 0
        for row in rows:
            try:
                crypto.decrypt_bytes(row.data)
                continue  # already a valid Fernet token -- nothing to do
            except InvalidToken:
                pass
            row.data = crypto.encrypt_bytes(row.data)
            migrated += 1
        db.commit()
        print(f"Encrypted {migrated} of {len(rows)} chat_image row(s); {len(rows) - migrated} were already encrypted.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
