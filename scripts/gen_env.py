""".env.example을 바탕으로 새 무작위 시크릿이 들어간 .env를 만듭니다. 기존 .env는 덮어쓰지 않습니다."""

import base64
import secrets
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
target = root / ".env"
if target.exists():
    sys.exit(".env가 이미 있습니다 — 정말 시크릿을 새로 만들려면 먼저 삭제하세요 (기존 데이터를 쓸 수 없게 됩니다).")

text = (root / ".env.example").read_text(encoding="utf-8")
while "__GENERATE_KEY32__" in text:  # AES-256 키: 32바이트, 표준 base64
    text = text.replace("__GENERATE_KEY32__", base64.b64encode(secrets.token_bytes(32)).decode(), 1)
while "__GENERATE_SHORT__" in text:
    text = text.replace("__GENERATE_SHORT__", secrets.token_urlsafe(12), 1)
while "__GENERATE__" in text:
    text = text.replace("__GENERATE__", secrets.token_urlsafe(32), 1)

target.write_text(text, encoding="utf-8")
target.chmod(0o600)
print(f"생성 완료: {target}")
