import os
from dataclasses import dataclass

MIN_SECRET_LENGTH = 32


def _required(name: str, min_length: int = 1) -> str:
    value = os.environ.get(name, "").strip()
    if len(value) < min_length:
        raise RuntimeError(f"환경 변수 {name}이(가) 없거나 {min_length}자보다 짧습니다")
    return value


@dataclass(frozen=True)
class Settings:
    backend_api_key: str  # Open WebUI 연결 설정과 공유하는 API 키
    owui_jwt_secret: str  # = Open WebUI의 FORWARD_USER_INFO_HEADER_JWT_SECRET
    permissions_file: str
    app_database_url: str
    keycloak_url: str  # 내부 URL, 예: http://keycloak:8080
    keycloak_realm: str
    keycloak_client_id: str
    keycloak_client_secret: str
    agent_backend_url: str = ""  # 예: http://agents-group:8001 — 비어 있으면 mock Agent
    user_jwt_header: str = "X-OpenWebUI-User-Jwt"
    chat_id_header: str = "X-OpenWebUI-Chat-Id"

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            backend_api_key=_required("BACKEND_API_KEY", MIN_SECRET_LENGTH),
            owui_jwt_secret=_required("OWUI_FORWARD_JWT_SECRET", MIN_SECRET_LENGTH),
            permissions_file=os.environ.get("PERMISSIONS_FILE", "config/permissions.yaml"),
            app_database_url=_required("APP_DATABASE_URL"),
            keycloak_url=_required("KEYCLOAK_INTERNAL_URL"),
            keycloak_realm=os.environ.get("KEYCLOAK_REALM", "capstone"),
            keycloak_client_id=os.environ.get("GATEWAY_KC_CLIENT_ID", "gateway"),
            keycloak_client_secret=_required("GATEWAY_KC_CLIENT_SECRET"),
            agent_backend_url=os.environ.get("AGENT_BACKEND_URL", "").strip(),
        )
