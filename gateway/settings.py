import os
from dataclasses import dataclass

MIN_SECRET_LENGTH = 32


def _required(name: str, min_length: int = 1) -> str:
    value = os.environ.get(name, "").strip()
    if len(value) < min_length:
        raise RuntimeError(f"환경 변수 {name}이(가) 없거나 {min_length}자보다 짧습니다")
    return value


def _optional(name: str, min_length: int) -> str:
    value = os.environ.get(name, "").strip()
    if value and len(value) < min_length:
        raise RuntimeError(f"환경 변수 {name}이(가) {min_length}자보다 짧습니다")
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
    openwebui_internal_url: str = "http://open-webui:8080"  # 회의 업무 화면이 로그인 사용자를 묻는 곳 (gateway/desk.py)
    principal_signing_key: str = ""  # backend와 공유: 요청자(principal)를 서명해 보냄 (runtime/principal.py)
    internal_api_key: str = ""  # backend → gateway 내부 API(/internal/…)용 키. 비우면 내부 API를 열지 않음
    public_url: str = ""  # 사용자가 여는 주소 (예: https://jbnunavitech.me:17227) — 출석 QR이 가리키는 곳. 비우면 요청 주소
    speech_service_url: str = ""  # 목소리 구분 확인 화면이 녹음을 보내는 곳 (gateway/voice_check.py). 비우면 그 화면을 쓸 수 없음
    speech_api_key: str = ""  # = speech-service의 SPEECH_API_KEY
    checkin_enabled: bool = True  # CHECKIN_ENABLED=0: 출석 확인(QR)을 끔 — 채팅에 QR이 뜨지 않고 휴대폰 출석도 받지 않음
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
            openwebui_internal_url=os.environ.get("OPENWEBUI_INTERNAL_URL", "http://open-webui:8080").strip().rstrip("/"),
            principal_signing_key=_optional("PRINCIPAL_SIGNING_KEY", MIN_SECRET_LENGTH),
            internal_api_key=_optional("INTERNAL_API_KEY", MIN_SECRET_LENGTH),
            public_url=os.environ.get("PUBLIC_URL", "").strip().rstrip("/"),
            speech_service_url=os.environ.get("SPEECH_SERVICE_URL", "").strip().rstrip("/"),
            speech_api_key=os.environ.get("SPEECH_API_KEY", "").strip(),
            checkin_enabled=os.environ.get("CHECKIN_ENABLED", "1").strip().lower() not in ("0", "off", "false", "no"),
        )
