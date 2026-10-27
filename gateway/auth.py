import secrets

import jwt

from gateway.directory import Directory
from gateway.permissions import Permissions
from shared.user_context import UserContext

OPENWEBUI_ISSUER = "open-webui"


class AuthError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def check_api_key(authorization: str | None, expected: str) -> None:
    """Backend API 키는 Open WebUI(와 우리 서비스)만 가지고 있습니다."""
    presented = (authorization or "").encode()
    if not secrets.compare_digest(presented, f"Bearer {expected}".encode()):
        raise AuthError(401, "API 키가 올바르지 않습니다.")


def verify_openwebui_jwt(token: str | None, secret: str) -> dict:
    """FORWARD_USER_INFO_HEADER_JWT_SECRET이 설정된 경우 Open WebUI가 보내는 HS256 JWT를 검증합니다.

    일반 X-OpenWebUI-User-* 헤더는 의도적으로 받지 않습니다:
    Gateway에 접근할 수 있는 누구나 위조할 수 있기 때문입니다.
    """
    if not token:
        raise AuthError(401, "사용자 토큰이 없습니다.")
    try:
        return jwt.decode(
            token,
            secret,
            algorithms=["HS256"],
            issuer=OPENWEBUI_ISSUER,
            options={"require": ["exp", "iat", "iss", "sub", "email"]},
        )
    except jwt.PyJWTError as exc:
        raise AuthError(401, f"사용자 토큰이 유효하지 않습니다: {exc}") from exc


async def build_user_context(
    claims: dict,
    directory: Directory,
    permissions: Permissions,
    chat_id: str | None = None,
) -> UserContext:
    email = claims["email"].strip().lower()
    entry = await directory.lookup(email)
    groups = entry.groups if entry else frozenset()
    clearance, agents = permissions.resolve(groups)
    return UserContext(
        email=email,
        name=entry.name if entry else claims.get("name", ""),
        groups=groups,
        clearance=clearance,
        allowed_agents=agents,
        chat_id=chat_id,
    )
