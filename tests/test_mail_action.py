"""메일로 진행 상황 알리기 (gateway/mail_action.py): 로그인 없이 버튼의 토큰으로 backend /api/mail-action."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from gateway.audit import MemoryAuditLog
from test_desk import Fake, desk_app

ITEM = {"id": "MTG-2026-10-28-01-A2", "text": "기업가치 산정 결과 공유", "status": "open", "status_label": "미착수",
        "due": "2026-11-01", "late_days": 3, "owner": "최재무", "meeting": {"id": "MTG-2026-10-28-01", "title": "뉴로엣지 실사 중간 점검",
                                                                        "date": "2026-10-28"}}


class Backend(Fake):
    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.path != "/api/mail-action":
            return super().handler(request)
        body = json.loads(request.content)
        self.backend.append((request.url.path, body))
        if body["token"] == "bad":
            return httpx.Response(200, json={"ok": False, "error": "링크가 올바르지 않습니다. 메일의 버튼을 다시 눌러 주세요."})
        if body.get("status") is None:
            return httpx.Response(200, json={"ok": True, "item": ITEM})
        if body["status"] == "blocked" and not body.get("note"):
            return httpx.Response(200, json={"ok": False, "item": ITEM, "error": "무엇 때문에 막혔는지 메모에 적어 주세요."})
        return httpx.Response(200, json={"ok": True, "changed": True, "owner_email": "cfo@example.com",
                                         "item": {**ITEM, "status": body["status"], "status_label": "완료"}})


@pytest.fixture
def act():
    fake, audit = Backend(), MemoryAuditLog()
    with TestClient(desk_app(fake, audit)) as client:
        yield client, fake, audit


def test_opening_the_link_only_shows_the_item(act):
    client, fake, audit = act
    page = client.get("/meetings/act/1.2.999.sig?s=done")  # 로그인 없이
    assert page.status_code == 200 and "기업가치 산정 결과 공유" in page.text and "3일 지남" in page.text
    assert 'value="done" checked' in page.text and page.headers["referrer-policy"] == "no-referrer"
    assert fake.backend == [("/api/mail-action", {"token": "1.2.999.sig"})] and audit.entries == []  # 아무것도 바꾸지 않음


def test_sending_the_form_reports_progress_and_is_audited(act):
    client, fake, audit = act
    resp = client.post("/meetings/act/1.2.999.sig", data={"s": "done", "note": "공유 완료"})
    assert resp.status_code == 200 and "완료 — 남겼습니다" in resp.text
    assert fake.backend[-1] == ("/api/mail-action", {"token": "1.2.999.sig", "status": "done", "note": "공유 완료"})
    assert audit.entries[-1].email == "cfo@example.com" and audit.entries[-1].query == "[메일 진행 보고] done MTG-2026-10-28-01-A2"


def test_blocked_without_a_reason_asks_again_keeping_the_choice(act):
    client, _, audit = act
    resp = client.post("/meetings/act/1.2.999.sig", data={"s": "blocked", "note": ""})
    assert "막혔는지" in resp.text and 'value="blocked" checked' in resp.text and audit.entries == []


def test_a_bad_link_says_why(act):
    client, _, _ = act
    page = client.get("/meetings/act/bad")
    assert page.status_code == 400 and "링크가 올바르지 않습니다" in page.text
