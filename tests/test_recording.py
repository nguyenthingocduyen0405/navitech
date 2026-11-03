"""회의 관제에서 녹음 받기 (gateway/recording.py): 받아쓰기는 speech-service로, 회의록 초안은 회의지원 Agent에게 — 진행을 한 줄씩."""

import json

import httpx
from fastapi.testclient import TestClient

from agents.base import AgentEvent
from gateway.audit import MemoryAuditLog
from gateway.main import create_app
from gateway.settings import Settings
from test_desk import TOKENS
from test_gateway import API_KEY, JWT_SECRET, PERMISSIONS_FILE, FakeDirectory

TRANSCRIPT = "[transcript_id: TR-20261103-ABC123]\n(안내)\n[00:00] 김민수 (CEO): 시작하겠습니다.\n[00:05] 박지훈 (CFO): 네.\n[00:09] 김민수 (CEO): 마치겠습니다."


class Speech:
    def __init__(self):
        self.calls = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "open-webui":
            token = request.headers.get("authorization", "").removeprefix("Bearer ")
            if token not in TOKENS:
                return httpx.Response(401, json={"detail": "Not authenticated"})
            return httpx.Response(200, json={"email": TOKENS[token], "name": "사용자"})
        self.calls.append((request.url.path, request.headers.get("authorization"), request.content))
        return httpx.Response(200, json={"text": TRANSCRIPT, "transcript_id": "TR-20261103-ABC123", "duration": 12.4})


class MeetingAgent:
    def __init__(self):
        self.tasks = []

    async def run(self, messages, ctx, task=None):
        self.tasks.append(task)
        yield AgentEvent.status("회의지원 Agent: 녹음 변환본 교정 중 (3줄)")
        yield AgentEvent.text("회의록 초안 저장: MTG-2026-11-03-02")


def app_with(speech, agent, audit):
    agents = {a: agent for a in ("super-agent", "news-agent", "advisory-agent", "meeting-agent")}
    settings = Settings(
        backend_api_key=API_KEY, owui_jwt_secret=JWT_SECRET, permissions_file=str(PERMISSIONS_FILE),
        app_database_url="unused", keycloak_url="unused", keycloak_realm="capstone", keycloak_client_id="gateway",
        keycloak_client_secret="unused", agent_backend_url="http://agents-group:8001", principal_signing_key="s" * 40,
        public_url="https://navitech.example", speech_service_url="http://speech-service:8000", speech_api_key="speech-key",
    )
    return create_app(settings, directory=FakeDirectory(), audit=audit, agents=agents, desk_transport=httpx.MockTransport(speech.handler))


def test_a_recording_dropped_on_a_meeting_is_transcribed_then_written_up():
    speech, agent, audit = Speech(), MeetingAgent(), MemoryAuditLog()
    with TestClient(app_with(speech, agent, audit)) as client:
        assert client.post("/meetings/api/recording/transcribe", content=b"RIFF....").status_code == 401
        resp = client.post("/meetings/api/recording/transcribe?meeting_id=MTG-2026-11-03-02", content=b"RIFFfake",
                           headers={"Authorization": "Bearer t-secretary", "X-Filename": "%EC%8B%A0%EC%A0%9C%ED%92%88.wav"})
        assert resp.status_code == 200
        out = resp.json()
        assert out["transcript_id"] == "TR-20261103-ABC123" and out["seconds"] == 12 and out["lines"] == 3
        assert out["speakers"] == ["김민수 (CEO)", "박지훈 (CFO)"]
        path, auth, body = speech.calls[0]
        assert path == "/v1/audio/transcriptions" and auth == "Bearer speech-key" and b"RIFFfake" in body and "신제품.wav".encode() in body

        stream = client.post("/meetings/api/recording/minutes", headers={"Authorization": "Bearer t-secretary"},
                             json={"meeting_id": "MTG-2026-11-03-02", "filename": "신제품.wav", "text": out["text"]})
        events = [json.loads(line) for line in stream.text.splitlines() if line.strip()]
        assert [e["type"] for e in events] == ["status", "text", "done"]
        assert agent.tasks[0].startswith("회의 녹음 파일을 올렸습니다.") and "회의: MTG-2026-11-03-02" in agent.tasks[0]
        assert "[첨부 파일 내용]\n[transcript_id: TR-20261103-ABC123]" in agent.tasks[0]
        bad = client.post("/meetings/api/recording/minutes", headers={"Authorization": "Bearer t-secretary"},
                          json={"meeting_id": "x; drop", "text": "t"})
        assert bad.status_code == 400
    assert any("[회의 관제] 녹음 받기" in e.query for e in audit.entries)


def test_only_meeting_agent_users_may_drop_recordings():
    speech, agent, audit = Speech(), MeetingAgent(), MemoryAuditLog()
    with TestClient(app_with(speech, agent, audit)) as client:
        resp = client.post("/meetings/api/recording/transcribe", content=b"RIFF", headers={"Authorization": "Bearer t-nogroup"})
        assert resp.status_code == 403 and not speech.calls
