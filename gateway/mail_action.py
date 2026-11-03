"""메일로 진행 상황 알리기 (/meetings/act/<token>): 업무 배정 · 기한 알림 메일의 버튼(완료 · 진행 중 · 막힘)이 여는 화면.

로그인하지 않습니다. 버튼의 주소에 backend가 서명한 토큰(그 업무와 메일을 받은 담당자, 30일)이 들어 있고, 확인은
backend가 합니다 (library/workflows/mail_actions). 외부 자문위원처럼 회사 계정이 없는 담당자도 쓸 수 있게 하려는 것입니다.
주소를 여는 것(GET)은 업무를 보여 주기만 합니다 — 회사 메일의 보안 검사가 링크를 미리 열어 보기 때문에(RFC 8058의
원클릭 구독 취소와 같은 이유) 상태는 화면에서 '보내기'를 눌렀을 때(POST)만 바뀝니다. 보낸 것은 감사 로그에 남습니다.
"""

import html
import logging
from urllib.parse import parse_qs

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse

from gateway.audit import AuditEntry, AuditLog
from gateway.settings import Settings

log = logging.getLogger("gateway.mail_action")

TIMEOUT = httpx.Timeout(20.0, connect=5.0)
STATUSES = (("done", "완료했습니다", "ok"), ("in_progress", "진행 중입니다", "prog"), ("blocked", "막혔습니다", "warn"))
HEADERS = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex"}  # 토큰이 든 주소를 남기지 않음
PERMISSION = "meeting-agent"

STYLE = """
  :root { --bg:#f5f5f7; --card:#fff; --ink:#111827; --muted:#6b7280; --line:rgba(0,0,0,.09); --brand:#5b5bd6; --ok:#0f9d58; --warn:#c2410c; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#111113; --card:#1b1b1d; --ink:#f3f4f6; --muted:#9ca3af; --line:rgba(255,255,255,.1); --brand:#8b8cf8; --ok:#34d399; --warn:#fb923c; }
  }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; background:var(--bg); color:var(--ink); -webkit-text-size-adjust:100%; text-size-adjust:100%;
    font:16px/1.55 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif; }
  main { max-width:480px; margin:0 auto; padding:28px 16px 40px; }
  .brand { font-size:13px; font-weight:700; color:var(--muted); letter-spacing:.02em; margin-bottom:14px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:18px; padding:22px 20px; }
  h1 { font-size:21px; margin:0 0 4px; letter-spacing:-.01em; }
  .muted { color:var(--muted); font-size:14px; }
  .item { margin:14px 0 4px; padding:14px; border-radius:12px; background:var(--bg); }
  .item b { display:block; font-size:17px; margin-bottom:4px; }
  .late { color:var(--warn); font-weight:700; }
  .chip { display:inline-block; padding:1px 9px; border-radius:999px; font-size:13px; font-weight:700; background:rgba(91,91,214,.12); color:var(--brand); }
  fieldset { border:0; padding:0; margin:18px 0 0; display:grid; gap:8px; }
  legend { font-weight:700; font-size:15px; margin-bottom:8px; }
  .opt { display:flex; align-items:center; gap:10px; padding:12px 14px; border:1.5px solid var(--line); border-radius:12px; cursor:pointer; font-weight:600; }
  .opt input { width:18px; height:18px; margin:0; accent-color:var(--brand); }
  .opt.ok:has(input:checked) { border-color:var(--ok); background:rgba(15,157,88,.08); }
  .opt.prog:has(input:checked) { border-color:var(--brand); background:rgba(91,91,214,.08); }
  .opt.warn:has(input:checked) { border-color:var(--warn); background:rgba(234,88,12,.08); }
  label.note { display:block; margin-top:16px; font-weight:700; font-size:15px; }
  textarea { width:100%; min-height:88px; margin-top:6px; padding:10px 12px; border:1.5px solid var(--line); border-radius:12px;
    background:var(--card); color:var(--ink); font:inherit; resize:vertical; }
  button { width:100%; height:48px; margin-top:16px; border:0; border-radius:12px; background:var(--brand); color:#fff; font-size:16px; font-weight:700; cursor:pointer; }
  .error { margin-top:14px; padding:10px 12px; border-radius:10px; background:rgba(234,88,12,.1); color:var(--warn); font-weight:600; font-size:14px; }
  .mark { width:56px; height:56px; border-radius:50%; display:grid; place-items:center; font-size:28px; margin-bottom:14px; }
  .mark.ok { background:rgba(15,157,88,.13); color:var(--ok); }
  .mark.warn { background:rgba(234,88,12,.12); color:var(--warn); }
  a { color:var(--brand); }
  .foot { margin-top:16px; font-size:12.5px; color:var(--muted); }
"""
TOGGLE = """<script>
  const note = document.getElementById('note');
  const sync = () => { const blocked = document.querySelector('input[name=s]:checked')?.value === 'blocked';
    note.required = blocked; note.placeholder = blocked ? '무엇 때문에 막혔는지 (필수) — 예: 협력사 자료 회신 대기' : '메모 (선택) — 예: 1차 산정 완료, 금요일 공유 예정'; };
  document.querySelectorAll('input[name=s]').forEach((r) => r.addEventListener('change', sync)); sync();
</script>"""


def _page(title: str, body: str, status: int = 200) -> HTMLResponse:
    return HTMLResponse(
        f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
        f'<meta name="robots" content="noindex"><title>{html.escape(title)} · Navitech</title><style>{STYLE}</style></head>'
        f'<body><main><div class="brand">Navitech · 회의 업무</div><div class="card">{body}</div></main></body></html>',
        status_code=status, headers=HEADERS)


def _item(item: dict) -> str:
    e = html.escape
    due = item.get("due")
    late = f' <span class="late">{item["late_days"]}일 지남</span>' if item.get("late_days") else ""
    meeting = item.get("meeting") or {}
    return (f'<div class="item"><b>{e(item.get("text") or "")}</b>'
            f'<div class="muted">담당 {e(item.get("owner") or "")} · 기한 {e(due or "없음")}{late}</div>'
            f'<div class="muted">{e(meeting.get("title") or "")} ({e(meeting.get("date") or "")}) · {e(item.get("id") or "")}</div>'
            f'<div style="margin-top:8px"><span class="chip">지금: {e(item.get("status_label") or "")}</span></div></div>')


def _form(token: str, item: dict, chosen: str | None, note: str = "", error: str | None = None) -> HTMLResponse:
    e = html.escape
    chosen = chosen if chosen in {s for s, _, _ in STATUSES} else None
    options = "".join(f'<label class="opt {tone}"><input type="radio" name="s" value="{s}"{" checked" if s == chosen else ""} required>{label}</label>'
                      for s, label, tone in STATUSES)
    return _page("진행 상황 알리기", (
        f"<h1>진행 상황 알리기</h1><div class=\"muted\">보내면 회의 기록에 남고 간사와 회의 관제 화면에 바로 보입니다.</div>{_item(item)}"
        f'<form method="post" action="{e(token)}"><fieldset><legend>지금 상황</legend>{options}</fieldset>'
        f'<label class="note" for="note">메모</label><textarea id="note" name="note" maxlength="500">{e(note)}</textarea>'
        + (f'<div class="error">{e(error)}</div>' if error else "")
        + f'<button type="submit">보내기</button></form>'
        f'<div class="foot">로그인 없이 쓰는 화면입니다. 이 업무의 담당자에게 보낸 메일의 버튼에서만 열립니다.</div>{TOGGLE}'))


def _failed(message: str, item: dict | None = None, status: int = 400) -> HTMLResponse:
    e = html.escape
    return _page("진행 상황 알리기", f'<div class="mark warn">!</div><h1>알릴 수 없습니다</h1><div class="muted">{e(message)}</div>'
                 + (_item(item) if item else ""), status)


def register_mail_action(app: FastAPI, settings: Settings, audit: AuditLog, transport: httpx.AsyncBaseTransport | None = None) -> None:
    async def backend(body: dict) -> dict | None:
        if not settings.agent_backend_url:
            return None
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT, transport=transport) as client:
                resp = await client.post(f"{settings.agent_backend_url.rstrip('/')}/api/mail-action", json=body)
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPError:
            log.exception("backend 메일 진행 보고 호출 실패")
            return None

    @app.get("/meetings/act/{token}")
    async def act_page(token: str, s: str | None = None):
        data = await backend({"token": token})
        if data is None:
            return _failed("지금은 회의 기록에 연결할 수 없습니다. 잠시 후 다시 열어 주세요.", status=503)
        if not data.get("ok"):
            return _failed(data.get("error") or "링크를 쓸 수 없습니다.", data.get("item"))
        return _form(token, data["item"], s)

    @app.post("/meetings/act/{token}")
    async def act_submit(token: str, request: Request):
        form = parse_qs((await request.body()).decode("utf-8", "replace"))
        status, note = (form.get("s") or [None])[0], (form.get("note") or [""])[0]
        data = await backend({"token": token, "status": status, "note": note})
        if data is None:
            return _failed("지금은 회의 기록에 연결할 수 없습니다. 잠시 후 다시 보내 주세요.", status=503)
        if not data.get("ok"):
            error = data.get("error") or "알리지 못했습니다."
            if data.get("item") and ("막혔는지" in error or "가운데 하나" in error):  # 고른 것 · 메모를 그대로 두고 다시
                return _form(token, data["item"], status, note, error)
            return _failed(error, data.get("item"))
        item = data["item"]
        await audit.record(AuditEntry(email=data.get("owner_email") or "", agent=PERMISSION, allowed=True,
                                      query=f"[메일 진행 보고] {status} {item.get('id', '')}".strip()))
        what = "남겼습니다" if data.get("changed") or data.get("noted") else "이미 그 상태입니다"
        return _page("진행 상황을 남겼습니다", (
            f'<div class="mark ok">✓</div><h1>{html.escape(item.get("status_label") or "")} — {what}</h1>'
            f'<div class="muted">간사와 회의 관제 화면에 바로 보입니다.</div>{_item(item)}'
            f'<div class="foot"><a href="{html.escape(token)}">다른 상황으로 바꾸기</a></div>'))
