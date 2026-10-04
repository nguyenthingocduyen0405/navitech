"""Create .env from .env.example with fresh random secrets. Refuses to overwrite an existing .env."""

import secrets
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
target = root / ".env"
if target.exists():
    sys.exit(".env already exists — delete it first if you really want new secrets (this breaks existing data).")

text = (root / ".env.example").read_text(encoding="utf-8")
while "__GENERATE_SHORT__" in text:
    text = text.replace("__GENERATE_SHORT__", secrets.token_urlsafe(12), 1)
while "__GENERATE__" in text:
    text = text.replace("__GENERATE__", secrets.token_urlsafe(32), 1)

target.write_text(text, encoding="utf-8")
target.chmod(0o600)
print(f"wrote {target}")
