// 회의 업무 화면: gateway /meetings/api/* → backend /api/desk/*. 사용자는 Open WebUI 로그인 토큰(localStorage.token)으로 정해지고,
// 버튼(검토 · 완료 · 일정 · 메일 다시 보내기 · 취소)은 Agent를 거치지 않고 바로 기록됩니다. 메일은 Agent가 주소를 찾아 스스로 보냅니다. 모든 값은 텍스트로만 넣습니다 (회의 기록은 사용자 · LLM이 쓴 것).
'use strict';

const LABEL = {
  mailKind: { minutes: '회의록', assignment: '업무 배정', reminder: '기한 알림', schedule: '회의 안내' },
  mailStatus: { pending: ['보내는 중', 'brand'], needs_address: ['주소 찾는 중', 'warn'], approved: ['보내는 중', 'brand'],
                failed: ['발송 실패', 'danger'], sent: ['보냄', 'ok'], rejected: ['취소', ''] },
  item: { open: ['진행 전', ''], in_progress: ['진행 중', 'brand'], blocked: ['막힘', 'warn'], done: ['완료', 'ok'], cancelled: ['취소', ''] },
  minutes: { draft: ['초안', 'warn'], final: ['확정', 'ok'] },
  level: { 1: '공개', 2: '사내', 3: '대외비', 4: '극비' },
  kind: { decision: '결정', resolution: '의결', criterion: '기준', opinion: '의견', issue: '쟁점' },
};
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
const DECIDED = ['decision', 'resolution', 'criterion'];
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const main = document.getElementById('main');
const dialog = document.getElementById('dialog');

class LoginError extends Error {}

// ---------------------------------------------------------------------------
// 공통
// ---------------------------------------------------------------------------

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

function svg(path, size = 18) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  s.append(p);
  return s;
}
const ICON = {
  plane: 'M22 2 11 13 M22 2l-7 20-4-9-9-4z',
  check: 'M5 12l5 5 9-10',
  calm: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M8 12l3 3 5-6',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 6v6l4 2',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.3-4.3',
  alert: 'M12 9v4 M12 17h.01 M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M12 18v-6 M9 15l3 3 3-3',
};

const dot = (map, key) => {
  const [text, tone] = map[key] || [key, ''];
  return el('span', { class: `dot ${tone}` }, text);
};
const meetingLink = (m) => el('a', { href: `#minutes/${encodeURIComponent(m.id)}` }, m.title || m.id);
const empty = (text) => el('p', { class: 'empty' }, text);
const calm = (title, sub) => el('div', { class: 'calm' }, svg(ICON.calm, 40), el('b', {}, title), sub ? el('span', {}, sub) : '');
const card = (title, count, extra, ...body) => el('section', { class: 'card' },
  el('header', {}, el('h2', {}, title, count != null ? el('span', { class: 'count' }, count) : ''), extra || ''), ...body);
const secret = (level) => (level >= 3 ? el('span', { class: 'tag warn' }, LABEL.level[level]) : '');

// "2026-11-02" · "2026-11-02 15:00" → 날짜 블록 (02 / 11월 · 월)
function dateBlock(value) {
  const d = new Date(`${value.slice(0, 10)}T00:00:00`);
  return el('div', { class: 'date', 'aria-hidden': 'true' }, el('b', {}, value.slice(8, 10)), el('span', {}, `${Number(value.slice(5, 7))}월 · ${WEEKDAY[d.getDay()]}`));
}

function dayLabel(value) { // "2026-10-30" → 10월 30일 (금)
  const d = new Date(`${value.slice(0, 10)}T00:00:00`);
  return `${Number(value.slice(5, 7))}월 ${Number(value.slice(8, 10))}일 (${WEEKDAY[d.getDay()]})`;
}

const names = (list, max = 3) => (list.length <= max ? list.join(', ') : `${list.slice(0, max).join(', ')} 외 ${list.length - max}명`);
const stat = (label, value, hint, href, tone) => el(href ? 'a' : 'div', { class: `stat${tone ? ` ${tone}` : ''}`, href },
  el('span', { class: 'label' }, label), el('b', {}, value), el('span', { class: 'hint' }, hint));

function dueText(item) {
  if (!item.due) return ['기한 없음', ''];
  if (item.overdue_days > 0) return [`${item.overdue_days}일 지남`, 'danger'];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const left = Math.round((Date.parse(`${item.due}T00:00:00`) - start) / 86400000);
  return [left === 0 ? '오늘 마감' : `D-${left}`, left <= 3 ? 'warn' : ''];
}
const dueDot = (item) => { const [t, tone] = dueText(item); return el('span', { class: `dot ${tone}` }, t); };

async function api(endpoint, body = {}) {
  const token = localStorage.getItem('token');
  if (!token) throw new LoginError('Open WebUI에 로그인한 뒤 다시 열어 주세요.');
  const res = await fetch(`/meetings/api/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  const message = typeof data.error === 'object' && data.error ? data.error.message : data.error;
  if (res.status === 401) throw new LoginError(message || '로그인이 필요합니다.');
  if (!res.ok) throw new Error(message || `요청 실패 (HTTP ${res.status})`);
  return data;
}

// 회의록 · 회의 결과 보고서 PDF: 같은 로그인 토큰으로 받아 파일로 저장한다 (gateway가 감사 로그에 남김).
async function download(e, meetingId, kind) {
  const button = e.currentTarget;
  button.disabled = true;
  try {
    const token = localStorage.getItem('token');
    if (!token) throw new Error('Open WebUI에 로그인한 뒤 다시 열어 주세요.');
    const res = await fetch('/meetings/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ meeting_id: meetingId, kind }),
    });
    if (!res.ok || !(res.headers.get('content-type') || '').startsWith('application/pdf')) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `내려받지 못했습니다 (HTTP ${res.status})`);
    }
    const named = (res.headers.get('content-disposition') || '').match(/filename\*=UTF-8''([^;]+)/);
    const url = URL.createObjectURL(await res.blob());
    const a = el('a', { href: url, download: named ? decodeURIComponent(named[1]) : `${meetingId}.pdf` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
}

function toast(message, error = false) {
  const node = el('div', { class: `toast${error ? ' error' : ''}`, role: 'status' }, message);
  document.body.append(node);
  setTimeout(() => node.remove(), 4500);
}

function setBadge(n) {
  const badge = document.getElementById('badge');
  const text = n > 0 ? String(n) : '';
  if (badge.textContent !== text && !REDUCED) {
    badge.classList.remove('bump');
    void badge.offsetWidth; // 애니메이션을 다시 시작
    badge.classList.add('bump');
  }
  badge.textContent = text;
}

// 처리 효과: 'sent' 종이비행기, 'done' 체크. 효과가 끝나면 줄이 빠지고 화면을 다시 불러옵니다.
function play(row, effect) {
  return new Promise((resolve) => {
    if (!row || REDUCED) return resolve();
    const host = row.tagName === 'TR' ? row.lastElementChild : row;
    host.style.position = 'relative';
    if (effect === 'sent') host.append(el('span', { class: 'fx-plane' }, svg(ICON.plane, 26)));
    else {
      row.classList.add('fx-done');
      host.append(el('span', { class: 'fx-check' }, svg(ICON.check, 18)));
    }
    setTimeout(() => {
      row.classList.add('fx-leave');
      setTimeout(resolve, 330);
    }, effect === 'sent' ? 620 : 520);
  });
}

async function act(event, promise, done, effect) {
  const row = event && event.target.closest('li, tr');
  if (event) event.target.disabled = true;
  try {
    const out = await promise;
    const failure = out.error || (out.ok === false && ((out.warnings || []).join(' ') || '처리하지 못했습니다'));
    if (failure) {
      toast(failure, true);
      if (event) event.target.disabled = false;
      return;
    }
    if (effect) await play(row, effect);
    toast(done(out));
  } catch (e) {
    toast(e.message, true);
  }
  route();
}

function skeleton() {
  main.replaceChildren(el('div', { class: 'skeleton', 'aria-hidden': 'true' }, el('div'), el('div'), el('div')));
}

// ---------------------------------------------------------------------------
// 공통 동작: 메일 · 검토 · 완료 · 일정
// ---------------------------------------------------------------------------

const resendMail = (e, m) => act(e, api('mail', { action: 'resend', mail_ids: [m.id] }),
  (out) => (out.done && out.done.length ? `다시 보냅니다${out.smtp_configured ? '' : ' (메일 서버 설정 후 발송)'}`
                                        : (out.skipped || []).join(' ') || '바뀐 것이 없습니다'), 'sent');
const cancelMail = (e, m) => act(e, api('mail', { action: 'reject', mail_ids: [m.id] }), () => '취소했습니다 — 보내지 않습니다', 'done');
const reviewFlag = (e, f, status, note) => act(e, api('flags', { action: 'review', meeting_id: f.meeting.id, reviews: [{ id: f.id, status, note }] }),
  () => (status === 'cleared' ? '문제없음으로 검토했습니다' : '확인 · 조치함으로 검토했습니다'), 'done');
const finishItem = (e, i) => act(e, api('items', { item_id: i.id, status: 'done' }), () => `완료: ${i.text}`, 'done');
const startItem = (e, i) => act(e, api('items', { item_id: i.id, status: 'in_progress' }), () => `진행 중: ${i.text}`);

function scheduleDialog(m) {
  const editing = Boolean(m);
  const tomorrow = new Date(Date.now() + 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  const field = (label, input, wide, hint) => el('label', { class: wide ? 'wide' : '' }, label, hint ? el('span', { class: 'hint' }, hint) : '', input);
  const f = {
    title: el('input', { class: 'text', name: 'title', required: !editing, value: m ? m.title : '' }),
    date: el('input', { class: 'text', type: 'date', required: !editing,
                        value: m ? m.starts_at.slice(0, 10) : `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}` }),
    start: el('input', { class: 'text', type: 'time', value: m ? m.starts_at.slice(11, 16) : '10:00' }),
    end: el('input', { class: 'text', type: 'time', value: m && m.ends_at ? m.ends_at.slice(11, 16) : '' }),
    location: el('input', { class: 'text', value: m && m.location ? m.location : '', placeholder: '본사 12층 대회의실' }),
    attendees: el('input', { class: 'text', placeholder: '김민수, 박지훈, 이서연' }),
    agenda: el('textarea', { class: 'text', placeholder: '한 줄에 안건 하나' }),
    level: el('select', { class: 'text' }, [1, 2, 3, 4].map((n) => el('option', { value: n, selected: n === 2 }, LABEL.level[n]))),
  };
  const submit = async (e) => {
    e.preventDefault();
    const date = f.date.value;
    const body = {
      action: editing ? 'update' : 'create', meeting_id: editing ? m.id : null,
      title: f.title.value.trim() || null, location: f.location.value.trim() || null,
      starts_at: date && f.start.value ? `${date} ${f.start.value}` : null,
      ends_at: date && f.end.value ? `${date} ${f.end.value}` : null,
      attendees: f.attendees.value.split(',').map((s) => s.trim()).filter(Boolean),
      agenda: f.agenda.value.split('\n').map((s) => s.trim()).filter(Boolean),
      classification: editing ? null : Number(f.level.value),
    };
    const button = e.submitter;
    button.disabled = true;
    try {
      const out = await api('schedule', body);
      if (!out.ok) { toast(out.error || '저장하지 못했습니다', true); button.disabled = false; return; }
      dialog.close();
      const mails = (out.mail_queued || []).length;
      toast(`${editing ? '일정을 바꿨습니다' : '회의를 잡았습니다'}${mails ? ` — Agent가 안내 메일 ${mails}통을 보냅니다` : ''}`);
      route();
    } catch (err) {
      toast(err.message, true);
      button.disabled = false;
    }
  };
  dialog.replaceChildren(el('form', { onsubmit: submit },
    el('h2', { id: 'dialog-title' }, editing ? '일정 바꾸기' : '새 회의'),
    el('div', { class: 'fields' },
      field('회의 이름', f.title, true),
      field('날짜', f.date), field('장소', f.location),
      field('시작', f.start), field('끝', f.end),
      field(editing ? '참석자 추가' : '참석자', f.attendees, true, ' 쉼표로 구분'),
      field(editing ? '안건 추가' : '안건', f.agenda, true),
      editing ? '' : field('등급', f.level),
    ),
    el('p', { class: 'sub' }, '저장하면 Agent가 참석자의 주소를 찾아 안내 메일을 바로 보냅니다.'),
    el('div', { class: 'buttons' },
      el('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, '닫기'),
      el('button', { class: 'btn primary', type: 'submit' }, editing ? '바꾸기' : '회의 잡기')),
  ));
  dialog.showModal();
}

const cancelMeeting = (e, m) => {
  if (!confirm(`'${m.title}' 회의를 취소할까요? 참석자에게 취소 안내 메일이 바로 나갑니다.`)) return;
  act(e, api('schedule', { action: 'cancel', meeting_id: m.id }), () => '회의를 취소했습니다', 'done');
};

// ---------------------------------------------------------------------------
// 홈: 지금 처리할 것 · 다가오는 회의 · 내 할 일 · 최근 회의록
// ---------------------------------------------------------------------------

function taskRow(kind, title, meta, action) {
  const tone = { flag: 'danger', overdue: 'danger', mail: 'warn' }[kind];
  return el('li', {}, el('span', { class: `dot ${tone}`, 'aria-hidden': 'true' }),
    el('div', { class: 'body' }, el('span', { class: 'title' }, title), el('span', { class: 'meta' }, meta)),
    el('div', { class: 'side' }, action));
}

function tasks(mail, flags, overdue) {
  const out = [];
  for (const f of flags) {
    out.push(taskRow('flag', `위험 발언 검토 · ${f.rule}`, [f.meeting.title, f.location].join(' · '),
      el('a', { class: 'btn small primary', href: `#meeting/${encodeURIComponent(f.meeting.id)}` }, '검토')));
  }
  for (const m of mail.filter((x) => x.status === 'failed')) {
    out.push(taskRow('mail', `메일 발송 실패 · ${m.subject}`, `받는 사람 ${m.to}${m.last_error ? ` · ${m.last_error}` : ''}`,
      el('button', { class: 'btn small primary', type: 'button', onclick: (e) => resendMail(e, m) }, '다시 보내기')));
  }
  for (const i of overdue) {
    out.push(taskRow('overdue', i.text, `${i.overdue_days}일 지남 · ${i.owner || '담당 없음'}`,
      el('button', { class: 'btn small', type: 'button', onclick: (e) => finishItem(e, i) }, '완료')));
  }
  return out;
}

function upcomingList(meetings) {
  if (!meetings.length) return empty('2주 안에 잡힌 회의가 없습니다.');
  return el('ul', { class: 'list' }, meetings.map((m) => {
    const time = m.starts_at.slice(11, 16) + (m.ends_at ? `–${m.ends_at.slice(11, 16)}` : '');
    const agenda = m.agenda.map((a) => a.title);
    return el('li', {}, dateBlock(m.starts_at),
      el('div', { class: 'body' },
        el('span', { class: 'title' }, m.title, ' ', secret(m.classification)),
        el('span', { class: 'meta' }, [time, m.location].filter(Boolean).join(' · ')),
        el('span', { class: 'meta' }, `참석 ${m.participants.length ? names(m.participants.map((p) => p.name)) : '미정'}`,
          agenda.length ? ` · 안건 ${agenda.length > 2 ? `${agenda.slice(0, 2).join(', ')} 외 ${agenda.length - 2}건` : agenda.join(', ')}` : '')),
      el('div', { class: 'side' },
        el('button', { class: 'btn small', type: 'button', onclick: () => scheduleDialog(m) }, '변경'),
        el('button', { class: 'btn link', type: 'button', onclick: (e) => cancelMeeting(e, m) }, '취소')));
  }));
}

function myItems(items, inMeeting = false) {
  if (!items.length) return empty('맡은 일이 없습니다.');
  return el('ul', { class: 'list' }, items.map((i) => el('li', {},
    el('div', { class: 'body' }, el('span', { class: 'title' }, i.text),
      el('span', { class: 'meta' }, dueDot(i), ' · ', inMeeting ? (i.owner || '담당 없음') : meetingLink(i.meeting))),
    el('div', { class: 'side' }, el('button', { class: 'btn small', type: 'button', onclick: (e) => finishItem(e, i) }, '완료')))));
}

function minutesTable(minutes) {
  if (!minutes.length) return empty('볼 수 있는 회의록이 없습니다.');
  return el('div', { class: 'scroll' }, el('table', { class: 'compact' },
    el('thead', {}, el('tr', {}, ['날짜', '회의', '상태', '결정', '할 일'].map((h) => el('th', { scope: 'col' }, h)))),
    el('tbody', {}, minutes.map((m) => el('tr', {},
      el('td', { class: 'nowrap' }, m.date.slice(5).replace('-', '/')),
      el('td', {}, el('a', { class: 'strong', href: `#minutes/${encodeURIComponent(m.id)}` }, m.title), ' ', secret(m.classification)),
      el('td', { class: 'nowrap' }, dot(LABEL.minutes, m.status), m.open_flags ? el('span', { class: 'dot danger gap' }, `검토 ${m.open_flags}`) : ''),
      el('td', { class: 'num' }, m.decisions),
      el('td', { class: 'num' }, m.items))))));
}

// Agent 활동: Agent가 스스로 보낸 메일을 같은 제목끼리 묶어 시간순으로
const MAIL_ICON = { sent: ICON.plane, approved: ICON.clock, pending: ICON.clock, needs_address: ICON.search, failed: ICON.alert };
function activity(mails) {
  const groups = [];
  for (const m of mails.filter((x) => x.status !== 'rejected')) {
    const last = groups[groups.length - 1];
    if (last && last.mail.subject === m.subject && last.mail.status === m.status && last.mail.sent_at === m.sent_at) last.to.push(m.to);
    else groups.push({ mail: m, to: [m.to] });
  }
  if (!groups.length) return empty('최근 7일 동안 Agent가 보낸 메일이 없습니다.');
  return el('ol', { class: 'feed' }, groups.slice(0, 8).map(({ mail: m, to }) => {
    const [label, tone] = LABEL.mailStatus[m.status] || [m.status, ''];
    const at = m.sent_at ? ` · ${m.sent_at.slice(5, 7)}/${m.sent_at.slice(8, 10)} ${m.sent_at.slice(11, 16)}` : '';
    const tag = (m.subject.match(/^\[([^\]]+)\]/) || [])[1] || LABEL.mailKind[m.kind] || '메일';
    return el('li', { class: tone }, el('span', { class: 'icon' }, svg(MAIL_ICON[m.status] || ICON.plane, 16)),
      el('div', { class: 'body' },
        el('span', { class: 'title' }, m.subject.replace(/^\[[^\]]+\]\s*/, '')),
        el('span', { class: 'meta' }, `${tag} → ${names(to)}`),
        el('span', { class: 'meta' }, el('span', { class: `dot ${tone}` }, label), at)));
  }));
}

async function home() {
  skeleton();
  const [data, mail, flags, all] = await Promise.all([api('overview'), api('mail'), api('flags'), api('items', { view: 'all' })]);
  const overdue = (all.items || []).filter((i) => i.overdue_days > 0);
  const todo = tasks(mail.mails, flags.flags, overdue);
  const s = all.summary || {};
  const active = (s.open || 0) + (s.in_progress || 0) + (s.blocked || 0);
  const sent = mail.mails.filter((m) => m.status === 'sent').length;
  const looking = mail.mails.filter((m) => m.status === 'needs_address').length;
  const next = data.upcoming[0];
  setBadge(data.counts.flags_open + data.counts.mail_failed);
  const name = data.viewer.name || '';
  main.replaceChildren(el('div', { class: 'page' },
    el('div', { class: 'head' },
      el('div', {}, el('h1', {}, name ? `안녕하세요, ${name}님` : '회의 업무'),
        el('p', { class: 'sub' }, `${dayLabel(data.today)} · 회의지원 Agent가 회의 안내 · 회의록 · 기한 알림 메일을 자동으로 보내고 있습니다`)),
      el('div', { class: 'filters' },
        el('a', { class: 'btn', href: '/?model=meeting-agent' }, '녹음으로 회의록 만들기'),
        el('button', { class: 'btn primary', type: 'button', onclick: () => scheduleDialog() }, '+ 새 회의'))),
    el('div', { class: 'stats' },
      stat('다가오는 회의', data.upcoming.length, next ? `다음 ${dayLabel(next.starts_at)} ${next.starts_at.slice(11, 16)}` : '2주 안 일정 없음'),
      stat('Agent가 보낸 메일', sent, looking ? `최근 7일 · 주소 찾는 중 ${looking}통` : '최근 7일', '#approvals'),
      stat('진행 중인 후속 조치', active, `기한 지남 ${s.overdue || 0} · 완료 ${s.done || 0}`, '#items', s.overdue ? 'danger' : ''),
      stat('확인이 필요한 일', todo.length, todo.length ? '아래 목록을 확인하세요' : '모두 Agent가 처리 중', todo.length ? '#approvals' : null, todo.length ? 'danger' : 'ok')),
    todo.length ? card('확인이 필요한 일', todo.length, '', el('ul', { class: 'list' }, todo)) : '',
    el('div', { class: 'split-home' },
      el('div', { class: 'stack' },
        card('다가오는 회의', data.upcoming.length || null, '', upcomingList(data.upcoming)),
        card('최근 회의록', null, el('a', { href: '#minutes', class: 'btn link' }, '전체 보기'), minutesTable(data.minutes.slice(0, 6)))),
      el('div', { class: 'stack' },
        card('Agent 활동', null, el('a', { href: '#approvals', class: 'btn link' }, '메일 전체'), activity(mail.mails)),
        data.my_items.length ? card('내 할 일', data.my_items.length, el('a', { href: '#items', class: 'btn link' }, '전체'), myItems(data.my_items)) : '')),
  ));
}

// ---------------------------------------------------------------------------
// 검토 · 메일: 위험 발언 검토 + Agent가 보낸 메일 (나란히)
// ---------------------------------------------------------------------------

function mailRow(m) {
  const actions = [];
  if (m.status === 'failed') {
    actions.push(el('button', { class: 'btn small primary', type: 'button', onclick: (e) => resendMail(e, m) }, '다시 보내기'));
  }
  if (['pending', 'approved', 'needs_address', 'failed'].includes(m.status)) {
    actions.push(el('button', { class: 'btn link', type: 'button', onclick: (e) => cancelMail(e, m) }, '보내지 않기'));
  }
  const status = m.status === 'sent' && m.sent_at ? `${m.sent_at.slice(5)} 보냄`
    : m.status === 'needs_address' ? '주소를 찾지 못함 · 매일 아침 다시 찾음' : m.last_error || '';
  return el('li', {}, el('div', { class: 'body' },
    el('span', { class: 'title' }, m.subject),
    el('span', { class: 'meta' }, dot(LABEL.mailStatus, m.status), ` · ${LABEL.mailKind[m.kind] || ''} · ${m.to}${m.email ? ` <${m.email}>` : ''}`,
       status ? ` · ${status}` : ''),
    el('details', {}, el('summary', {}, '본문'), el('pre', { class: 'mail' }, m.body)),
    el('div', { class: 'row-actions' }, actions)));
}

function flagRow(f) {
  const note = el('input', { class: 'text', placeholder: '조치 내용 (예: 법무팀 검토 의뢰)', 'aria-label': '조치 내용' });
  return el('li', {}, el('div', { class: 'body' },
    el('span', { class: 'title' }, f.rule),
    el('span', { class: 'meta' }, meetingLink(f.meeting), ` · ${f.location}`),
    el('blockquote', {}, f.excerpt),
    el('div', { class: 'row-actions' },
      el('button', { class: 'btn small', type: 'button', onclick: (e) => reviewFlag(e, f, 'cleared') }, '문제없음'),
      note,
      el('button', { class: 'btn small primary', type: 'button', onclick: (e) => reviewFlag(e, f, 'acknowledged', note.value) }, '확인 · 조치함'))));
}

async function approvals() {
  skeleton();
  const [mail, flags] = await Promise.all([api('mail'), api('flags')]);
  setBadge(flags.flags.length + mail.mails.filter((m) => m.status === 'failed').length);
  main.replaceChildren(el('div', { class: 'page' },
    el('div', { class: 'head' }, el('div', {}, el('h1', {}, '검토 · 메일'),
      el('p', { class: 'sub' }, mail.smtp_configured ? 'Agent가 받는 사람의 주소를 찾아 메일을 바로 보냅니다'
                                                      : 'Agent가 메일을 만들었지만 메일 서버(SMTP)가 설정되지 않아 보내지 못하고 있습니다'))),
    el('div', { class: 'cols two' },
      card('위험 발언 검토', flags.flags.length || null, '', flags.flags.length ? el('ul', { class: 'list' }, flags.flags.map(flagRow)) : calm('검토할 발언이 없습니다', '검토가 끝나야 회의록을 확정할 수 있습니다')),
      card('Agent가 보낸 메일', mail.mails.length || null, '', mail.mails.length ? el('ul', { class: 'list' }, mail.mails.map(mailRow)) : calm('최근 7일 동안 보낸 메일이 없습니다'))),
  ));
}

// ---------------------------------------------------------------------------
// 후속 조치
// ---------------------------------------------------------------------------

let itemView = 'mine';

async function items() {
  skeleton();
  const data = await api('items', { view: itemView });
  if (data.error) throw new Error(data.error);
  const s = data.summary || {};
  const filter = (view, label) => el('button', { class: `btn${itemView === view ? ' on' : ''}`, type: 'button', 'aria-pressed': String(itemView === view),
                                                onclick: () => { itemView = view; route(); } }, label);
  const rows = data.items.map((i) => el('tr', {},
    el('td', {}, el('span', { class: 'title' }, el('b', {}, i.text)), i.last_note ? el('div', { class: 'sub' }, i.last_note) : ''),
    el('td', {}, i.owner || '담당 없음'),
    el('td', {}, dueDot(i)),
    el('td', {}, dot(LABEL.item, i.status)),
    el('td', {}, meetingLink(i.meeting)),
    el('td', {}, el('div', { class: 'row-actions' },
      i.status === 'open' ? el('button', { class: 'btn small', type: 'button', onclick: (e) => startItem(e, i) }, '진행 중') : '',
      el('button', { class: 'btn small primary', type: 'button', onclick: (e) => finishItem(e, i) }, '완료'))),
  ));
  main.replaceChildren(el('div', { class: 'page' },
    el('div', { class: 'head' },
      el('div', {}, el('h1', {}, '후속 조치'), el('p', { class: 'sub' }, `진행 중 ${s.in_progress || 0} · 막힘 ${s.blocked || 0} · 기한 지남 ${s.overdue || 0} · 완료 ${s.done || 0}`)),
      el('div', { class: 'filters', role: 'group', 'aria-label': '보기' }, filter('mine', '내 업무'), filter('all', '전체'), filter('overdue', '기한 지남'))),
    el('section', { class: 'card' }, rows.length
      ? el('div', { class: 'scroll' }, el('table', {},
          el('thead', {}, el('tr', {}, ['업무', '담당', '기한', '상태', '회의', ''].map((h) => el('th', { scope: 'col' }, h)))),
          el('tbody', {}, rows)))
      : calm('해당하는 일이 없습니다')),
  ));
}

// ---------------------------------------------------------------------------
// 회의록 목록 · 회의 상세
// ---------------------------------------------------------------------------

let listQuery = '';
let listStatus = 'all';

// 회의록: 왼쪽 목록에서 고르면 오른쪽에 바로 내용 (페이지 이동 없음)
async function minutes(selected) {
  skeleton();
  const data = await api('overview');
  const all = data.minutes;
  const drafts = all.filter((m) => m.status === 'draft').length;
  let current = all.some((m) => m.id === selected) ? selected : all.length ? all[0].id : null;
  const list = el('ul', { class: 'pick' });
  const pane = el('div', { class: 'detail', 'aria-live': 'polite' }, el('div', { class: 'skeleton one', 'aria-hidden': 'true' }, el('div')));

  const select = async (id) => {
    current = id;
    history.replaceState(null, '', `#minutes/${encodeURIComponent(id)}`);
    for (const b of list.querySelectorAll('.item')) b.setAttribute('aria-current', String(b.dataset.id === id));
    pane.classList.add('loading');
    try {
      pane.replaceChildren(detailView(await api('meeting', { meeting_id: id })));
    } catch (e) {
      pane.replaceChildren(el('section', { class: 'card' }, el('h2', {}, '불러오지 못했습니다'), el('p', {}, e.message)));
    }
    pane.classList.remove('loading');
  };
  const draw = () => {
    const q = listQuery.trim().toLowerCase();
    const shown = all.filter((m) => (listStatus === 'all' || m.status === listStatus) && (!q || m.title.toLowerCase().includes(q)));
    list.replaceChildren(...(shown.length ? shown.map((m) => el('li', {}, el('button', {
      class: 'item', type: 'button', 'data-id': m.id, 'aria-current': String(m.id === current), onclick: () => select(m.id) },
      dateBlock(m.date),
      el('span', { class: 'body' },
        el('span', { class: 'title' }, m.title),
        el('span', { class: 'meta' }, dot(LABEL.minutes, m.status), ` · 결정 ${m.decisions} · 할 일 ${m.items}`,
          m.open_flags ? el('span', { class: 'dot danger gap' }, `검토 ${m.open_flags}`) : '')))))
      : [el('li', {}, empty('맞는 회의록이 없습니다.'))]));
  };
  const chip = (status, label, n) => el('button', {
    class: `btn small${listStatus === status ? ' on' : ''}`, type: 'button', 'aria-pressed': String(listStatus === status),
    onclick: (e) => {
      listStatus = status;
      for (const b of e.currentTarget.parentElement.children) { b.classList.toggle('on', b === e.currentTarget); b.setAttribute('aria-pressed', String(b === e.currentTarget)); }
      draw();
    } }, `${label} ${n}`);
  const search = el('input', { class: 'text', type: 'search', placeholder: '회의 이름으로 찾기', 'aria-label': '회의 이름으로 찾기', value: listQuery,
                               oninput: (e) => { listQuery = e.target.value; draw(); } });
  draw();
  main.replaceChildren(el('div', { class: 'page' },
    el('div', { class: 'head' },
      el('div', {}, el('h1', {}, '회의록'), el('p', { class: 'sub' }, `${all.length}건 · 초안 ${drafts}건 · 확정 ${all.length - drafts}건`)),
      el('a', { class: 'btn', href: '/?model=meeting-agent' }, '녹음으로 회의록 만들기')),
    all.length
      ? el('div', { class: 'split' },
          el('section', { class: 'card master' },
            el('div', { class: 'tools' }, search,
              el('div', { class: 'filters', role: 'group', 'aria-label': '상태' }, chip('all', '전체', all.length), chip('draft', '초안', drafts), chip('final', '확정', all.length - drafts))),
            list),
          pane)
      : el('section', { class: 'card' }, calm('볼 수 있는 회의록이 없습니다', '녹음 파일을 회의지원 Agent에게 주면 회의록이 만들어집니다')),
  ));
  if (current) await select(current);
}

function detailView(data) {
  const m = data.meeting;
  const open = data.flags.filter((f) => f.status === 'open');
  const ask = `/?models=meeting-agent&q=${encodeURIComponent(`${m.id} 회의록을 확정해 줘`)}`;
  const finalize = m.status === 'final' ? ''
    : open.length ? el('span', { class: 'dot danger' }, `위험 발언 ${open.length}건을 검토해야 확정할 수 있습니다`)
      : data.can_confirm ? el('a', { class: 'btn primary', href: ask }, '회의지원 Agent에게 확정 요청')
        : el('span', { class: 'sub' }, '확정은 이 회의의 의장 · 간사가 합니다');
  const people = (data.participants || []).map((p) => p.name);
  const draft = m.status === 'final' ? '' : ' (초안)';
  const documents = el('div', { class: 'docs' },
    el('button', { class: 'btn small', type: 'button', title: '회의록 양식 PDF', onclick: (e) => download(e, m.id, 'minutes') }, svg(ICON.file, 15), `회의록 PDF${draft}`),
    el('button', { class: 'btn small', type: 'button', title: '개조식 회의 결과 보고서 PDF', onclick: (e) => download(e, m.id, 'report') }, svg(ICON.file, 15), `결과 보고서 PDF${draft}`));
  return el('div', { class: 'stack' },
    el('section', { class: 'card' },
      el('div', { class: 'head' },
        el('div', {}, el('h2', { class: 'big' }, m.title, ' ', secret(m.classification)),
          el('p', { class: 'sub' }, dot(LABEL.minutes, m.status), ` · ${dayLabel(m.date)} · ${m.id}`)),
        el('div', { class: 'docs' }, documents, finalize || '')),
      people.length ? el('p', { class: 'people' }, el('b', {}, '참석 '), names(people, 8)) : '',
      el('p', { class: 'summary' }, m.summary || '요약 없음')),
    open.length ? card('위험 발언 검토', open.length, '', el('ul', { class: 'list' }, open.map((f) => flagRow({ ...f, meeting: { id: m.id, title: m.title } })))) : '',
    el('div', { class: 'cols two' },
      card('결정 · 기준 · 의견', m.decisions.length || null, '', m.decisions.length
        ? el('ul', { class: 'list' }, m.decisions.map((d) => el('li', { class: 'top' }, el('span', { class: `tag${DECIDED.includes(d.kind) ? ' brand' : ''}` }, LABEL.kind[d.kind] || d.kind),
            el('div', { class: 'body' },
              el('span', { class: 'title' }, d.statement),
              d.speaker || d.rationale ? el('span', { class: 'meta' }, [d.speaker, d.rationale && `근거: ${d.rationale}`].filter(Boolean).join(' · ')) : ''))))
        : empty('기록된 결정이 없습니다.')),
      el('div', { class: 'stack' },
        card('열린 할 일', m.open_action_items.length || null, '', m.open_action_items.length ? myItems(m.open_action_items, true) : empty('열린 할 일이 없습니다.')),
        card('미결 쟁점', m.open_issues.length || null, '', m.open_issues.length
          ? el('ul', { class: 'list' }, m.open_issues.map((d) => el('li', {}, el('div', { class: 'body' }, el('span', { class: 'title' }, d.statement)))))
          : empty('남은 쟁점이 없습니다.')))));
}

// ---------------------------------------------------------------------------
// 라우팅
// ---------------------------------------------------------------------------

const ROUTES = { home, approvals, items, minutes };

async function route() {
  const [name, arg] = (location.hash.slice(1) || 'home').split('/');
  const tab = name === 'meeting' ? 'minutes' : name;
  for (const a of document.querySelectorAll('.tabs a')) {
    const on = a.dataset.tab === tab;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  try {
    if (tab === 'minutes') await minutes(arg ? decodeURIComponent(arg) : null);
    else await (ROUTES[name] || home)();
  } catch (e) {
    if (e instanceof LoginError) {
      main.replaceChildren(el('section', { class: 'card' }, el('h2', {}, '로그인이 필요합니다'), el('p', {}, e.message),
                                         el('a', { class: 'btn primary', href: '/' }, 'Open WebUI로 로그인')));
    } else {
      main.replaceChildren(el('section', { class: 'card' }, el('h2', {}, '불러오지 못했습니다'), el('p', {}, e.message),
                                         el('button', { class: 'btn', type: 'button', onclick: route }, '다시 시도')));
    }
  }
}

async function who() {
  try {
    const data = await api('overview');
    const c = data.counts;
    setBadge(c.flags_open + c.mail_failed);
    document.getElementById('user').textContent = data.viewer.name || data.viewer.email || '';
  } catch (e) { /* route() shows the reason */ }
}

window.addEventListener('hashchange', route);
route();
who();
