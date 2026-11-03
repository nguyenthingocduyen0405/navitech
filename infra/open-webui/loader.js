// Open WebUI가 모든 페이지에서 불러오는 빈 훅(/static/loader.js)입니다 (docker-compose.yml에서 이 파일을 덮어씀).
// 고정 Agent 목록의 제목을 바꾸고, 회의지원 Agent 채팅에 녹음 효과 · 자동 회의록 요청 · 회의 카드를 더합니다.
// 녹음 파일을 올리면 (어느 채팅이든) 글로 옮기는 진행 상황을 보여 줍니다. 회의 업무 화면(/meetings/)도 이 파일이 같은 카드로 그립니다.
(() => {
  // 왼쪽 메뉴의 고정 모델 목록(DEFAULT_PINNED_MODELS) 제목 '모델' → 'Agent 목록'. 그 목록의 제목만 바꿉니다.
  function rename() {
    for (const span of document.querySelectorAll('button span')) {
      if (span.children.length || span.textContent.trim() !== '모델') continue;
      let section = span.closest('button');
      for (let i = 0; i < 7 && section; i++) {
        section = section.parentElement;
        if (section && section.querySelector('a[href^="/?model="]')) { span.textContent = 'Agent 목록'; break; }
      }
    }
  }

  new MutationObserver(rename).observe(document.documentElement, { childList: true, subtree: true });
  rename();
})();

// 회의 업무(/meetings/) · QR 출석(/meetings/checkin/) · 목소리 구분 확인(/meetings/voice-check/) 화면에서 로그인하러 왔으면,
// 로그인을 마친 뒤 그 화면으로 돌려보낸다 (같은 사이트 주소만).
(() => {
  const NEXT = 'navitech.checkin.next';
  const back = () => {
    const next = localStorage.getItem(NEXT);
    if (!next) return true;
    if (!localStorage.getItem('token') || location.pathname.startsWith('/auth')) return false;
    localStorage.removeItem(NEXT);
    if (/^\/meetings\/((checkin|voice-check)\/)?(\?|$)/.test(next)) location.replace(next);
    return true;
  };
  if (!back()) {
    const timer = setInterval(() => { if (back()) clearInterval(timer); }, 500);
    setTimeout(() => clearInterval(timer), 120000);
  }
})();

// 회의지원 Agent 채팅에서만: 녹음 시작 효과, 녹음 중 표시, 녹음을 마치면(✓) 글로 옮긴 회의록을 자동으로 보냄.
// 회의 녹음(speech-service가 첫 줄에 [transcript_id: …]를 붙인 여러 화자 · 긴 녹음)은 녹음 시각을 붙여 회의록 초안을 요청하고,
// 짧은 음성 입력은 말한 그대로 보낸다. 다른 Agent 채팅의 음성 입력은 Open WebUI 기본 동작 그대로 둔다.
(() => {
  const MODEL = 'meeting-agent';
  const MARK = '[transcript_id:';
  const WAIT_TEXT_MS = 15 * 60 * 1000; // 긴 회의는 글로 옮기는 데 몇 분 걸릴 수 있음
  let rec = null; // { state: 'starting' | 'recording' | 'transcribing', started, ended, pill, glow, timer, meetingId }
  let pendingMeeting = null; // 회의 카드의 '녹음 시작'으로 고른 회의 id

  // 색: Apple Intelligence의 '듣는 중' 빛처럼 보라 · 분홍 · 파랑 · 코랄 · 주황이 화면 가장자리를 돈다
  const SPECTRUM = '#BC82F3,#F5B9EA,#8D9FFF,#FF6778,#FFBA71,#C686FF,#BC82F3';
  const CSS = `
  .nv-rec-pill{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;align-items:center;gap:12px;
    padding:10px 18px 10px 12px;border-radius:999px;background:rgba(17,17,22,.94);color:#fff;font-size:14px;line-height:1.25;
    box-shadow:0 12px 36px rgba(188,130,243,.38),0 0 0 1px rgba(255,255,255,.08);backdrop-filter:blur(10px);
    animation:nv-drop .5s cubic-bezier(.2,1.4,.4,1) both;width:max-content;max-width:min(600px,calc(100vw - 32px))}
  .nv-rec-pill b{font-weight:700;letter-spacing:-.01em}
  .nv-rec-pill small{display:block;font-size:12px;opacity:.72;margin-top:2px}
  .nv-rec-time{font-variant-numeric:tabular-nums;font-weight:600;opacity:.9;margin-left:2px}
  .nv-rec-dot{flex:none;position:relative;width:18px;height:18px;border-radius:50%;transition:transform .08s linear}
  .nv-orb{position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 0deg,${SPECTRUM});animation:nv-spin 2.4s linear infinite;
    box-shadow:0 0 10px rgba(188,130,243,.85),0 0 22px rgba(255,103,120,.35)}
  .nv-orb::after{content:"";position:absolute;inset:4px;border-radius:50%;background:radial-gradient(circle at 35% 30%,rgba(255,255,255,.9),rgba(255,255,255,0) 65%)}
  .nv-rec-pill:is(.busy,.done,.error) .nv-orb{display:none}
  .nv-rec-pill.busy .nv-rec-dot{width:14px;height:14px;margin:2px;border:2px solid rgba(255,255,255,.3);border-top-color:#C686FF;animation:nv-spin .8s linear infinite}
  .nv-rec-pill.done .nv-rec-dot{width:12px;height:12px;margin:3px;background:#3ecf8e}
  .nv-rec-pill.error .nv-rec-dot{width:12px;height:12px;margin:3px;background:#f5a524}
  .nv-rec-pill.leaving{animation:nv-leave .35s ease-in forwards}
  .nv-glow{position:fixed;inset:0;pointer-events:none;z-index:9997;--nv-level:0;animation:nv-reveal 1.4s cubic-bezier(.2,.75,.2,1) both}
  .nv-glow.out{animation:nv-out .7s ease forwards}
  .nv-glow-layer{position:absolute;inset:0}
  .nv-glow-ring{position:absolute;inset:0;border-radius:14px;padding:var(--w);overflow:hidden;
    -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;
    mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0)}
  .nv-glow-spin{position:absolute;left:50%;top:50%;width:260vmax;height:260vmax;margin:-130vmax 0 0 -130vmax;
    background:conic-gradient(from 0deg,${SPECTRUM});animation:nv-spin var(--t) linear infinite var(--dir,normal)}
  .nv-glow-layer.l1{--w:3px;--t:7s}
  .nv-glow-layer.l2{--w:8px;--t:9s;--dir:reverse;filter:blur(8px);opacity:calc(.45 + var(--nv-level) * .55)}
  .nv-glow-layer.l3{--w:22px;--t:13s;filter:blur(28px);opacity:calc(.2 + var(--nv-level) * .65)}
  .nv-recbar{background:linear-gradient(90deg,rgba(188,130,243,.13),rgba(141,159,255,.12),rgba(255,103,120,.10),rgba(255,186,113,.13))!important;
    box-shadow:0 0 0 1px rgba(188,130,243,.3)}
  .nv-recbar [class*="bg-indigo-500"],.nv-recbar [class*="bg-indigo-400"]{background:linear-gradient(90deg,#BC82F3,#8D9FFF,#FF6778,#FFBA71) fixed!important}
  .nv-recbar #confirm-recording-button{background:conic-gradient(from 210deg,${SPECTRUM})!important;color:#fff!important;box-shadow:0 0 14px rgba(188,130,243,.6)}
  .nv-recbar [class*="bg-indigo-400/20"]{background:rgba(188,130,243,.16)!important;color:#8b5cf6!important}
  .nv-recbar [class*="text-indigo"]{color:#8b5cf6!important}
  @keyframes nv-drop{from{opacity:0;transform:translate(-50%,-140%) scale(.9)}to{opacity:1;transform:translate(-50%,0) scale(1)}}
  @keyframes nv-leave{to{opacity:0;transform:translate(-50%,-60%) scale(.96)}}
  @keyframes nv-spin{to{transform:rotate(360deg)}}
  @keyframes nv-reveal{0%{clip-path:circle(0 at var(--x) var(--y));filter:brightness(1.7) saturate(1.5)}
    70%{filter:brightness(1.15) saturate(1.2)}100%{clip-path:circle(170vmax at var(--x) var(--y));filter:none}}
  @keyframes nv-out{to{opacity:0}}
  @media (prefers-reduced-motion:reduce){.nv-rec-pill,.nv-orb,.nv-glow,.nv-glow-spin{animation:none!important}}`;

  function style() {
    if (document.getElementById('nv-rec-style')) return;
    const s = document.createElement('style');
    s.id = 'nv-rec-style';
    s.textContent = CSS;
    document.head.append(s);
  }

  // 지금 화면의 모델: (숨겨 둔) 모델 선택 버튼에 보이는 이름이 기준이다. sessionStorage.selectedModels는 링크로 들어오면 늦게 바뀐다.
  let meetingName = '회의지원 Agent';
  const token = localStorage.getItem('token');
  if (token) {
    fetch('/api/models', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { const m = d && (d.data || []).find((x) => x.id === MODEL); if (m && m.name) meetingName = m.name; })
      .catch(() => {});
  }
  function inMeetingChat() {
    const shown = [...document.querySelectorAll('[id^="model-selector-"][id$="-button"]')].map((b) => b.textContent.trim()).filter(Boolean);
    if (shown.length) return shown.includes(meetingName);
    const params = new URLSearchParams(location.search);
    return [params.get('model'), ...(params.get('models') || '').split(',')].includes(MODEL);
  }

  const clock = (ms) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  const kst = (t, opts) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour12: false, ...opts }).format(t);
  const day = (t) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(t).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; };
  const hm = (t) => kst(t, { hour: '2-digit', minute: '2-digit' });

  function pill(title, sub, tone = '') {
    if (!rec) return;
    if (!rec.pill) {
      rec.pill = document.createElement('div');
      rec.pill.setAttribute('role', 'status');
      rec.pill.setAttribute('aria-live', 'polite');
      document.body.append(rec.pill);
    }
    rec.pill.className = `nv-rec-pill ${tone}`;
    rec.pill.innerHTML = '<span class="nv-rec-dot" aria-hidden="true"><span class="nv-orb"></span></span><span><b></b><span class="nv-rec-time"></span><small></small></span>';
    rec.pill.querySelector('b').textContent = title;
    rec.pill.querySelector('small').textContent = sub;
  }

  // 화면 가장자리의 빛: 마이크 버튼에서 퍼져 나와 세 겹(선명 · 번짐 · 큰 번짐)이 서로 다른 속도로 돈다.
  function glowOn(from) {
    const g = document.createElement('div');
    g.className = 'nv-glow';
    const r = from && from.getBoundingClientRect();
    g.style.setProperty('--x', r ? `${r.left + r.width / 2}px` : '50%');
    g.style.setProperty('--y', r ? `${r.top + r.height / 2}px` : '100%');
    g.innerHTML = ['l3', 'l2', 'l1'].map((l) => `<div class="nv-glow-layer ${l}"><div class="nv-glow-ring"><div class="nv-glow-spin"></div></div></div>`).join('');
    document.body.append(g);
    return g;
  }

  function glowOff(g) {
    if (!g) return;
    g.classList.add('out');
    setTimeout(() => g.remove(), 750);
  }

  // 말소리가 클수록 빛이 밝아지고 구슬이 커진다. Open WebUI가 여는 마이크 스트림을 그대로 듣기만 한다.
  const media = navigator.mediaDevices;
  if (media && media.getUserMedia) {
    const open = media.getUserMedia.bind(media);
    media.getUserMedia = async (constraints) => {
      let stream;
      try {
        stream = await open(constraints);
      } catch (e) {
        if (rec && rec.state === 'starting') micFailed(e);
        throw e;
      }
      if (rec && constraints && constraints.audio) listen(stream, rec);
      return stream;
    };
  }

  // 마이크를 열지 못하면 빛을 바로 끄고 이유를 알려 준다 (Open WebUI 알림은 장치가 없어도 '권한 거부'라고만 함).
  const MIC_HELP = {
    NotFoundError: ['이 컴퓨터에서 마이크를 찾을 수 없습니다', '원격 데스크톱이면 연결 설정 → 로컬 리소스 → 원격 오디오에서 "이 컴퓨터에서 녹음"을 켜고 다시 연결해 주세요'],
    NotAllowedError: ['마이크 사용이 허용되지 않았습니다', '주소창 왼쪽 아이콘 → 사이트 설정에서 마이크를 허용한 뒤 다시 눌러 주세요'],
    NotReadableError: ['다른 프로그램이 마이크를 쓰고 있습니다', '화상회의 앱 등을 닫은 뒤 다시 눌러 주세요'],
  };
  function micFailed(e) {
    const [title, sub] = MIC_HELP[e && e.name] || ['마이크를 열지 못했습니다', String((e && e.message) || e)];
    glowOff(rec.glow);
    rec.glow = null;
    pill(title, sub, 'error');
    finish(9000);
    // 같은 내용의 Open WebUI 알림('권한 거부')은 닫는다
    setTimeout(() => {
      for (const t of document.querySelectorAll('[data-sonner-toast]')) {
        const close = t.innerText.includes(e && e.name) && t.querySelector('[data-close-button]');
        if (close) close.click();
      }
    }, 150);
  }

  function listen(stream, owner) {
    let ctx;
    try {
      ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      ctx.resume().catch(() => {});
      const data = new Float32Array(analyser.fftSize);
      let level = 0;
      const frame = () => {
        if (rec !== owner || owner.state === 'transcribing') { ctx.close().catch(() => {}); return; }
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += v * v;
        const db = 20 * Math.log10(Math.sqrt(sum / data.length) + 1e-6); // 조용함 −55 dB → 0, 큰 목소리 −12 dB → 1
        const target = Math.min(1, Math.max(0, (db + 55) / 43));
        level += (target - level) * (target > level ? 0.35 : 0.07); // 빨리 밝아지고 천천히 가라앉음
        if (owner.glow) owner.glow.style.setProperty('--nv-level', level.toFixed(3));
        const dot = owner.pill && owner.pill.querySelector('.nv-rec-dot');
        if (dot) dot.style.transform = `scale(${(1 + level * 0.6).toFixed(3)})`;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    } catch {
      if (ctx) ctx.close().catch(() => {}); // 소리 크기 없이도 빛은 돈다
    }
  }

  function finish(delay = 0) {
    const current = rec;
    rec = null;
    if (!current) return;
    clearInterval(current.timer);
    glowOff(current.glow);
    document.querySelectorAll('.nv-recbar').forEach((n) => n.classList.remove('nv-recbar'));
    if (current.pill) {
      setTimeout(() => { current.pill.classList.add('leaving'); setTimeout(() => current.pill.remove(), 400); }, delay);
    }
  }

  // Open WebUI는 녹음 막대를 숨긴(.hidden) 채로 늘 두므로, 보이는 동안만 '녹음 중'으로 본다.
  function bar() {
    const ok = document.getElementById('confirm-recording-button');
    if (!ok || !ok.offsetParent) return null;
    let node = ok;
    for (let i = 0; i < 4 && node.parentElement; i++) {
      node = node.parentElement;
      if (node.className && String(node.className).includes('rounded-full') && node.querySelectorAll('button').length >= 2) return node;
    }
    return ok.parentElement;
  }

  function send(text) {
    const input = document.getElementById('chat-input');
    if (text.includes(MARK) && input && input.editor) {
      const minutes = Math.max(1, Math.round((rec.ended - rec.started) / 60000));
      const which = rec.meetingId ? ` 회의: ${rec.meetingId}` : '';
      const head = `회의 녹음이 끝났습니다. 아래 transcript로 회의록 초안을 작성해 주세요. 녹음: ${day(rec.started)} ${hm(rec.started)}~${hm(rec.ended)} (${minutes}분)${which}`;
      input.editor.commands.insertContentAt(0, [{ type: 'paragraph', content: [{ type: 'text', text: head }] }]);
    }
    let tries = 0;
    const click = setInterval(() => {
      const button = document.getElementById('send-message-button');
      if (button && !button.disabled) {
        clearInterval(click);
        button.click();
        if (text.includes(MARK)) pill('회의록 초안 작성을 요청했습니다', '회의지원 Agent가 예약된 회의를 찾아 초안을 저장합니다', 'done');
        else pill('음성 입력을 보냈습니다', '', 'done');
        finish(2600);
      } else if (++tries > 40) {
        clearInterval(click);
        pill('자동으로 보내지 못했습니다', '입력창의 내용을 확인하고 보내기를 눌러 주세요', 'error');
        finish(6000);
      }
    }, 100);
  }

  function tick() {
    if (!rec) return;
    const recording = bar();
    if (rec.state === 'starting') {
      if (recording) {
        rec.state = 'recording';
        rec.started = Date.now();
        recording.classList.add('nv-recbar');
        pill('회의 녹음 중', '참석자에게 녹음 중임을 알려 주세요 · 끝나면 ✓를 누르면 회의록 초안이 자동으로 작성됩니다');
      } else if (Date.now() - rec.clicked > 8000) {
        finish(); // 마이크 권한 거부 등으로 녹음이 시작되지 않음 (Open WebUI가 안내를 띄움)
      }
    } else if (rec.state === 'recording') {
      if (!recording) { finish(); return; } // 취소(✕) 또는 화면 이동
      recording.classList.add('nv-recbar');
      const time = rec.pill && rec.pill.querySelector('.nv-rec-time');
      if (time) time.textContent = ` ${clock(Date.now() - rec.started)}`;
    } else if (rec.state === 'transcribing') {
      const input = document.getElementById('chat-input');
      const text = input ? input.innerText.trim() : '';
      // 녹음 막대는 글로 옮기기가 끝나기 전에 사라지므로, 입력창 내용이 바뀌는 것을 기다린다 (실패하면 Open WebUI가 오류 알림을 띄움)
      const failed = [...document.querySelectorAll('[data-sonner-toast][data-type="error"]')].some((t) => !rec.toasts.has(t));
      if (text !== rec.before && text === rec.last) {
        // 글로 옮긴 내용이 입력창에 들어오고 더 바뀌지 않으면 보냄
        clearInterval(rec.timer);
        send(text.slice(rec.before.length));
      } else if (text === rec.before && (failed || Date.now() - rec.ended > WAIT_TEXT_MS)) {
        pill('녹음을 글로 옮기지 못했습니다', '잠시 후 다시 시도하거나 녹음 파일을 올려 주세요', 'error');
        finish(6000);
      }
      if (rec) rec.last = text;
    }
  }

  document.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    if (target.closest('#voice-input-button')) {
      if (rec || !inMeetingChat()) return;
      style();
      rec = { state: 'starting', clicked: Date.now(), meetingId: pendingMeeting };
      pendingMeeting = null;
      rec.glow = glowOn(target.closest('#voice-input-button'));
      rec.timer = setInterval(tick, 250);
    } else if (rec && rec.state === 'recording' && target.closest('#confirm-recording-button')) {
      rec.state = 'transcribing';
      rec.ended = Date.now();
      const input = document.getElementById('chat-input');
      rec.before = rec.last = input ? input.innerText.trim() : '';
      rec.toasts = new Set(document.querySelectorAll('[data-sonner-toast]'));
      document.querySelectorAll('.nv-recbar').forEach((n) => n.classList.remove('nv-recbar'));
      glowOff(rec.glow);
      rec.glow = null;
      pill('녹음을 글로 옮기는 중…', `${clock(rec.ended - rec.started)} 녹음 · 발언자를 구분하고 있습니다`, 'busy');
    }
  }, true);

  // ---------------------------------------------------------------------------
  // 녹음 파일을 올리면 (어느 채팅이든): 올리는 중 → 글로 옮기는 중(경과 · 예상 시간) → 끝.
  // Open WebUI는 POST /api/v1/files/로 올린 뒤 서버에서 speech-service로 글로 옮기는데, 끝날 때까지 첨부 칩만 돌아
  // 멈춘 것처럼 보인다. 그 사이 새로고침하면 첨부가 사라지므로(서버 작업은 끝나도 채팅에 안 붙음) 떠나기 전에 묻는다.
  // ---------------------------------------------------------------------------
  const STT_SECONDS_PER_SECOND = 0.035; // 서버(4 vCPU, 로컬 엔진)에서 녹음 1분 ≈ 2초 (57분 회의로 측정)
  const AUDIO_FILE = /\.(m4a|mp3|wav|webm|ogg|oga|opus|aac|flac|amr|3gp|wma|mp4)$/i;
  const uploads = new Set();

  function durationOf(file) {
    return new Promise((resolve) => {
      const a = document.createElement('audio');
      const url = URL.createObjectURL(file);
      const done = (v) => { URL.revokeObjectURL(url); resolve(v); };
      a.preload = 'metadata';
      a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? a.duration : null);
      a.onerror = () => done(null);
      setTimeout(() => done(null), 5000);
      a.src = url;
    });
  }

  function upPill(up, title, sub, tone = 'busy') {
    if (!up.pill) {
      up.pill = document.createElement('div');
      up.pill.setAttribute('role', 'status');
      up.pill.setAttribute('aria-live', 'polite');
      document.body.append(up.pill);
    }
    up.pill.className = `nv-rec-pill ${tone}`;
    up.pill.innerHTML = '<span class="nv-rec-dot" aria-hidden="true"></span><span><b></b><span class="nv-rec-time"></span><small></small></span>';
    up.pill.querySelector('b').textContent = title;
    up.pill.querySelector('small').textContent = sub;
  }

  function upEnd(up, title, sub, tone, delay) {
    clearInterval(up.timer);
    uploads.delete(up);
    upPill(up, title, sub, tone);
    setTimeout(() => { up.pill.classList.add('leaving'); setTimeout(() => up.pill.remove(), 400); }, delay);
  }

  const about = (sec) => (sec < 90 ? `${Math.max(10, Math.round(sec / 10) * 10)}초` : `${Math.round(sec / 60)}분`);

  function transcribing(up, id) {
    const started = Date.now();
    const length = up.duration ? `${Math.max(1, Math.round(up.duration / 60))}분 녹음` : '녹음';
    const estimate = up.duration ? 10 + up.duration * STT_SECONDS_PER_SECOND : null;
    const show = () => {
      const spent = (Date.now() - started) / 1000;
      const late = estimate && spent > estimate * 1.5;
      upPill(up, '녹음을 글로 옮기는 중', `${length} · 발언자 구분 · ${estimate ? (late ? '예상보다 오래 걸리고 있습니다' : `보통 ${about(estimate)} 걸립니다`) : '긴 녹음은 몇 분 걸립니다'} · 끝날 때까지 새로고침하지 마세요`);
      up.pill.querySelector('.nv-rec-time').textContent = ` ${clock(spent * 1000)}`;
    };
    show();
    let polling = false;
    let ticks = 0;
    up.timer = setInterval(async () => {
      show();
      if (polling || ++ticks % 3) return; // 상태는 3초마다 묻는다
      polling = true;
      try {
        const r = await realFetch(`/api/v1/files/${encodeURIComponent(id)}/process/status`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
        const d = r.ok ? await r.json() : null;
        if (d && d.status === 'completed') {
          if (!(inMeetingChat() && askMinutes(up))) {
            upEnd(up, '녹음을 글로 옮겼습니다', `${clock(Date.now() - started)} 걸림 · 할 일을 적어 첨부와 함께 보내 주세요 (빈 메시지로는 내용이 전달되지 않음)`, 'done', 7000);
          }
        }
        else if (d && d.status === 'failed') upEnd(up, '녹음을 글로 옮기지 못했습니다', String(d.error || '파일 형식을 확인하고 다시 올려 주세요').slice(0, 160), 'error', 9000);
        else if (!r.ok && r.status !== 429) upEnd(up, '진행 상황을 확인할 수 없습니다', '첨부 칩이 멈추지 않으면 다시 올려 주세요', 'error', 6000);
      } catch { /* 다음 번에 다시 확인 */ } finally { polling = false; }
    }, 1000);
  }

  // 회의지원 Agent 채팅에서 올린 녹음은 글로 옮겨지자마자 회의록 초안을 요청한다 (마이크 녹음과 같게).
  // 첨부한 채로 문장을 넣어 보내야 Open WebUI가 transcript를 요청에 붙인다 (빈 메시지면 붙이지 않음).
  // Open WebUI가 첨부 칩의 처리 중 표시를 끄기 전에 보내면 무시되므로, 칩이 멈춘 뒤 보내고 칩이 남아 있으면 다시 보낸다.
  const attachedChip = (name) => {
    const box = document.getElementById('message-input-container');
    return box ? [...box.querySelectorAll('button')].find((b) => b.textContent.includes(name)) : null;
  };
  function askMinutes(up) {
    if (!document.getElementById('chat-input') || !attachedChip(up.name)) return false;
    const head = `회의 녹음 파일을 올렸습니다. 첨부한 녹음의 transcript로 회의록 초안을 작성해 주세요. 녹음 파일: ${up.name}${up.checkin ? ` · 출석 확인: ${up.checkin}` : ''}`;
    clearInterval(up.timer);
    upPill(up, '회의록 초안 작성을 요청하는 중', up.name);
    let steps = 0;
    let tries = 0;
    let clickedAt = 0;
    const step = setInterval(() => {
      const input = document.getElementById('chat-input');
      const chip = attachedChip(up.name);
      if (clickedAt && !chip) { // 보내면 Open WebUI가 입력창의 첨부를 비운다
        clearInterval(step);
        upEnd(up, '회의록 초안 작성을 요청했습니다', '회의지원 Agent가 transcript로 초안을 저장합니다', 'done', 4000);
        return;
      }
      const stuck = ++steps > 240 || tries >= 6 || !chip || !input || !input.editor;
      if (stuck && (!clickedAt || Date.now() - clickedAt > 2500)) {
        clearInterval(step);
        upEnd(up, '자동으로 보내지 못했습니다', '입력창의 녹음 첨부를 확인하고 "회의록 초안을 작성해 줘"와 함께 보내 주세요', 'error', 9000);
        return;
      }
      if (stuck || (clickedAt && Date.now() - clickedAt < 2500)) return;
      const button = document.getElementById('send-message-button');
      if (!button || button.disabled || chip.querySelector('[class*="spin"]')) return; // 아직 처리 중
      if (!input.innerText.includes(head)) {
        input.editor.commands.insertContentAt(0, [{ type: 'paragraph', content: [{ type: 'text', text: head }] }]);
      }
      tries += 1;
      clickedAt = Date.now();
      button.click();
    }, 250);
    return true;
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const body = init && init.body;
    const file = init && init.method === 'POST' && /\/api\/v1\/files\/(\?|$)/.test(url) && body instanceof FormData ? body.get('file') : null;
    if (!(file instanceof File) || !(/^(audio|video)\//.test(file.type) || AUDIO_FILE.test(file.name))) return realFetch(input, init);
    style();
    const up = { started: Date.now(), duration: null, name: file.name };
    uploads.add(up);
    if (inMeetingChat()) openCheckin(up);
    durationOf(file).then((d) => { up.duration = d; });
    upPill(up, '녹음 파일을 올리는 중', `${file.name} · ${(file.size / 1048576).toFixed(file.size < 10485760 ? 1 : 0)}MB`);
    try {
      const res = await realFetch(input, init);
      res.clone().json().then((d) => {
        if (res.ok && d && d.id) transcribing(up, d.id);
        else upEnd(up, '녹음 파일을 올리지 못했습니다', String((d && (d.detail || d.message)) || res.status).slice(0, 160), 'error', 9000);
      }).catch(() => upEnd(up, '녹음 파일을 올리지 못했습니다', `HTTP ${res.status}`, 'error', 9000));
      return res;
    } catch (e) {
      upEnd(up, '녹음 파일을 올리지 못했습니다', String((e && e.message) || e).slice(0, 160), 'error', 9000);
      throw e;
    }
  };
  // ---------------------------------------------------------------------------
  // 출석 확인 QR: 회의지원 채팅에 녹음을 올리면 글로 옮기는 동안 화면에 QR을 띄운다. 참석자가 휴대폰으로 찍으면 회사 계정으로
  // 출석하고(말하지 않은 사람도 회의록 참석자가 됨), 회의록 요청에 출석 확인 코드를 함께 보낸다. QR은 30초마다 바뀐다.
  // ---------------------------------------------------------------------------
  const CHECKIN_SHOW_MS = 30 * 60 * 1000;

  async function openCheckin(up) {
    try {
      const d = await api('checkin', { action: 'open', source_name: up.name });
      up.checkin = d.code;
      checkinPanel(d);
    } catch { /* 출석 확인 없이도 회의록은 만든다 */ }
  }

  function svgNode(markup) {
    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
    const svg = doc.documentElement;
    return svg && svg.nodeName === 'svg' ? document.importNode(svg, true) : h('div', { class: 'nv-err' }, 'QR을 그리지 못했습니다');
  }

  function checkinPanel(first) {
    cardStyle();
    document.querySelectorAll('.nv-qr').forEach((n) => n.remove());
    const qr = h('div', { class: 'nv-qr-code', title: '휴대폰 카메라로 찍으세요' });
    const count = h('div', { class: 'nv-strong' });
    const names = h('div', { class: 'nv-qr-names' });
    const timer = h('div', { class: 'nv-meta' });
    let link = '';
    let left = 0;
    let poll;
    const stop = () => { clearInterval(poll); panel.remove(); };
    const render = (d) => {
      if (d.link && d.link !== link) { link = d.link; qr.replaceChildren(svgNode(d.qr_svg)); }
      if (!d.open) { qr.replaceChildren(h('div', { class: 'nv-meta', style: 'padding:24px 8px;text-align:center' }, '출석 확인이 끝났습니다')); }
      left = d.valid_for || 0;
      count.textContent = `출석 ${d.count}명`;
      names.replaceChildren(...(d.attendees || []).map((a) => h('span', { class: 'nv-chip' }, a.name)));
    };
    const close = h('button', { class: 'nv-btn small', type: 'button', onclick: act(async () => {
      render(await api('checkin', { action: 'close', code: first.code }));
      clearInterval(poll);
    }) }, '출석 마감');
    const panel = h('div', { class: 'nv-qr', role: 'dialog', 'aria-label': '참석자 출석 확인' },
      h('div', { class: 'nv-qr-head' }, h('div', { class: 'nv-strong' }, '참석자 출석 확인'),
        h('button', { class: 'nv-qr-x', type: 'button', title: '닫기 (출석은 계속 받음)', onclick: stop }, '×')),
      h('div', { class: 'nv-meta' }, '회의에 있던 분은 휴대폰 카메라로 찍어 주세요. 말하지 않은 분도 회의록 참석자가 되어 할 일과 메일을 받습니다.'),
      qr, h('div', { class: 'nv-qr-foot' }, h('div', {}, count, timer), close), names);
    document.body.append(panel);
    render(first);
    const started = Date.now();
    let ticks = 0;
    poll = setInterval(async () => {
      if (!panel.isConnected || Date.now() - started > CHECKIN_SHOW_MS) { stop(); return; }
      left = Math.max(0, left - 1);
      timer.textContent = link ? `QR이 ${left}초 뒤 바뀝니다` : '';
      if (++ticks % 4 && left > 0) return; // 4초마다, 또는 QR이 바뀔 때 다시 묻는다
      try { render(await api('checkin', { action: 'status', code: first.code })); } catch { /* 다음에 다시 */ }
    }, 1000);
  }

  window.addEventListener('beforeunload', (e) => {
    if (!uploads.size) return;
    e.preventDefault();
    e.returnValue = ''; // 브라우저가 '사이트에서 나가시겠습니까?'를 묻는다
  });
  // ---------------------------------------------------------------------------
  // 회의 카드: 회의지원 Agent 답변 끝의 ```navitech 블록(gateway가 회의 Tool 결과로 붙임)을 카드로 바꾼다.
  // 카드 내용은 회의 업무 API(/meetings/api/*)에서 그때그때 읽고, 버튼도 그 API를 부른다 (확정만 Agent에게 요청).
  // 왼쪽 메뉴의 '회의 업무'(/meetings/) 화면도 같은 카드로 그린다. 모든 글자는 textContent로 넣는다.
  // ---------------------------------------------------------------------------
  const LEVEL = { 1: '공개', 2: '사내', 3: '대외비', 4: '극비' };
  const ROLE = { chair: '의장', secretary: '간사', observer: '배석', optional: '선택' };
  const KIND = { decision: '결정', resolution: '의결', criterion: '기준', opinion: '의견', issue: '쟁점' };
  const ITEM = { open: '미착수', in_progress: '진행 중', blocked: '막힘', done: '완료', cancelled: '취소' };
  const MAIL = { sent: '보냄', approved: '보내는 중', pending: '대기', needs_address: '주소 없음', failed: '보내지 못함', rejected: '취소함' };
  const MAIL_KIND = { minutes: '회의록', assignment: '업무 배정', schedule: '회의 안내', reminder: '기한 알림', alert: '전제 변화' };
  const PREMISE = { holding: ['유지', 'final'], at_risk: ['흔들림', 'draft'], broken: ['깨짐', 'danger'], met: ['달성', 'final'] };
  const WEEK = '일월화수목금토';
  const doneItems = new Map(); // 이 화면에서 완료한 할 일 id → 그 할 일 (목록 API는 열린 것만 돌려줌)

  const CARD_CSS = `
  :root{--nv-bg:#fff;--nv-sub:#f6f6f8;--nv-page:#f3f4f6;--nv-line:rgba(0,0,0,.09);--nv-muted:#6b7280;--nv-brand:#5b5bd6}
  :root.dark{--nv-bg:#1b1b1d;--nv-sub:#232326;--nv-page:#121214;--nv-line:rgba(255,255,255,.1);--nv-muted:#9ca3af;--nv-brand:#8b8cf8}
  .nv-card{margin:12px 0 6px;max-width:780px;border:1px solid var(--nv-line);border-radius:16px;background:var(--nv-bg);
    font-size:14px;line-height:1.55;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.05);text-align:left}
  .nv-card .nv-card{margin:8px 0 4px;box-shadow:none}
  .nv-head{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;padding:14px 16px 8px}
  .nv-title{font-size:15.5px;font-weight:700;letter-spacing:-.01em}
  .nv-meta{color:var(--nv-muted);font-size:12.5px}
  .nv-strong{font-weight:600}
  .nv-chip{display:inline-flex;align-items:center;flex:none;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:700;
    background:var(--nv-sub);color:var(--nv-muted);white-space:nowrap}
  .nv-chip.final{color:#0f9d58;background:rgba(15,157,88,.12)}
  .nv-chip.draft{color:#c2410c;background:rgba(234,88,12,.12)}
  .nv-chip.danger{color:#dc2626;background:rgba(220,38,38,.12)}
  .nv-chip.secret{color:#c0262d;background:rgba(220,38,38,.1);font-size:11px;vertical-align:2px;margin-left:4px}
  .nv-people{padding:0 16px 6px;color:var(--nv-muted);font-size:13px}
  .nv-summary{padding:2px 16px 12px}
  .nv-stats{display:flex;flex-wrap:wrap;gap:6px;padding:0 16px 12px}
  .nv-sec{padding:10px 16px;border-top:1px solid var(--nv-line)}
  .nv-sec-title{font-size:12.5px;font-weight:700;color:var(--nv-muted);margin-bottom:2px}
  .nv-row{display:flex;gap:10px;align-items:center;padding:8px 0}
  .nv-row.top{align-items:flex-start}
  .nv-row+.nv-row{border-top:1px dashed var(--nv-line)}
  .nv-row.click{cursor:pointer;border-radius:8px}
  .nv-row.click:hover .nv-strong{color:var(--nv-brand)}
  .nv-grow{flex:1;min-width:0}
  .nv-tag{flex:none;font-size:11.5px;font-weight:700;padding:1px 7px;border-radius:6px;background:var(--nv-sub);color:var(--nv-muted);margin-top:2px}
  .nv-tag.brand{background:rgba(91,91,214,.13);color:var(--nv-brand)}
  .nv-actions{display:flex;flex-wrap:wrap;gap:6px;padding:10px 16px 12px;border-top:1px solid var(--nv-line);background:var(--nv-sub)}
  .nv-btns{display:flex;gap:6px;flex:none}
  .nv-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:9px;border:1px solid var(--nv-line);
    background:var(--nv-bg);color:inherit;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}
  .nv-btn:hover{border-color:var(--nv-muted)}
  .nv-btn.small{height:27px;padding:0 10px;font-size:12.5px}
  .nv-btn.primary{background:var(--nv-brand);border-color:transparent;color:#fff}
  .nv-btn.rec{background:linear-gradient(135deg,#BC82F3,#FF6778 60%,#FFBA71);border-color:transparent;color:#fff}
  .nv-btn:disabled{opacity:.5;cursor:default}
  .nv-input{display:block;width:100%;margin-top:6px;padding:6px 10px;border:1px solid var(--nv-line);border-radius:8px;background:var(--nv-bg);color:inherit;font-size:13px}
  .nv-warn{color:#c2410c}.nv-danger{color:#dc2626}
  .nv-loading{padding:14px 16px;color:var(--nv-muted);font-size:13px}
  .nv-err{color:#dc2626;font-size:12px;margin-top:4px}
  .nv-assign{display:grid;grid-template-columns:1fr 150px auto;gap:6px;margin-top:6px}
  .nv-assign[hidden]{display:none}
  .nv-assign .nv-input{margin:0}
  .nv-notice{position:fixed;bottom:110px;left:50%;transform:translateX(-50%);z-index:9999;padding:10px 16px;border-radius:12px;
    background:rgba(17,17,22,.94);color:#fff;font-size:13.5px;box-shadow:0 10px 30px rgba(0,0,0,.2)}
  .nv-filter{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 4px}
  .nv-filter button{height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--nv-line);background:var(--nv-bg);color:var(--nv-muted);font-size:12px;font-weight:700;cursor:pointer}
  .nv-filter button.on{background:var(--nv-brand);border-color:transparent;color:#fff}
  .nv-hidden-block{display:none!important}
  .nv-qr{position:fixed;right:20px;bottom:120px;z-index:9998;width:290px;padding:14px;border-radius:18px;background:var(--nv-bg);
    border:1px solid var(--nv-line);box-shadow:0 18px 50px rgba(0,0,0,.2);font-size:13px;line-height:1.45;text-align:left}
  .nv-qr-head,.nv-qr-foot{display:flex;justify-content:space-between;align-items:center;gap:8px}
  .nv-qr-x{border:0;background:none;color:var(--nv-muted);font-size:20px;line-height:1;cursor:pointer;padding:0 2px}
  .nv-qr-code{background:#fff;border-radius:12px;padding:6px;margin:10px 0}
  .nv-qr-code svg{display:block;width:100%;height:auto}
  .nv-qr-names{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
  @media (max-width:640px){.nv-qr{left:12px;right:12px;width:auto;bottom:96px}}
  .nv-who{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 2px}
  .nv-who .nv-chip{gap:5px}
  .nv-chip.ok{color:#0f9d58;background:rgba(15,157,88,.12)}
  .nv-pick{margin-top:6px}
  .nv-pick-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
  .nv-card>.nv-sec:first-child{border-top:0}
  .nv-app{min-height:100vh;background:var(--nv-page);text-align:left}
  .nv-top{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:16px;height:56px;padding:0 20px;background:var(--nv-bg);border-bottom:1px solid var(--nv-line)}
  .nv-brand{display:flex;align-items:center;gap:8px;width:204px;flex:none;color:inherit;font-weight:700;text-decoration:none}
  .nv-brand img{width:26px;height:26px;border-radius:7px}
  .nv-brand small{font-size:13px;font-weight:600;color:var(--nv-muted)}
  .nv-search{position:relative;flex:1;max-width:560px}
  .nv-search svg{position:absolute;left:11px;top:9px;width:18px;height:18px;color:var(--nv-muted);pointer-events:none}
  .nv-search input{width:100%;height:36px;padding:0 12px 0 36px;border-radius:10px;border:1px solid var(--nv-line);background:var(--nv-sub);color:inherit;font-size:14px}
  .nv-search input:focus{outline:2px solid rgba(91,91,214,.35);background:var(--nv-bg)}
  .nv-top-end{margin-left:auto;display:flex;align-items:center;gap:14px}
  .nv-ghost{font-size:13.5px;font-weight:600;color:var(--nv-muted);text-decoration:none;white-space:nowrap}
  .nv-ghost:hover{color:inherit}
  .nv-body{display:grid;grid-template-columns:224px minmax(0,1fr)}
  .nv-side{position:sticky;top:56px;align-self:start;height:calc(100vh - 56px);overflow:auto;padding:14px 10px;background:var(--nv-bg);border-right:1px solid var(--nv-line)}
  .nv-nav{display:flex;align-items:center;gap:10px;height:36px;padding:0 10px;margin-bottom:2px;border-radius:9px;color:inherit;font-size:14px;font-weight:600;text-decoration:none;white-space:nowrap}
  .nv-nav:hover{background:var(--nv-sub)}
  .nv-nav.on{background:rgba(91,91,214,.11);color:var(--nv-brand)}
  .nv-nav svg{width:18px;height:18px;flex:none}
  .nv-count{margin-left:auto;min-width:20px;padding:0 6px;border-radius:999px;font-size:12px;font-weight:700;line-height:20px;text-align:center;color:var(--nv-muted)}
  .nv-count.alert{background:#dc2626;color:#fff}
  .nv-main{min-width:0;max-width:1320px;padding:24px 28px 64px}
  .nv-page-head{margin-bottom:16px}
  .nv-h1{font-size:22px;font-weight:800;letter-spacing:-.02em;line-height:1.3}
  .nv-narrow{max-width:920px}
  .nv-cols{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:16px;align-items:start}
  .nv-stack{display:flex;flex-direction:column;gap:16px;min-width:0}
  .nv-app .nv-card{margin:0;max-width:none}
  .nv-app .nv-card .nv-card{margin:8px 0 4px}
  .nv-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}
  .nv-tile{display:block;padding:14px 16px;border-radius:14px;border:1px solid var(--nv-line);background:var(--nv-bg);color:inherit;text-decoration:none}
  .nv-tile:hover{border-color:var(--nv-muted)}
  .nv-tile b{display:block;font-size:26px;font-weight:800;line-height:1.2}
  .nv-tile span{font-size:12.5px;font-weight:600;color:var(--nv-muted)}
  .nv-tile.warn b{color:#c2410c}.nv-tile.danger b{color:#dc2626}
  .nv-more{font-size:12.5px;font-weight:700;color:var(--nv-brand);text-decoration:none;white-space:nowrap}
  .nv-li{display:flex;gap:12px;align-items:flex-start;padding:11px 16px;border-top:1px solid var(--nv-line);cursor:pointer}
  .nv-li:hover{background:var(--nv-sub)}
  .nv-li.sel{background:rgba(91,91,214,.08);box-shadow:inset 3px 0 0 var(--nv-brand)}
  .nv-li.link{display:block;cursor:pointer}
  .nv-dot{flex:none;width:8px;height:8px;margin-top:8px;border-radius:50%;background:var(--nv-muted)}
  .nv-dot.danger{background:#dc2626}.nv-dot.warn{background:#ea580c}.nv-dot.brand{background:var(--nv-brand)}.nv-dot.ok{background:#0f9d58}
  .nv-group-title{padding:14px 16px 6px;font-size:12px;font-weight:700;color:var(--nv-muted);border-top:1px solid var(--nv-line)}
  .nv-split{display:grid;grid-template-columns:minmax(320px,430px) minmax(0,1fr);gap:16px;align-items:start}
  .nv-detail{position:sticky;top:72px;max-height:calc(100vh - 88px);overflow:auto;border-radius:16px}
  .nv-placeholder{display:grid;place-items:center;min-height:280px;padding:24px;border:1px dashed var(--nv-line);border-radius:16px;color:var(--nv-muted);font-size:13.5px;text-align:center}
  .nv-close{display:flex;justify-content:flex-end;margin-bottom:8px}
  .nv-day{display:grid;grid-template-columns:92px minmax(0,1fr);border-top:1px solid var(--nv-line)}
  .nv-day-label{padding:12px 0 12px 16px;font-size:13px;font-weight:800}
  .nv-day-label small{display:block;font-size:12px;font-weight:600;color:var(--nv-muted)}
  .nv-day .nv-li{border-top:0;padding-left:4px}
  .nv-day .nv-li+.nv-li{border-top:1px dashed var(--nv-line)}
  .nv-empty{padding:4px 16px 16px;color:var(--nv-muted);font-size:13px}
  .nv-drop{display:flex;flex-direction:column;align-items:center;gap:6px;padding:26px 16px;border:2px dashed rgba(91,91,214,.45);border-radius:14px;
    background:rgba(91,91,214,.04);text-align:center;cursor:pointer}
  .nv-drop svg{width:28px;height:28px;color:var(--nv-brand)}
  .nv-drop.over{background:rgba(91,91,214,.12)}
  @keyframes nv-turn{to{transform:rotate(360deg)}}
  @keyframes nv-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  .nv-mail{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px dashed var(--nv-line)}
  .nv-env{flex:none;display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:rgba(91,91,214,.1);color:var(--nv-brand)}
  .nv-env svg{width:18px;height:18px}
  .nv-mail.fly .nv-env{animation:nv-fly 1.1s cubic-bezier(.3,.7,.3,1) both;animation-delay:calc(var(--d,0) * .25s)}
  @keyframes nv-fly{0%{transform:translate(-44px,12px) scale(.6) rotate(-14deg);opacity:0}60%{transform:translate(6px,-4px) scale(1.12) rotate(6deg);opacity:1}100%{transform:none}}
  .nv-mail.sent .nv-env{background:rgba(15,157,88,.12);color:#0f9d58}
  .nv-lamp{flex:none;width:10px;height:10px;border-radius:50%;background:#0f9d58;box-shadow:0 0 0 3px rgba(15,157,88,.16)}
  .nv-lamp.warn{background:#ea580c;box-shadow:0 0 0 3px rgba(234,88,12,.16)}
  .nv-lamp.alarm{background:#dc2626;animation:nv-pulse 1.2s ease-in-out infinite}
  @keyframes nv-pulse{0%,100%{box-shadow:0 0 0 2px rgba(220,38,38,.4)}50%{box-shadow:0 0 0 8px rgba(220,38,38,.06)}}
  .nv-live{display:inline-flex;align-items:center;gap:6px;margin-left:6px;font-size:12px;font-weight:700;color:#0f9d58;font-variant-numeric:tabular-nums}
  .nv-live::before{content:"";width:8px;height:8px;border-radius:50%;background:#0f9d58;animation:nv-blink 1.6s infinite}
  @keyframes nv-blink{50%{opacity:.25}}
  @keyframes nv-flash{0%,30%{background:rgba(250,204,21,.4)}100%{background:transparent}}
  .nv-flow-d{padding:0 16px 10px 36px;font-size:13.5px;line-height:1.5}
  .nv-flow-d.old{color:var(--nv-muted)}
  .nv-flow-d.old>.nv-tag+*{text-decoration:line-through}
  @media (max-width:1200px){.nv-cols{grid-template-columns:minmax(0,1fr)}}
  @media (max-width:900px){.nv-body{grid-template-columns:minmax(0,1fr)}
    .nv-side{z-index:10;height:auto;display:flex;gap:4px;overflow-x:auto;padding:8px;border-right:0;border-bottom:1px solid var(--nv-line);scrollbar-width:none}
    .nv-side::-webkit-scrollbar{display:none}
    .nv-nav{flex:none;margin:0}.nv-split{grid-template-columns:minmax(0,1fr)}.nv-split.has .nv-detail{order:-1;position:static;max-height:none}
    .nv-brand{width:auto}.nv-brand small{display:none}.nv-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.nv-main{padding:16px 16px 48px}}
  @media (max-width:640px){.nv-search,.nv-ghost{display:none}}
  .nv-ctl-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:14px}
  .nv-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:10px}
  .nv-kpi{padding:12px 14px;border-radius:14px;border:1px solid var(--nv-line);background:var(--nv-bg)}
  .nv-kpi>span{display:block;font-size:12px;font-weight:700;color:var(--nv-muted)}
  .nv-kpi>b{display:flex;align-items:baseline;gap:8px;margin-top:2px;font-size:26px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .nv-kpi>b small{font-size:12.5px;font-weight:600;letter-spacing:0;color:var(--nv-muted)}
  .nv-kpi.live>b{color:#dc2626}
  .nv-kpi.warn>b{color:#c2410c}
  .nv-kpi .nv-bar{margin-top:8px}
  a.nv-kpi{color:inherit;text-decoration:none;transition:border-color .2s,box-shadow .2s}
  a.nv-kpi:hover{border-color:var(--nv-brand);box-shadow:0 4px 14px rgba(91,91,214,.12)}
  a.nv-kpi.sel{border-color:var(--nv-brand);box-shadow:0 0 0 3px rgba(91,91,214,.15)}
  .nv-kpi>span em{float:right;font-style:normal;font-weight:700;color:var(--nv-brand);opacity:.75}
  a.nv-kpi:hover>span em{opacity:1}
  .nv-wbar{display:flex;gap:2px;height:8px;border-radius:999px;background:var(--nv-line);overflow:hidden}
  .nv-wbar span{min-width:4px}
  .nv-wbar .done,.nv-legend i.done{background:#0f9d58}
  .nv-wbar .prog,.nv-legend i.prog{background:#5b5bd6}
  .nv-wbar .open,.nv-legend i.open{background:#c3c7d0}
  .nv-wbar .late,.nv-legend i.late{background:#dc2626}
  .nv-pp-sum{padding:14px 20px 12px;border-bottom:1px solid var(--nv-line)}
  .nv-dw-ask{padding:12px 20px 14px;border-top:1px solid var(--nv-line);background:var(--nv-bg)}
  .nv-ask-title{margin-bottom:6px;font-size:12px;font-weight:800;color:var(--nv-muted)}
  .nv-ask-row{display:flex;gap:8px;align-items:center}
  .nv-ask-row .nv-input{flex:1;min-width:0;margin:0}
  .nv-ask-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  .nv-ask-chip{padding:4px 11px;border:1px solid rgba(91,91,214,.3);border-radius:999px;background:rgba(91,91,214,.06);color:var(--nv-brand);font-size:12.5px;font-weight:700;cursor:pointer}
  .nv-ask-chip:hover{background:rgba(91,91,214,.14)}
  .nv-pp-sum .nv-wbar{height:12px}
  .nv-legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:10px;font-size:12.5px;color:var(--nv-muted)}
  .nv-legend span{display:inline-flex;align-items:center;gap:6px}
  .nv-legend i{width:9px;height:9px;border-radius:3px}
  .nv-legend b{color:var(--nv-fg,inherit);font-variant-numeric:tabular-nums}
  .nv-pp-tools{display:flex;align-items:center;gap:8px;padding:10px 20px;border-bottom:1px solid var(--nv-line)}
  .nv-pp-tools .nv-pp-q{flex:1;min-width:0;margin:0}
  .nv-pp-tools .nv-btn.on{border-color:#dc2626;color:#dc2626;background:rgba(220,38,38,.08)}
  .nv-seg{display:inline-flex;flex:none;padding:2px;border:1px solid var(--nv-line);border-radius:9px;background:var(--nv-sub)}
  .nv-seg button{padding:4px 11px;border:0;border-radius:7px;background:none;color:var(--nv-muted);font-size:12.5px;font-weight:700;cursor:pointer}
  .nv-seg button.on{background:var(--nv-bg);color:inherit;box-shadow:0 1px 3px rgba(0,0,0,.1)}
  .nv-pp{display:grid;grid-template-columns:12px 28px minmax(0,1fr) 110px 52px 78px;gap:10px;align-items:center;padding:10px 20px;border-bottom:1px solid var(--nv-line);cursor:pointer}
  .nv-pp:hover{background:var(--nv-sub)}
  .nv-pp.nested{padding-left:40px}
  .nv-pp.grp{background:var(--nv-sub)}
  .nv-pp.grp:hover{background:rgba(91,91,214,.07)}
  .nv-pp .nv-av{width:28px;height:28px}
  .nv-av.unit,.nv-av.org{border-radius:8px;background:#64748b}
  .nv-caret{color:var(--nv-muted);font-size:16px;line-height:1;transition:transform .15s}
  .nv-pp.open>.nv-caret{transform:rotate(90deg)}
  .nv-pp-who{min-width:0}
  .nv-pp-who b{display:block;overflow:hidden;font-size:13.5px;text-overflow:ellipsis;white-space:nowrap}
  .nv-pp-who small{display:block;overflow:hidden;font-size:12px;color:var(--nv-muted);text-overflow:ellipsis;white-space:nowrap}
  .nv-pp-n{text-align:right;font-variant-numeric:tabular-nums;line-height:1.2}
  .nv-pp-n b{display:block;font-size:13.5px}
  .nv-pp-n small{font-size:11.5px;color:var(--nv-muted)}
  .nv-pp-flag{text-align:right;font-size:12px;white-space:nowrap}
  .nv-due{font-weight:700}
  .nv-pp-body[hidden]{display:none}
  .nv-oi{display:flex;align-items:center;gap:10px;padding:9px 20px 9px 62px;border-bottom:1px dashed var(--nv-line);font-size:13px}
  .nv-pp.nested+.nv-pp-body .nv-oi{padding-left:82px}
  .nv-oi.done .nv-oi-text{color:var(--nv-muted);text-decoration:line-through}
  .nv-oi .nv-st{flex:none;min-width:58px;justify-content:center}
  .nv-oi-src{color:var(--nv-muted);text-decoration:underline;text-decoration-color:var(--nv-line);text-underline-offset:2px}
  .nv-oi-src:hover{color:var(--nv-brand)}
  .nv-tabs{display:flex;gap:2px;margin-bottom:12px;border-bottom:1px solid var(--nv-line);overflow-x:auto;scrollbar-width:none}
  .nv-tab{display:inline-flex;align-items:center;gap:7px;padding:9px 12px;border:0;border-bottom:2px solid transparent;background:none;color:var(--nv-muted);
    font-size:13.5px;font-weight:700;white-space:nowrap;cursor:pointer}
  .nv-tab:hover{color:inherit}
  .nv-tab.on{color:var(--nv-brand);border-bottom-color:var(--nv-brand)}
  .nv-tab .n{font-size:12px;font-weight:600;color:var(--nv-muted)}
  .nv-dotc{flex:none;width:8px;height:8px;border-radius:50%}
  .nv-ctl-grid{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;align-items:start}
  .nv-tbl-card{overflow-x:auto}
  .nv-tbl{width:100%;border-collapse:collapse;font-size:13.5px}
  .nv-tbl th{padding:9px 12px;background:var(--nv-sub);border-bottom:1px solid var(--nv-line);color:var(--nv-muted);font-size:12px;font-weight:700;text-align:left;white-space:nowrap}
  .nv-tbl td{padding:10px 12px;border-bottom:1px solid var(--nv-line);vertical-align:middle;white-space:nowrap}
  .nv-tbl .num{text-align:right;font-variant-numeric:tabular-nums}
  .nv-tbl tr.row{cursor:pointer}
  .nv-tbl tr.row:hover td{background:var(--nv-sub)}
  .nv-tbl tr.live td{background:rgba(220,38,38,.045)}
  .nv-tbl tr.sel td{background:rgba(91,91,214,.09)}
  .nv-tbl tr.sel td:first-child{box-shadow:inset 3px 0 0 var(--nv-brand)}
  .nv-tbl tr.grp td{padding:14px 12px 6px;border-bottom:0;background:transparent;color:var(--nv-muted);font-size:12px;font-weight:800;cursor:default}
  .nv-tbl .t-when b{display:block;font-size:13px}
  .nv-tbl .t-when small{font-size:12px;color:var(--nv-muted)}
  .nv-tbl .t-title{max-width:300px;overflow:hidden;text-overflow:ellipsis;font-weight:700}
  .nv-tbl .t-sub{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--nv-muted)}
  .dim{color:var(--nv-muted)}
  .nv-st{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;background:var(--nv-sub);color:var(--nv-muted);font-size:12px;font-weight:700;white-space:nowrap}
  .nv-st.ok{background:rgba(15,157,88,.12);color:#0f9d58}
  .nv-st.warn{background:rgba(234,88,12,.12);color:#c2410c}
  .nv-st.live{background:rgba(220,38,38,.12);color:#dc2626}
  .nv-st.plan{background:rgba(91,91,214,.1);color:var(--nv-brand)}
  .nv-st .nv-lamp{width:7px;height:7px}
  .nv-mini{display:inline-flex;align-items:center;gap:8px}
  .nv-mini .nv-bar{width:56px}
  .nv-bar{height:6px;border-radius:999px;background:var(--nv-line);overflow:hidden}
  .nv-bar span{display:block;height:100%;border-radius:999px;background:#0f9d58;transition:width .6s}
  .nv-feed{position:sticky;top:72px;max-height:calc(100vh - 96px);overflow:auto}
  .nv-day-sep{padding:12px 16px 4px;font-size:12px;font-weight:800;color:var(--nv-muted)}
  .nv-fi{display:grid;grid-template-columns:26px minmax(0,1fr) auto;gap:10px;align-items:start;padding:7px 16px;cursor:pointer}
  .nv-fi:hover{background:var(--nv-sub)}
  .nv-fi i{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:var(--nv-sub);color:var(--nv-muted)}
  .nv-fi i svg{width:14px;height:14px}
  .nv-fi.signal i,.nv-fi.alert i{background:rgba(220,38,38,.12);color:#dc2626}
  .nv-fi.final i{background:rgba(15,157,88,.12);color:#0f9d58}
  .nv-fi.change i,.nv-fi.schedule i{background:rgba(91,91,214,.12);color:var(--nv-brand)}
  .nv-fi.recording i,.nv-fi.draft i{background:rgba(234,88,12,.1);color:#c2410c}
  .nv-fi>div{font-size:13px;line-height:1.45}
  .nv-fi>div b{font-weight:700}
  .nv-fi time{padding-top:2px;font-size:12px;color:var(--nv-muted);font-variant-numeric:tabular-nums}
  .nv-fi.new{animation:nv-flash 3s ease}
  .nv-drawer{position:fixed;top:56px;right:0;bottom:0;z-index:30;display:flex;flex-direction:column;width:min(560px,100vw);
    background:var(--nv-bg);border-left:1px solid var(--nv-line);box-shadow:-18px 0 44px rgba(0,0,0,.13);animation:nv-slide .22s ease}
  .nv-drawer[hidden]{display:none}
  @keyframes nv-slide{from{transform:translateX(28px);opacity:0}to{transform:none;opacity:1}}
  .nv-dw-head{padding:18px 20px 14px;border-bottom:1px solid var(--nv-line)}
  .nv-dw-top{display:flex;align-items:center;gap:8px}
  .nv-dw-title{flex:1;min-width:0;font-size:18px;font-weight:800;letter-spacing:-.01em}
  .nv-x{padding:0 7px;border-radius:8px;color:var(--nv-muted);font-size:24px;line-height:1.1;text-decoration:none}
  .nv-x:hover{background:var(--nv-sub);color:inherit}
  .nv-dw-meta{margin-top:4px;font-size:12.5px;color:var(--nv-muted)}
  .nv-dw-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:14px}
  .nv-dw-stat{padding:8px 10px;border-radius:10px;background:var(--nv-sub)}
  .nv-dw-stat span{display:block;font-size:11.5px;font-weight:700;color:var(--nv-muted)}
  .nv-dw-stat b{font-size:16px;font-variant-numeric:tabular-nums}
  .nv-dw-tabs{display:flex;gap:2px;padding:0 12px;border-bottom:1px solid var(--nv-line)}
  .nv-dw-body{flex:1;overflow:auto;padding-bottom:20px}
  .nv-dw-body.fresh>*{animation:nv-in .45s ease both}
  .nv-dw-body.fresh>*:nth-child(2){animation-delay:.12s}.nv-dw-body.fresh>*:nth-child(3){animation-delay:.24s}.nv-dw-body.fresh>*:nth-child(4){animation-delay:.36s}
  @keyframes nv-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  .nv-dw-foot{display:flex;align-items:center;gap:12px;padding:12px 20px;border-top:1px solid var(--nv-line);background:var(--nv-sub)}
  .nv-dec{padding:12px 20px;border-bottom:1px solid var(--nv-line);font-size:14px;line-height:1.5}
  .nv-prem{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12.5px;color:var(--nv-muted)}
  .nv-prem>span:nth-child(2){flex:1;min-width:0}
  .nv-item{display:flex;align-items:center;gap:10px;padding:10px 20px;border-bottom:1px solid var(--nv-line)}
  .nv-av{display:inline-grid;place-items:center;flex:none;width:26px;height:26px;border-radius:50%;color:#fff;font-size:12px;font-weight:800}
  .nv-person{display:inline-flex;align-items:center;gap:6px;margin:0 10px 6px 0;font-size:13px}
  .nv-clip{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:380px}
  .nv-drawer .nv-mail{padding:10px 20px;border-top:0;border-bottom:1px solid var(--nv-line)}
  .nv-run{margin:12px 20px;border:1px solid var(--nv-line);border-radius:12px;overflow:hidden}
  .nv-run[hidden]{display:none}
  .nv-run-head{display:flex;justify-content:space-between;padding:9px 14px;background:var(--nv-sub);font-size:12.5px;font-weight:800;color:var(--nv-muted)}
  .nv-run-step{display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:10px;align-items:start;padding:10px 14px;border-top:1px solid var(--nv-line);opacity:.42;transition:opacity .3s}
  .nv-run-step.busy,.nv-run-step.done,.nv-run-step.failed{opacity:1}
  .nv-run-step b{font-size:13.5px}
  .nv-run-step code{display:block;margin-top:2px;color:var(--nv-muted);font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:normal}
  .nv-run-step time{padding-top:2px;font-size:12px;color:var(--nv-muted);font-variant-numeric:tabular-nums}
  .nv-run.folded .nv-run-step{padding:7px 14px}
  .nv-ic{width:16px;height:16px;margin-top:2px;border-radius:50%;border:2px solid var(--nv-line)}
  .nv-run-step.busy .nv-ic{border-color:rgba(91,91,214,.25);border-top-color:var(--nv-brand);animation:nv-turn .8s linear infinite}
  .nv-run-step.done .nv-ic{border-color:#0f9d58;background:#0f9d58;box-shadow:inset 0 0 0 3px var(--nv-bg)}
  .nv-run-step.failed .nv-ic{border-color:#dc2626;background:#dc2626}
  @keyframes nv-turn{to{transform:rotate(360deg)}}
  .nv-drawer .nv-drop{margin:4px 0}
  @media (max-width:1100px){.nv-ctl-grid{grid-template-columns:minmax(0,1fr)}.nv-feed{position:static;max-height:none}.nv-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media (max-width:760px){.nv-tbl .opt{display:none}.nv-dw-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
    .nv-pp{grid-template-columns:12px 28px minmax(0,1fr) 52px 70px}.nv-pp .nv-wbar{display:none}.nv-oi{padding-left:40px;flex-wrap:wrap}}`;

  function cardStyle() {
    if (document.getElementById('nv-card-style')) return;
    const s = document.createElement('style');
    s.id = 'nv-card-style';
    s.textContent = CARD_CSS;
    document.head.append(s);
  }

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c != null && c !== false && c !== '') node.append(c instanceof Node ? c : String(c));
    }
    return node;
  }

  async function api(endpoint, body = {}) {
    const res = await fetch(`/meetings/api/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    const error = data.error && (data.error.message || data.error);
    if (!res.ok || error) throw new Error(error || `요청 실패 (HTTP ${res.status})`);
    return data;
  }

  const dateLabel = (iso) => { const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]})`; };
  const when = (date, time) => `${dateLabel(date)}${time ? ` ${time}` : ''}`;
  const slot = (s) => `${s.starts_at.slice(11)}${s.ends_at ? `~${s.ends_at.slice(11)}` : ''}`;
  const todayIso = () => day(Date.now());
  function dueText(due) {
    if (!due) return ['기한 없음', ''];
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const left = Math.round((new Date(`${due}T00:00:00`) - start) / 86400000);
    if (left < 0) return [`${-left}일 지남`, 'nv-danger'];
    if (left === 0) return ['오늘 마감', 'nv-warn'];
    return [`D-${left} (${due.slice(5).replace('-', '/')})`, left <= 3 ? 'nv-warn' : ''];
  }

  // 채팅 입력창에 글을 넣고 보낸다 (확정처럼 Agent가 해야 하는 일). 회의 업무 화면에서는 새 회의지원 채팅에 보낸다.
  function ask(text) {
    const input = document.getElementById('chat-input');
    if (!input || !input.editor || !inMeetingChat()) { location.href = `/?models=${MODEL}&q=${encodeURIComponent(text)}`; return; }
    input.editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
    setTimeout(() => { const b = document.getElementById('send-message-button'); if (b && !b.disabled) b.click(); }, 150);
  }

  async function download(button, meetingId, kind) {
    button.disabled = true;
    try {
      const res = await fetch('/meetings/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify({ meeting_id: meetingId, kind }),
      });
      if (!res.ok || !(res.headers.get('content-type') || '').startsWith('application/pdf')) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `내려받지 못했습니다 (HTTP ${res.status})`);
      }
      const named = (res.headers.get('content-disposition') || '').match(/filename\*=UTF-8''([^;]+)/);
      const url = URL.createObjectURL(await res.blob());
      const a = h('a', { href: url, download: named ? decodeURIComponent(named[1]) : `${meetingId}.pdf` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      button.after(h('div', { class: 'nv-err' }, e.message));
    } finally {
      button.disabled = false;
    }
  }

  // 화면의 카드들: 하나에서 바꾼 것(완료 · 담당 · 검토 · 메일)이 같은 회의를 보여 주는 다른 카드에도 보이게 모두 다시 읽는다
  const mounted = new Map(); // 카드 → 다시 읽기
  function refreshAll() {
    for (const [node, load] of mounted) {
      if (node.isConnected) load(); else mounted.delete(node);
    }
  }

  // 버튼 하나의 동작: 누르는 동안 막고, 실패하면 그 아래에 이유를 보인다. 성공하면 화면의 카드를 모두 다시 읽는다.
  function act(fn) {
    return async (e) => {
      const b = e.currentTarget;
      if (b.nextElementSibling && b.nextElementSibling.classList.contains('nv-err')) b.nextElementSibling.remove();
      b.disabled = true;
      try { await fn(b); refreshAll(); } catch (err) { b.disabled = false; b.after(h('div', { class: 'nv-err' }, err.message)); }
    };
  }

  function shell(build, cls = 'nv-card') {
    cardStyle();
    const node = h('div', { class: cls }, h('div', { class: 'nv-loading' }, '불러오는 중…'));
    const load = async () => {
      try { node.replaceChildren(...[await build(load)].flat(Infinity).filter((c) => c != null && c !== '')); } catch (e) {
        node.replaceChildren(h('div', { class: 'nv-loading' }, `불러오지 못했습니다: ${e.message}`));
      }
    };
    mounted.set(node, load);
    load();
    return node;
  }

  const stat = (label, n, tone = '') => h('span', { class: `nv-chip ${tone}` }, `${label} ${n}`);
  const head = (title, meta, chip) => h('div', { class: 'nv-head' },
    h('div', { class: 'nv-grow' }, h('div', { class: 'nv-title' }, title), meta ? h('div', { class: 'nv-meta' }, meta) : ''), chip || '');
  const section = (title, rows) => h('div', { class: 'nv-sec' }, h('div', { class: 'nv-sec-title' }, title), rows);

  // 목소리가 등록되지 않은 발언자 ('화자 A', 예전 변환본은 '미확인 화자 1'): 사람이 아니므로 담당이면 실제 이름을 정해야 함
  const UNNAMED = /^(화자 [A-Z]{1,2}|미확인 화자( \d+)?)$/;
  const named = (owner) => !!owner && !UNNAMED.test(owner.trim());

  // 할 일 한 줄: 완료 · 진행 중, 담당 · 기한 지정 (확정된 회의록의 할 일이면 새 담당자에게 업무 배정 메일이 감)
  function itemRow(it, reload, withMeeting, open = false, splittable = false) {
    const [due, tone] = dueText(it.due);
    const done = it.status === 'done';
    const owner = h('input', { class: 'nv-input', value: named(it.owner) ? it.owner : '',
      placeholder: it.owner ? `${it.owner}의 실제 이름 (예: 박지훈 · 재무기획팀)` : '담당 (이름 또는 부서, 예: 박지훈 · 재무기획팀)' });
    const date = h('input', { class: 'nv-input', type: 'date', value: it.due || '' });
    const save = h('button', { class: 'nv-btn small primary', type: 'button', onclick: act(async () => {
      const body = { item_id: it.id };
      if (owner.value.trim() && owner.value.trim() !== (it.owner || '')) body.owner = owner.value.trim();
      if (date.value && date.value !== it.due) body.due = date.value;
      if (!body.owner && !body.due) throw new Error('바꿀 담당이나 기한을 넣어 주세요');
      const out = await api('items', body);
      const sent = (out.mail_queued || []).map((m) => m.to).join(', ');
      if (sent) notice(`업무 배정 메일을 보냈습니다: ${sent}`);
      reload();
    }) }, '저장');
    const editor = h('div', { class: 'nv-assign', hidden: !open }, owner, date, save);
    return h('div', { class: 'nv-row top' },
      h('div', { class: 'nv-grow' }, h('div', {}, it.text),
        h('div', { class: 'nv-meta' }, h('span', { class: it.due ? tone : 'nv-danger' }, due), ' · ',
          h('span', { class: named(it.owner) ? '' : 'nv-danger' }, it.owner ? (named(it.owner) ? it.owner : `${it.owner} (이름 지정 필요)`) : '담당 미정'),
          withMeeting && it.meeting ? ` · ${it.meeting.title}` : '', ` · ${ITEM[it.status] || it.status}`),
        editor),
      done ? h('span', { class: 'nv-chip final' }, '완료') : h('div', { class: 'nv-btns' },
        splittable && !it.owner ? h('button', { class: 'nv-btn small', type: 'button', title: '각자 하는 일: 참석자마다 한 건씩 만들고 이 항목은 지웁니다',
          onclick: act(async () => { const out = await api('items', { item_id: it.id, action: 'split' }); notice(`참석자 ${out.items.length}명에게 나눴습니다`); reload(); }) }, '참석자마다 나누기') : '',
        h('button', { class: 'nv-btn small', type: 'button', onclick: () => { editor.hidden = !editor.hidden; } }, '담당·기한'),
        it.status === 'open' ? h('button', { class: 'nv-btn small', type: 'button', onclick: act(async () => { await api('items', { item_id: it.id, status: 'in_progress' }); reload(); }) }, '진행 중') : '',
        h('button', { class: 'nv-btn small', type: 'button', onclick: act(async () => { await api('items', { item_id: it.id, status: 'done' }); doneItems.set(it.id, { ...it, status: 'done' }); reload(); }) }, '완료')));
  }

  // 카드 위에 잠깐 뜨는 알림 (메일을 보냈다는 등)
  function notice(text) {
    cardStyle();
    const n = h('div', { class: 'nv-notice', role: 'status' }, text);
    document.body.append(n);
    setTimeout(() => n.remove(), 4000);
  }

  function flagRows(meetingId, flags, reload) {
    return flags.map((f) => {
      const note = h('input', { class: 'nv-input', placeholder: '조치 내용 (예: 발언 직후 제지, 임직원 공지 예정)', hidden: true });
      const review = (status) => act(async () => {
        if (status === 'acknowledged' && (note.hidden || !note.value.trim())) { note.hidden = false; note.focus(); throw new Error('조치 내용을 적고 다시 눌러 주세요'); }
        await api('flags', { action: 'review', meeting_id: meetingId, reviews: [{ id: f.id, status, note: note.value.trim() || null }] });
        reload();
      });
      return h('div', { class: 'nv-row top' },
        h('div', { class: 'nv-grow' }, h('div', { class: 'nv-meta' }, `${f.id} · ${f.location} · ${f.rule}`), h('div', {}, f.excerpt), note),
        h('div', { class: 'nv-btns' },
          h('button', { class: 'nv-btn small', type: 'button', onclick: review('cleared') }, '문제없음'),
          h('button', { class: 'nv-btn small', type: 'button', onclick: review('acknowledged') }, '조치함')));
    });
  }

  // 사람 고르기: 이 회의 사람 빠른 선택 + 회사 계정 찾기 (이름 · 이메일 일부)
  function personPicker(quick, onPick, placeholder) {
    const list = h('div', { class: 'nv-pick-list' });
    const input = h('input', { class: 'nv-input', type: 'search', placeholder });
    const pick = (p) => h('button', { class: 'nv-btn small', type: 'button', onclick: act(async () => { await onPick(p); }) },
      p.name, p.email ? h('span', { class: 'nv-meta' }, ` ${p.email}`) : '');
    const showQuick = () => list.replaceChildren(...quick.map(pick));
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) { showQuick(); return; }
      timer = setTimeout(async () => {
        try {
          const d = await api('people', { query: q });
          list.replaceChildren(...(d.people.length ? d.people.map(pick) : [h('span', { class: 'nv-meta' }, '회사 계정에서 찾지 못했습니다')]));
        } catch (e) { list.replaceChildren(h('span', { class: 'nv-err' }, e.message)); }
      }, 250);
    });
    showQuick();
    return h('div', { class: 'nv-pick' }, input, list);
  }

  const VOICE = {
    learned: '목소리를 익혔습니다. 다음 회의부터 이름으로 적습니다.',
    no_consent: '출석할 때 목소리 학습에 동의하지 않아 목소리는 익히지 않았습니다.',
    too_short: '발언이 짧아 목소리는 익히지 않았습니다.',
    expired: '녹음한 지 오래되어 목소리는 익히지 않았습니다.',
  };

  // 참석자 확인: QR 출석 · 발언 여부, 이름을 정할 목소리('화자 C'), 말하지 않은 참석자 더하기
  function attendanceSection(d, reload) {
    const a = d.attendance;
    const m = d.meeting;
    if (!a || (!a.people.length && !a.unknown_speakers.length)) return '';
    const editable = m.status !== 'final' && d.can_edit;
    const quick = a.people.filter((p) => !p.spoke).concat(a.people.filter((p) => p.spoke))
      .map((p) => ({ name: p.name.replace(/\s*\([^()]*\)$/, ''), email: p.email }));
    const assign = (label) => async (p) => {
      const out = await api('attendance', { action: 'assign', meeting_id: m.id, speaker: label, person: p });
      notice(`${label} = ${out.person}${VOICE[out.voice] ? ` · ${VOICE[out.voice]}` : ''}`);
      reload();
    };
    const people = a.people.map((p) => h('span', { class: `nv-chip ${p.checked_in ? 'ok' : ''}`, title: p.email || '' },
      p.name, p.checked_in ? ' · QR' : '', a.recorded ? (p.spoke ? ' · 발언' : ' · 발언 없음') : '',
      editable && !p.checked_in && !p.spoke ? h('span', { role: 'button', tabindex: '0', title: '참석자에서 빼기', style: 'cursor:pointer;margin-left:2px',
        onclick: act(async () => { await api('attendance', { action: 'remove', meeting_id: m.id, person: { name: p.name, email: p.email } }); reload(); }) }, '×') : ''));
    const voices = a.unknown_speakers.map((v) => {
      const sure = a.suggestion && a.suggestion.speaker === v.label ? a.suggestion : null;
      const picker = h('div', { hidden: !!sure }, editable ? personPicker(quick, assign(v.label), `${v.label}은(는) 누구인가요? 이름 · 이메일로 찾기`) : '');
      return h('div', { class: 'nv-row top' },
        h('span', { class: 'nv-tag' }, v.label),
        h('div', { class: 'nv-grow' },
          h('div', { class: 'nv-meta' }, `발언 ${v.turns}번 · ${v.seconds}초 · ${v.first}`),
          sure ? h('div', {}, h('span', { class: 'nv-warn' }, `출석했지만 목소리가 없는 사람은 ${sure.name}뿐입니다. ${sure.name}인가요?`)) : '',
          picker),
        editable ? h('div', { class: 'nv-btns' },
          sure ? h('button', { class: 'nv-btn small primary', type: 'button', onclick: act(async () => { await assign(v.label)({ name: sure.name, email: sure.email }); }) }, `${sure.name} 맞음`) : '',
          sure ? h('button', { class: 'nv-btn small', type: 'button', onclick: () => { picker.hidden = !picker.hidden; } }, '다른 사람') : '') : '');
    });
    const adder = h('div', { hidden: true }, personPicker([], async (p) => {
      await api('attendance', { action: 'add', meeting_id: m.id, person: p });
      reload();
    }, '말하지 않은 참석자 찾기 — 이름 · 이메일'));
    const checked = a.people.filter((p) => p.checked_in).length;
    const title = `참석자 확인 — ${a.people.length}명${checked ? ` · QR 출석 ${checked}명` : ''}${a.silent.length ? ` · 말하지 않은 참석자 ${a.silent.length}명` : ''}`;
    return h('div', { class: 'nv-sec' },
      h('div', { class: 'nv-sec-title' }, title),
      h('div', { class: 'nv-who' }, people),
      voices.length ? h('div', { class: 'nv-meta', style: 'margin-top:8px' }, '목소리로 이름을 찾지 못한 발언자 — 누구인지 정하면 발언 · 담당이 그 사람으로 바뀝니다') : '',
      voices,
      editable ? h('div', { style: 'margin-top:6px' }, h('button', { class: 'nv-btn small', type: 'button', onclick: () => { adder.hidden = !adder.hidden; } }, '참석자 더하기'), adder) : '');
  }

  // 이전 회의에서 이어지는 일: 이번 참석자들이 맡아 아직 열린 일, 같은 사람들이 있던 회의의 미결 쟁점
  function recallSection(d) {
    const r = d.recall;
    if (!r || (!r.open_items.length && !r.open_issues.length)) return '';
    const from = (x) => `${x.meeting.title} (${x.meeting.date.slice(5).replace('-', '/')})`;
    return section(`이전 회의에서 이어지는 일 ${r.open_items.length + r.open_issues.length}건`, [
      ...r.open_items.map((it) => h('div', { class: 'nv-row top' }, h('span', { class: 'nv-tag' }, '할 일'),
        h('div', { class: 'nv-grow' }, h('div', {}, it.text), h('div', { class: 'nv-meta' }, `${it.owner} · `,
          h('span', { class: it.overdue_days ? 'nv-danger' : '' }, it.overdue_days ? `${it.overdue_days}일 지남` : (it.due ? `기한 ${it.due}` : '기한 없음')),
          ` · ${from(it)}`)))),
      ...r.open_issues.map((x) => h('div', { class: 'nv-row top' }, h('span', { class: 'nv-tag' }, '쟁점'),
        h('div', { class: 'nv-grow' }, h('div', {}, x.statement), h('div', { class: 'nv-meta' }, from(x))))),
    ]);
  }

  // 결정의 전제 · 조건: 회의가 끝난 뒤 뉴스 · 보고가 흔들면 상태가 바뀐다 (회의지원 Agent가 지켜봄)
  function premiseSection(m) {
    const rows = [];
    for (const x of m.decisions) {
      for (const p of x.premises || []) {
        const [label, tone] = PREMISE[p.status] || [p.status, ''];
        const news = (p.signals || [])[0];
        rows.push(h('div', { class: 'nv-row top' },
          h('span', { class: 'nv-tag' }, p.kind === 'condition' ? '조건' : '전제'),
          h('div', { class: 'nv-grow' }, h('div', {}, p.statement),
            h('div', { class: 'nv-meta' }, [p.review_when ? `재검토: ${p.review_when}` : '', p.due ? `기한 ${p.due}` : '', p.source || p.speaker || '', x.ref].filter(Boolean).join(' · ')),
            news ? h('div', { class: `nv-meta ${news.effect === 'broken' ? 'nv-danger' : 'nv-warn'}` },
              `${news.source || ''} ${news.date || ''} · ${news.headline}${news.reason ? ` — ${news.reason}` : ''}`) : ''),
          h('span', { class: `nv-chip ${tone}` }, label)));
      }
    }
    return rows.length ? section(`결정의 전제 · 조건 ${rows.length}건 — 회의가 끝난 뒤에도 지켜봅니다`, rows) : '';
  }

  function minutesView(d, reload) {
    const m = d.meeting;
    const open = (d.flags || []).filter((f) => f.status === 'open');
    const missing = m.status === 'final' ? [] : m.open_action_items.filter((it) => !named(it.owner) || !it.due);
    const decided = m.decisions.filter((x) => ['decision', 'resolution', 'criterion'].includes(x.kind));
    const people = (d.participants || []).map((p) => `${p.name}${ROLE[p.role] ? ` · ${ROLE[p.role]}` : ''}`);
    const details = h('div', { hidden: true },
      m.decisions.length ? section('결정 · 기준 · 의견', m.decisions.map((x) => h('div', { class: 'nv-row top' },
        h('span', { class: `nv-tag ${['decision', 'resolution', 'criterion'].includes(x.kind) ? 'brand' : ''}` }, KIND[x.kind] || x.kind),
        h('div', { class: 'nv-grow' }, h('div', {}, x.statement), x.speaker || x.source ? h('div', { class: 'nv-meta' }, x.source || x.speaker) : '')))) : '',
      m.open_issues.length ? section('미결 쟁점', m.open_issues.map((x) => h('div', { class: 'nv-row' }, h('div', { class: 'nv-grow' }, x.statement)))) : '',
      m.open_action_items.length ? section('열린 할 일', m.open_action_items.map((it) => itemRow(it, reload, false, false, m.status !== 'final' && d.can_edit))) : '');
    const more = h('button', { class: 'nv-btn', type: 'button', onclick: () => { details.hidden = !details.hidden; more.textContent = details.hidden ? '자세히' : '접기'; } }, '자세히');
    return [
      head(h('span', {}, m.title, m.classification >= 3 ? h('span', { class: 'nv-chip secret' }, LEVEL[m.classification]) : ''),
        `${when(m.date, m.time)} · ${m.id}`,
        h('span', { class: `nv-chip ${m.status === 'final' ? 'final' : 'draft'}` }, m.status === 'final' ? '확정' : '초안')),
      people.length && !d.attendance ? h('div', { class: 'nv-people' }, `참석 ${people.join(', ')}`) : '',
      m.summary ? h('div', { class: 'nv-summary' }, m.summary) : '',
      h('div', { class: 'nv-stats' }, stat('결정', decided.length), stat('열린 할 일', m.open_action_items.length),
        m.open_issues.length ? stat('미결 쟁점', m.open_issues.length) : '', open.length ? stat('위험 발언', open.length, 'draft') : ''),
      open.length ? section(`위험 발언 검토 ${open.length}건 — 검토해야 확정할 수 있습니다`, flagRows(m.id, open, reload)) : '',
      premiseSection(m),
      attendanceSection(d, reload),
      missing.length ? section(`담당 · 기한을 정해야 확정할 수 있습니다 (${missing.length}건)`, missing.map((it) => itemRow(it, reload, false, true, m.status !== 'final' && d.can_edit))) : '',
      recallSection(d),
      details,
      h('div', { class: 'nv-actions' }, more,
        h('button', { class: 'nv-btn', type: 'button', onclick: (e) => download(e.currentTarget, m.id, 'minutes') }, '회의록 PDF'),
        h('button', { class: 'nv-btn', type: 'button', onclick: (e) => download(e.currentTarget, m.id, 'report') }, '결과 보고서 PDF'),
        m.status !== 'final' && !open.length && !missing.length && d.can_confirm
          ? h('button', { class: 'nv-btn primary', type: 'button', title: '확정하면 참석자 회의록 메일과 담당자 업무 배정 메일이 나갑니다', onclick: () => ask(`${m.id} 회의록을 확정해 줘.`) }, '확정 요청 · 메일 발송') : '',
        m.status !== 'final' && d.can_confirm && (open.length || missing.length)
          ? h('span', { class: 'nv-meta', style: 'align-self:center' }, '위 항목을 정리하면 확정할 수 있습니다') : ''),
    ];
  }

  function scheduledView(s, reload) {
    const live = s.status === 'scheduled' && s.starts_at.slice(0, 10) === todayIso();
    return [
      head(h('span', {}, s.title, s.classification >= 3 ? h('span', { class: 'nv-chip secret' }, LEVEL[s.classification]) : ''),
        `${dateLabel(s.starts_at)} ${slot(s)}${s.location ? ` · ${s.location}` : ''} · ${s.id}`,
        h('span', { class: `nv-chip ${s.status === 'scheduled' ? '' : 'draft'}` }, s.status === 'scheduled' ? '예정' : s.status === 'cancelled' ? '취소' : s.status)),
      s.participants && s.participants.length
        ? h('div', { class: 'nv-people' }, `참석 대상 ${s.participants.map((p) => `${p.name}${ROLE[p.role] ? ` · ${ROLE[p.role]}` : ''}`).join(', ')}`) : '',
      s.agenda && s.agenda.length ? section('안건', s.agenda.map((a) => h('div', { class: 'nv-row top' },
        h('span', { class: `nv-tag ${a.carried_from ? 'brand' : ''}` }, a.carried_from ? '이월' : String(a.seq)), h('div', { class: 'nv-grow' }, a.title)))) : '',
      s.status === 'scheduled' ? h('div', { class: 'nv-actions' },
        live ? h('button', { class: 'nv-btn rec', type: 'button', onclick: () => startRecording(s.id) }, '이 회의 녹음 시작') : '',
        h('button', { class: 'nv-btn', type: 'button', onclick: act(async () => {
          if (!window.confirm(`'${s.title}' 회의를 취소할까요? 참석 대상에게 취소 안내 메일이 나갑니다.`)) throw new Error('취소하지 않았습니다');
          await api('schedule', { action: 'cancel', meeting_id: s.id });
          reload();
        }) }, '회의 취소')) : '',
    ];
  }

  function meetingCard(id) {
    return shell(async (reload) => {
      const d = await api('meeting', { meeting_id: id });
      return d.scheduled ? scheduledView(d.scheduled, reload) : minutesView(d, reload);
    });
  }

  // 회의 한 줄 (누르면 그 아래에 회의 카드를 펼침)
  function meetingRow(id, title, meta, chip, extra) {
    const holder = h('div', {});
    const toggle = () => { if (holder.firstChild) holder.replaceChildren(); else holder.append(meetingCard(id)); };
    return [h('div', { class: 'nv-row click', role: 'button', tabindex: '0', onclick: toggle, onkeydown: (e) => { if (e.key === 'Enter') toggle(); } },
      h('div', { class: 'nv-grow' }, h('div', { class: 'nv-strong' }, title), h('div', { class: 'nv-meta' }, meta)), chip, extra || ''), holder];
  }

  function meetingsCard(ids) {
    return shell(async () => {
      const found = await Promise.all(ids.map((id) => api('meeting', { meeting_id: id }).catch(() => null)));
      const rows = found.map((d, i) => {
        if (!d) return '';
        if (d.scheduled) {
          const s = d.scheduled;
          return meetingRow(ids[i], s.title, `${dateLabel(s.starts_at)} ${slot(s)} · ${ids[i]}`, h('span', { class: 'nv-chip' }, '예정'));
        }
        const m = d.meeting;
        return meetingRow(ids[i], m.title, `${when(m.date, m.time)} · ${ids[i]}`,
          h('span', { class: `nv-chip ${m.status === 'final' ? 'final' : 'draft'}` }, m.status === 'final' ? '확정' : '초안'));
      });
      return [head(`회의 ${found.filter(Boolean).length}건`, '누르면 펼쳐집니다'), h('div', { class: 'nv-sec' }, rows)];
    });
  }

  function itemsCard(ids) {
    return shell(async (reload) => {
      const d = await api('items', { view: 'all' });
      const byId = Object.fromEntries((d.items || []).map((i) => [i.id, i]));
      const rows = ids.map((id) => {
        const it = byId[id] || doneItems.get(id);
        return it ? itemRow(it, reload, true) : h('div', { class: 'nv-row' }, h('div', { class: 'nv-grow nv-meta' }, id), h('span', { class: 'nv-chip' }, '닫힘'));
      });
      return [head(`할 일 ${ids.length}건`, d.as_of ? `기준 ${d.as_of}` : ''), h('div', { class: 'nv-sec' }, rows)];
    });
  }

  function mailRow(m, reload) {
    const tone = m.status === 'sent' ? 'final' : ['failed', 'needs_address'].includes(m.status) ? 'draft' : '';
    return h('div', { class: 'nv-row' },
      h('div', { class: 'nv-grow' }, h('div', {}, m.subject),
        h('div', { class: 'nv-meta' }, `${m.to}${m.email ? ` <${m.email}>` : ''} · ${MAIL_KIND[m.kind] || m.kind}${m.sent_at ? ` · ${m.sent_at}` : ''}`)),
      h('span', { class: `nv-chip ${tone}` }, MAIL[m.status] || m.status),
      h('div', { class: 'nv-btns' },
        m.status === 'failed' ? h('button', { class: 'nv-btn small', type: 'button', onclick: act(async () => { await api('mail', { action: 'resend', mail_ids: [m.id] }); reload(); }) }, '다시 보내기') : '',
        m.status === 'needs_address' ? h('button', { class: 'nv-btn small', type: 'button', onclick: act(async () => {
          const email = window.prompt(`${m.to}의 메일 주소`);
          if (!email) throw new Error('주소를 넣지 않았습니다');
          await api('mail', { action: 'set_address', mail_ids: [m.id], email: email.trim() });
          reload();
        }) }, '주소 입력') : '',
        ['needs_address', 'approved', 'pending', 'failed'].includes(m.status) ? h('button', { class: 'nv-btn small', type: 'button', onclick: act(async () => { await api('mail', { action: 'reject', mail_ids: [m.id] }); reload(); }) }, '취소') : ''));
  }

  function mailCard(ids) {
    return shell(async (reload) => {
      const d = await api('mail', { action: 'list' });
      const byId = Object.fromEntries((d.mails || []).map((m) => [m.id, m]));
      const rows = ids.map((id) => (byId[id] ? mailRow(byId[id], reload) : h('div', { class: 'nv-row nv-meta' }, `${id} · 지난 메일`)));
      return [head(`메일 ${ids.length}건`, d.smtp_configured === false ? '메일 서버가 설정되지 않아 발송 대기 중입니다' : ''), h('div', { class: 'nv-sec' }, rows)];
    });
  }

  // ---------------------------------------------------------------------------
  // 회의 업무 화면 (/meetings/): 위 검색 · 왼쪽 메뉴(건수) · 본문 — Linear · Gmail처럼 목록을 누르면 옆에 그 회의 카드가 열린다.
  // 구역은 주소의 # (#home · #inbox · #minutes · #schedule · #items · #mail, 고른 회의는 #minutes/MTG-…), 뒤로 가기가 된다.
  // 카드와 버튼은 채팅의 회의 카드와 같고, Agent가 해야 하는 일(재검토 제안 · 확정)은 새 회의지원 채팅으로 보낸다.
  // ---------------------------------------------------------------------------
  const CALENDAR = 'M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5';
  const ICON = {
    home: 'M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0V12a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 12V5.25',
    inbox: 'M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H6.911a2.25 2.25 0 0 0-2.15 1.588L2.35 13.177a2.25 2.25 0 0 0-.1.661Z',
    minutes: 'M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z',
    schedule: CALENDAR,
    items: 'M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
    mail: 'M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75',
    change: 'M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5',
    signal: 'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z',
    mic: 'M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z',
    search: 'm21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z',
  };
  const SECTIONS = [['home', '관제'], ['inbox', '확인할 일'], ['minutes', '회의록'], ['schedule', '일정'], ['items', '할 일'], ['mail', '메일']];
  const DUE_GROUPS = ['기한 지남', '오늘', '7일 안', '나중에', '기한 없음'];
  const MAIL_FILTERS = [
    ['all', '전체', () => true],
    ['unsent', '보내지 못함', (m) => ['failed', 'needs_address'].includes(m.status)],
    ['waiting', '보내는 중 · 대기', (m) => ['pending', 'approved'].includes(m.status)],
    ['sent', '보냄', (m) => m.status === 'sent'],
  ];
  let deskQuery = ''; // 회의록 검색어 (위 검색창 · 회의록 목록이 같이 씀)
  let deskStatus = ''; // 회의록 초안/확정 거르기

  const deskRoute = () => {
    const [key, a, b] = location.hash.slice(1).split('/').map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
    if (key === 'topic' && a) return { key, subject: a, id: b || null };
    return { key: SECTIONS.some(([k]) => k === key) ? key : 'home', id: a || null };
  };
  const deskLink = (key, id) => `#${key}${id ? `/${encodeURIComponent(id)}` : ''}`;

  function svgIcon(d) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('d', d);
    svg.append(path);
    return svg;
  }

  const minutesChip = (status) => h('span', { class: `nv-chip ${status === 'final' ? 'final' : 'draft'}` }, status === 'final' ? '확정' : '초안');
  const empty = (text) => h('div', { class: 'nv-empty' }, text);

  // 목록 한 줄: 누르면 그 구역 옆에 회의 카드가 열린다 (안의 버튼 · 입력은 그대로 동작)
  function listItem({ key, id, dot, title, meta, chips, extra, href }) {
    const r = deskRoute();
    const open = () => { location.hash = href || deskLink(key, id); };
    return h('div', { class: `nv-li${r.key === key && r.id === id ? ' sel' : ''}`, 'data-id': id, role: 'link', tabindex: '0',
      onclick: (e) => { if (!e.target.closest('button, input, a, select')) open(); },
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(); } },
      dot ? h('span', { class: `nv-dot ${dot}` }) : '',
      h('div', { class: 'nv-grow' }, h('div', { class: 'nv-strong' }, title), meta ? h('div', { class: 'nv-meta' }, meta) : '', extra || ''),
      chips ? h('div', { class: 'nv-btns', style: 'align-items:center' }, chips) : '');
  }

  const minutesItem = (m, key) => listItem({ key, id: m.id, dot: m.status === 'final' ? 'ok' : 'warn', title: m.title, meta: `${when(m.date, m.time)} · ${m.id}`,
    chips: [m.open_flags ? h('span', { class: 'nv-chip draft' }, `위험 발언 ${m.open_flags}`) : '', minutesChip(m.status)] });

  // 전제가 흔들린 결정 (뉴스 · 보고 신호): 재검토를 Agent에게 맡기거나 '문제없음'으로 닫는다. 누르면 그 결정의 회의록
  function watchItem(s, reload, key) {
    const broken = s.effect === 'broken';
    return listItem({ key, id: s.meeting.id, dot: broken ? 'danger' : 'warn', title: s.decision.statement,
      meta: `${s.decision.ref} · ${s.meeting.title} (${s.meeting.date})`,
      chips: h('span', { class: `nv-chip ${broken ? 'danger' : 'draft'}` }, broken ? '전제 깨짐' : '전제 흔들림'),
      extra: h('div', {},
        h('div', { style: 'margin-top:4px' }, `${s.premise.kind === 'condition' ? '조건' : '전제'}: ${s.premise.statement}`),
        h('div', { class: `nv-meta ${broken ? 'nv-danger' : 'nv-warn'}` }, `${s.news.source || ''} ${s.news.date || ''} · ${s.news.headline}`),
        s.reason ? h('div', { class: 'nv-meta' }, `판단: ${s.reason}${s.judged === 'keywords' ? ' (확인 필요)' : ''}`) : '',
        h('div', { class: 'nv-btns', style: 'margin-top:8px' },
          h('button', { class: 'nv-btn small primary', type: 'button', onclick: () => ask(`${s.decision.ref} 결정의 전제가 흔들렸어. 지금 상태를 정리하고 재검토 회의를 제안해 줘.`) }, '재검토 제안'),
          h('button', { class: 'nv-btn small', type: 'button', onclick: act(async () => { await api('watch', { action: 'dismiss', signal_id: s.id }); reload(); }) }, '문제없음'))) });
  }

  // 다가오는 회의를 날짜별로 (Google Calendar의 일정 보기처럼). 오늘 회의는 바로 녹음
  function agenda(meetings, key, today) {
    const days = new Map();
    for (const s of meetings) {
      const d = s.starts_at.slice(0, 10);
      if (!days.has(d)) days.set(d, []);
      days.get(d).push(s);
    }
    return [...days].map(([d, list]) => {
      const dt = new Date(`${d}T00:00:00`);
      return h('div', { class: 'nv-day' },
        h('div', { class: 'nv-day-label' }, `${dt.getMonth() + 1}월 ${dt.getDate()}일`, h('small', {}, `${d === today ? '오늘 · ' : ''}${WEEK[dt.getDay()]}요일`)),
        h('div', { class: 'nv-grow' }, list.map((s) => listItem({ key, id: s.id, title: s.title, meta: `${slot(s)}${s.location ? ` · ${s.location}` : ''}`,
          chips: d === today ? h('button', { class: 'nv-btn small rec', type: 'button', onclick: () => startRecording(s.id) }, '녹음 시작') : h('span', { class: 'nv-chip' }, '예정') }))));
    });
  }

  const cardHead = (title, meta, href) => h('div', { class: 'nv-head' },
    h('div', { class: 'nv-grow' }, h('div', { class: 'nv-title' }, title), meta ? h('div', { class: 'nv-meta' }, meta) : ''),
    href ? h('a', { class: 'nv-more', href }, '모두 보기 →') : '');

  // 회의 관제 — 지표 4개 (Stripe · Vercel 대시보드처럼), 주제 탭으로 거르기 (GitHub 필터처럼), 회의 표 (Linear · Notion 표처럼:
  // 일시 · 회의 · 주제 · 녹음 · 회의록 · 결정 · 분공 · 메일), 오른쪽에는 회의 Agent의 활동 (날짜별, GitHub 활동처럼).
  // 회의를 누르면 오른쪽에서 회의 칸이 열린다 (Linear · Notion의 옆 보기): 개요 · 결정 · 분공 · 메일 탭, 진행 중인 회의는 녹음을 놓는 곳과
  // 처리 단계 (GitHub Actions · Vercel 배포 기록처럼 단계마다 걸린 시간). 표 · 활동은 10초마다 다시 읽는다. 주제 화면은 #topic/주제.
  const STATE = { alarm: ['이상', 'danger'], warn: ['주의', 'draft'], ok: ['정상', 'final'] };
  const LIVE_MS = 10000;
  const LAMP = { alarm: '#dc2626', warn: '#ea580c', ok: '#0f9d58' };
  const AVATAR = ['#5b5bd6', '#0f9d58', '#c2410c', '#0b6f83', '#9a3fb8', '#b45309'];
  const FEED_ICON = { recording: 'mic', draft: 'minutes', final: 'items', change: 'change', signal: 'signal', alert: 'mail', mail: 'mail', schedule: 'schedule' };
  let seenLog = null; // 이 화면에서 이미 본 상황 기록
  let ctlFilter = ''; // 주제 탭

  const topicLink = (subject, id) => `#topic/${encodeURIComponent(subject)}${id ? `/${encodeURIComponent(id)}` : ''}`;
  const md = (iso) => iso.slice(5, 10).replace('-', '/');
  const tone = (state) => (state === 'alarm' ? 'nv-danger' : state === 'warn' ? 'nv-warn' : '');
  const mmss = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  const minutesSince = (kstMinute) => Math.max(0, Math.round((Date.now() - new Date(`${kstMinute.replace(' ', 'T')}:00+09:00`)) / 60000));
  const dayName = (iso, today) => (iso === today ? '오늘' : `${dateLabel(iso)}`);
  // Open WebUI가 올린 파일은 '<uuid>_<URL 인코딩된 이름>'으로 남는다 → 사람이 올린 이름으로
  const fileName = (name) => { let n = name || ''; try { n = decodeURIComponent(n); } catch { /* 그대로 */ } return n.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_/i, ''); };

  function avatar(name) {
    const n = (name || '?').replace(/\s*\(.*$/, '');
    let hash = 0;
    for (const ch of n) hash = (hash * 31 + ch.codePointAt(0)) % 997;
    return h('span', { class: 'nv-av', style: `background:${AVATAR[hash % AVATAR.length]}`, title: name }, n.slice(0, 1));
  }

  const progressBar = (done, total) => h('div', { class: 'nv-bar' }, h('span', { style: `width:${total ? Math.round((done / total) * 100) : 0}%` }));

  function kpis(d) {
    const live = d.meetings.filter((m) => m.phase === 'live');
    const next = d.meetings.find((m) => m.phase === 'upcoming');
    const items = d.meetings.reduce((a, m) => (m.items ? [a[0] + m.items.done, a[1] + m.items.total, a[2] + m.items.overdue] : a), [0, 0, 0]);
    const kpi = (cls, label, value, small, extra, id) => h(id ? 'a' : 'div', id ? { class: `nv-kpi link ${cls}${deskRoute().id === id ? ' sel' : ''}`, href: deskLink('home', id), 'data-kpi': id } : { class: `nv-kpi ${cls}` },
      h('span', {}, label, id ? h('em', {}, '담당자별 →') : ''), h('b', {}, value, small ? h('small', {}, small) : ''), extra || '');
    return h('div', { class: 'nv-kpis' },
      kpi(live.length ? 'live' : '', '진행 중인 회의', String(live.length), live[0] ? (live[0].title.length > 15 ? `${live[0].title.slice(0, 14)}…` : live[0].title) : '없음'),
      kpi('', '예정된 회의', String(d.meetings.filter((m) => m.phase === 'upcoming').length), next ? `다음 ${md(next.starts_at)} ${next.starts_at.slice(11)}` : ''),
      kpi(d.counts.alarm ? 'live' : d.counts.warn ? 'warn' : '', '확인이 필요한 주제', String(d.counts.alarm + d.counts.warn),
        d.counts.alarm ? `이상 ${d.counts.alarm} · 주의 ${d.counts.warn}` : `주의 ${d.counts.warn}`),
      kpi(items[2] ? 'warn' : '', '분공 진행', `${items[1] ? Math.round((items[0] / items[1]) * 100) : 0}%`, `${items[0]}/${items[1]}${items[2] ? ` · 지남 ${items[2]}` : ''}`, progressBar(items[0], items[1]), 'people'));
  }

  function subjectTabs(d, reload) {
    const count = (s) => d.meetings.filter((m) => !s || m.subject === s).length;
    const tab = (key, label, state) => h('button', { class: `nv-tab${ctlFilter === key ? ' on' : ''}`, type: 'button', onclick: () => { ctlFilter = key; reload(); } },
      state ? h('span', { class: 'nv-dotc', style: `background:${LAMP[state]}` }) : '', label, h('span', { class: 'n' }, String(count(key))));
    return h('div', { class: 'nv-tabs' }, tab('', '전체'), d.screens.map((s) => tab(s.subject, s.subject, s.state)));
  }

  function meetingTable(d) {
    const sel = deskRoute().id;
    const state = Object.fromEntries(d.screens.map((s) => [s.subject, s.state]));
    const rows = d.meetings.filter((m) => !ctlFilter || m.subject === ctlFilter);
    const group = (label, list) => (list.length ? [h('tr', { class: 'grp' }, h('td', { colspan: 8 }, `${label} ${list.length}`)), list.map(row)] : []);
    function row(m) {
      const open = () => { location.hash = deskLink('home', m.id); };
      const dash = h('span', { class: 'dim' }, '—');
      const minutes = m.phase === 'live' ? h('span', { class: 'nv-st live' }, h('span', { class: 'nv-lamp alarm' }), '회의 중')
        : m.phase === 'pending' ? h('span', { class: 'nv-st warn' }, '회의록 없음')
        : m.phase === 'upcoming' ? h('span', { class: 'nv-st plan' }, '예정')
          : h('span', { class: `nv-st ${m.minutes === 'final' ? 'ok' : 'warn'}` }, m.minutes === 'final' ? '확정' : '초안');
      return h('tr', { class: `row ${m.phase}${m.id === sel ? ' sel' : ''}`, 'data-id': m.id, tabindex: '0', onclick: open, onkeydown: (e) => { if (e.key === 'Enter') open(); } },
        h('td', { class: 't-when' }, h('b', {}, m.phase === 'live' ? '지금' : md(m.date)), h('small', {}, (m.time || '').split('~')[0])),
        h('td', {}, h('div', { class: 't-title', title: `${m.title} · ${m.id}` }, m.title)),
        h('td', { class: 'opt' }, h('span', { class: 't-sub' }, h('span', { class: 'nv-dotc', style: `background:${LAMP[state[m.subject]] || '#9ca3af'}` }), m.subject)),
        h('td', { class: 'opt num' }, m.recording ? mmss(m.recording.seconds) : ['live', 'pending'].includes(m.phase) ? h('span', { class: 'dim' }, '대기') : dash),
        h('td', {}, minutes),
        h('td', { class: 'num' }, m.phase === 'done' ? String(m.decisions) : dash),
        h('td', {}, m.items ? h('span', { class: 'nv-mini' }, progressBar(m.items.done, m.items.total),
          h('span', { class: m.items.overdue ? 'nv-warn' : 'dim' }, `${m.items.done}/${m.items.total}`)) : dash),
        h('td', { class: 'opt num' }, m.mails ? h('span', { class: m.mails.sent === m.mails.total ? '' : 'nv-warn' }, `${m.mails.sent}/${m.mails.total}`) : dash));
    }
    return h('div', { class: 'nv-card nv-tbl-card' },
      h('table', { class: 'nv-tbl' },
        h('thead', {}, h('tr', {}, ['일시', '회의', '주제', '녹음', '회의록', '결정', '분공', '메일'].map((t, i) =>
          h('th', { class: `${[2, 3, 7].includes(i) ? 'opt ' : ''}${[3, 5, 7].includes(i) ? 'num' : ''}` }, t)))),
        h('tbody', {}, group('진행 중', rows.filter((m) => m.phase === 'live')), group('기록 대기', rows.filter((m) => m.phase === 'pending')),
          group('예정', rows.filter((m) => m.phase === 'upcoming')),
          group('완료', rows.filter((m) => m.phase === 'done')))),
      rows.length ? '' : empty('이 주제의 회의가 없습니다'));
  }

  function activity(d, fresh, key) {
    const out = [];
    let day = null;
    for (const e of d.log.filter((x) => !ctlFilter || x.subject === ctlFilter)) {
      const iso = e.at.slice(0, 10);
      if (iso !== day) { day = iso; out.push(h('div', { class: 'nv-day-sep' }, dayName(iso, d.today))); }
      const kind = e.kind === 'mail' && e.text.startsWith('회의 예약') ? 'schedule' : e.kind;
      out.push(h('div', { class: `nv-fi ${kind}${fresh.has(key(e)) ? ' new' : ''}`, role: 'link', tabindex: '0', onclick: () => { location.hash = deskLink('home', e.meeting_id); } },
        h('i', {}, svgIcon(ICON[FEED_ICON[kind]] || ICON.minutes)), h('div', {}, h('b', {}, e.subject), ' ', e.text), h('time', {}, e.at.slice(11))));
    }
    return h('div', { class: 'nv-card nv-feed' }, cardHead('활동', '회의 Agent가 본 것 · 한 일'), out.length ? out : empty('아직 기록이 없습니다'));
  }

  // 표 · 활동 (10초마다 다시 읽음). 오른쪽 회의 칸은 따로 둔다 (진행 중인 받아쓰기 · 메일 발송을 지우지 않게)
  function controlList() {
    return shell(async (reload) => {
      const d = await api('control');
      const key = (e) => `${e.at}|${e.kind}|${e.text}`;
      const fresh = seenLog ? new Set(d.log.map(key).filter((k) => !seenLog.has(k))) : new Set();
      seenLog = new Set(d.log.map(key));
      const now = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
      return [
        h('div', { class: 'nv-ctl-head' },
          h('div', {}, h('div', { class: 'nv-h1' }, '회의 관제'), h('div', { class: 'nv-meta' }, '회사의 모든 회의 — 끝난 회의는 녹음부터 메일까지 회의 Agent가 처리합니다')),
          h('span', { class: 'nv-live' }, `실시간 · ${dateLabel(d.today)} ${now}`)),
        kpis(d), subjectTabs(d, reload),
        h('div', { class: 'nv-ctl-grid' }, meetingTable(d), activity(d, fresh, key)),
      ];
    }, 'nv-region');
  }

  // ---- 회의 칸 (오른쪽에서 열림) ----
  const ITEM_TONE = { done: 'ok', in_progress: 'warn', blocked: 'live', open: '' };
  const decidedOf = (m) => m.decisions.filter((x) => ['decision', 'resolution', 'criterion'].includes(x.kind));

  function drawerHead(title, meta, chip, stats) {
    return h('div', { class: 'nv-dw-head' },
      h('div', { class: 'nv-dw-top' }, h('div', { class: 'nv-dw-title' }, title), chip,
        h('a', { class: 'nv-x', href: deskLink('home'), 'aria-label': '닫기', title: '닫기 (Esc)' }, '×')),
      h('div', { class: 'nv-dw-meta' }, meta),
      stats ? h('div', { class: 'nv-dw-stats' }, stats.map(([label, value]) => h('div', { class: 'nv-dw-stat' }, h('span', {}, label), h('b', {}, value)))) : '');
  }

  function tabbed(tabs, first, fresh) {
    const body = h('div', { class: 'nv-dw-body' });
    const strip = h('div', { class: 'nv-dw-tabs' });
    const pick = (k) => {
      strip.replaceChildren(...tabs.map(([key, label]) => h('button', { class: `nv-tab${key === k ? ' on' : ''}`, type: 'button', onclick: () => pick(key) },
        typeof label === 'function' ? label() : label)));
      body.replaceChildren(...[tabs.find(([key]) => key === k)[2]()].flat(Infinity).filter((c) => c !== '' && c != null));
      if (fresh) body.classList.add('fresh');
    };
    pick(first);
    return { bar: strip, body, pick };
  }

  function overviewTab(d) {
    const m = d.meeting;
    const rec = (d.recordings || [])[0];
    return [
      section('회의록', h('div', {}, h('span', { class: `nv-st ${m.status === 'final' ? 'ok' : 'warn'}` }, m.status === 'final' ? '확정' : '초안'), ' ', m.summary || '',
        h('div', { class: 'nv-btns', style: 'margin-top:10px' },
          h('button', { class: 'nv-btn small', type: 'button', onclick: (e) => download(e.currentTarget, m.id, 'minutes') }, '회의록 PDF'),
          h('button', { class: 'nv-btn small', type: 'button', onclick: (e) => download(e.currentTarget, m.id, 'report') }, '결과 보고서 PDF')))),
      rec ? section('녹음 파일', h('div', { class: 'nv-row' }, h('span', { class: 'nv-env' }, svgIcon(ICON.mic)),
        h('div', { class: 'nv-grow', style: 'min-width:0' }, h('div', { class: 'nv-clip', title: fileName(rec.name) }, fileName(rec.name)),
          h('div', { class: 'nv-meta' }, `${mmss(rec.seconds)} · 발언 ${rec.lines}줄 · 발언자 ${rec.speakers}명`)))) : '',
      (d.participants || []).length ? section('참석', h('div', { class: 'nv-who' }, d.participants.map((p) => h('span', { class: 'nv-person' }, avatar(p.name), p.name)))) : '',
    ];
  }

  function decisionsTab(d) {
    const list = decidedOf(d.meeting);
    return list.length ? list.map((x) => h('div', { class: 'nv-dec' },
      h('div', {}, x.statement),
      x.source || x.speaker ? h('div', { class: 'nv-meta' }, x.source || x.speaker) : '',
      (x.premises || []).map((p) => h('div', { class: `nv-prem ${p.status}` }, h('span', { class: 'nv-tag' }, p.kind === 'condition' ? '조건' : '전제'),
        h('span', {}, p.statement), h('span', { class: `nv-st ${p.status === 'broken' ? 'live' : p.status === 'at_risk' ? 'warn' : 'ok'}` }, (PREMISE[p.status] || [p.status])[0]))))) : empty('결정이 없습니다');
  }

  function itemsTab(d) {
    const items = d.items || [];
    const done = items.filter((i) => i.status === 'done').length;
    return items.length ? [
      h('div', { class: 'nv-sec' }, h('div', { class: 'nv-sec-title' }, `진행 ${done}/${items.length}`), progressBar(done, items.length)),
      items.map((it) => h('div', { class: 'nv-item' }, avatar(it.owner),
        h('div', { class: 'nv-grow' }, h('div', {}, it.text), h('div', { class: 'nv-meta' }, `${it.owner || '담당 미정'} · ${it.due ? `기한 ${md(it.due)}` : '기한 없음'}`)),
        h('span', { class: `nv-st ${ITEM_TONE[it.status] || ''}` }, ITEM[it.status] || it.status))),
    ] : empty('분공이 없습니다');
  }

  function mailsTab(mails, flying) {
    if (!mails.length) return empty('보낸 메일이 없습니다');
    return mails.map((x, i) => h('div', { class: `nv-mail${flying ? ' fly' : ''}${x.status === 'sent' ? ' sent' : ''}`, style: `--d:${i}` },
      h('span', { class: 'nv-env', 'aria-hidden': 'true' }, svgIcon(ICON.mail)),
      h('div', { class: 'nv-grow' }, h('div', {}, x.to, h('span', { class: 'nv-meta' }, ` · ${MAIL_KIND[x.kind] || x.kind}`)), h('div', { class: 'nv-meta nv-clip' }, x.subject)),
      h('span', { class: `nv-st ${x.status === 'sent' ? 'ok' : x.status === 'failed' ? 'live' : 'warn'}` }, MAIL[x.status] || x.status)));
  }

  // 끝난 회의 (또는 방금 처리한 회의): 개요 · 결정 · 분공 · 메일, 초안이면 아래에 '확정 · 메일 발송'
  function doneDrawer(d, fresh = false) {
    const m = d.meeting;
    const items = d.items || [];
    const mails = d.mails || [];
    const rec = (d.recordings || [])[0];
    let current = d;
    let flying = false;
    const tabs = tabbed([
      ['overview', '개요', () => overviewTab(current)],
      ['decisions', () => `결정 ${decidedOf(current.meeting).length}`, () => decisionsTab(current)],
      ['items', () => `분공 ${(current.items || []).length}`, () => itemsTab(current)],
      ['mails', () => `메일 ${(current.mails || []).length}`, () => mailsTab(current.mails || [], flying)],
    ], fresh ? 'decisions' : 'overview', fresh);
    const foot = m.status !== 'final' && d.can_confirm ? h('div', { class: 'nv-dw-foot' },
      h('button', { class: 'nv-btn primary', type: 'button', onclick: act(async (b) => {
        b.textContent = '확정하는 중…';
        const out = await api('finalize', { meeting_id: m.id });
        if (out.ok === false || out.error) throw new Error(out.error || '확정하지 못했습니다');
        for (let i = 0; i < 20; i++) {
          current = await api('meeting', { meeting_id: m.id });
          flying = i === 0;
          tabs.pick('mails');
          if (i === 0) {
            const kinds = (current.mails || []).filter((x) => x.kind !== 'schedule').reduce((a, x) => ({ ...a, [x.kind]: (a[x.kind] || 0) + 1 }), {});
            notice(`확정 — ${Object.entries(kinds).map(([k, n]) => `${MAIL_KIND[k] || k} ${n}통`).join(' · ')} 발송`);
            b.closest('.nv-dw-foot').replaceChildren(h('span', { class: 'nv-st ok' }, '확정됨'), h('span', { class: 'nv-meta' }, '참석자 · 담당자에게 메일을 보냈습니다'));
          }
          if ((current.mails || []).every((x) => x.status !== 'pending' && x.status !== 'approved')) break;
          await new Promise((r) => setTimeout(r, 1500));
        }
        refreshAll();
      }) }, '확정 · 메일 발송'),
      h('span', { class: 'nv-meta' }, '참석자에게 회의록, 담당자에게 업무 배정 메일이 나갑니다')) : '';
    const done = items.filter((i) => i.status === 'done').length;
    return [
      drawerHead(m.title, `${when(m.date, m.time)} · ${m.id}`, h('span', { class: `nv-st ${m.status === 'final' ? 'ok' : 'warn'}` }, m.status === 'final' ? '회의록 확정' : '회의록 초안'),
        [['녹음', rec ? mmss(rec.seconds) : '—'], ['결정', String(decidedOf(m).length)], ['분공', `${done}/${items.length}`],
          ['메일', mails.length ? `${mails.filter((x) => x.status === 'sent').length}/${mails.length}` : '—']]),
      tabs.bar, tabs.body,
      askBox(m, ['결정과 근거를 다시 정리해 줘', ...(items.some((i) => i.status !== 'done' && i.status !== 'cancelled') ? ['밀린 일 담당자에게 독촉해 줘'] : [])]),
      foot,
    ];
  }

  const RUN = [['file', '녹음 파일 받음'], ['stt', '글로 옮기기 · 목소리로 발언자 식별'], ['agent', '회의록 작성 — 회의지원 Agent'], ['out', '결정 · 분공 정리']];

  // 진행 중인 회의: 녹음을 놓으면 단계마다 진행 (걸린 시간), 끝나면 회의 칸이 결과로 바뀐다
  function liveDrawer(s, drawer) {
    const started = {};
    const run = h('div', { class: 'nv-run', hidden: true },
      h('div', { class: 'nv-run-head' }, h('span', {}, '처리 단계'), h('span', { class: 'nv-run-total' }, '')),
      RUN.map(([k, label]) => h('div', { class: 'nv-run-step', 'data-step': k }, h('span', { class: 'nv-ic' }),
        h('div', {}, h('b', {}, label), h('code', {})), h('time', {}, ''))));
    const input = h('input', { type: 'file', accept: 'audio/*,video/*', hidden: true });
    const t0 = { at: 0 };
    const setStep = (k, state, note) => {
      const el = run.querySelector(`[data-step="${k}"]`);
      el.className = `nv-run-step ${state}`;
      if (state === 'busy' && !started[k]) started[k] = Date.now();
      if (note != null) el.querySelector('code').textContent = note;
      if (state !== 'busy') el.querySelector('time').textContent = `${((Date.now() - (started[k] || Date.now())) / 1000).toFixed(1)}s`;
      run.querySelector('.nv-run-total').textContent = `${((Date.now() - t0.at) / 1000).toFixed(1)}s`;
    };
    const process = async (file) => {
      drop.hidden = true;
      run.hidden = false;
      t0.at = Date.now();
      started.file = Date.now();
      setStep('file', 'done', `${file.name} · ${(file.size / 1048576).toFixed(1)}MB`);
      setStep('stt', 'busy', 'speech-service: 받아쓰기 · 발언자 구분 · 목소리 대조');
      try {
        const res = await fetch(`/meetings/api/recording/transcribe?meeting_id=${encodeURIComponent(s.id)}`, {
          method: 'POST', body: file,
          headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'X-Filename': encodeURIComponent(file.name), 'Content-Type': file.type || 'application/octet-stream' } });
        const t = await res.json();
        if (!res.ok) throw new Error(t.error || `HTTP ${res.status}`);
        setStep('stt', 'done', `${mmss(t.seconds)} · 발언 ${t.lines}줄 · ${t.speakers.join(' · ')}`);
        setStep('agent', 'busy', '회의록 초안을 쓰는 중');
        const stream = await fetch('/meetings/api/recording/minutes', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
          body: JSON.stringify({ meeting_id: s.id, filename: file.name, text: t.text }) });
        const reader = stream.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            const ev = JSON.parse(line);
            if (ev.type === 'status') setStep('agent', 'busy', ev.text.replace(/^[^:]*: /, '').slice(0, 140));
            if (ev.type === 'error') throw new Error(ev.text);
          }
        }
        const d = await api('meeting', { meeting_id: s.id });
        if (!d.meeting) throw new Error('회의록이 저장되지 않았습니다 — 녹음을 다시 놓아 주세요');
        setStep('agent', 'done', 'save_meeting_minutes · 회의록 초안 저장');
        started.out = Date.now();
        setStep('out', 'done', `결정 ${decidedOf(d.meeting).length} · 분공 ${(d.items || []).length}`);
        await new Promise((r) => setTimeout(r, 900));
        const [head, ...rest] = doneDrawer(d, true);
        drawer.replaceChildren(head, run, ...rest.filter(Boolean));
        run.classList.add('folded');
        refreshAll();
      } catch (e) {
        for (const el of run.querySelectorAll('.nv-run-step.busy')) el.className = 'nv-run-step failed';
        run.after(h('div', { class: 'nv-err', style: 'padding:0 20px' }, e.message));
        drop.hidden = false;
      }
    };
    input.addEventListener('change', () => { if (input.files[0]) process(input.files[0]); });
    const drop = h('div', { class: 'nv-drop', role: 'button', tabindex: '0', onclick: () => input.click(),
      ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); }, ondragleave: () => drop.classList.remove('over'),
      ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) process(e.dataTransfer.files[0]); } },
      svgIcon(ICON.mic), h('b', {}, '회의가 끝나면 녹음 파일을 여기에 놓으세요'), h('span', { class: 'nv-meta' }, '받아쓰기 · 발언자 식별 → 회의록 · 결정 · 분공 → 확정하면 메일'));
    return [
      drawerHead(s.title, `${dateLabel(s.starts_at)} ${slot(s)}${s.location ? ` · ${s.location}` : ''} · ${s.id}`,
        s.starts_at.slice(0, 10) < todayIso() ? h('span', { class: 'nv-st warn' }, '회의록 없음 · 녹음 대기')
          : h('span', { class: 'nv-st live' }, h('span', { class: 'nv-lamp alarm' }), `회의 중 · ${minutesSince(s.starts_at)}분째`)),
      h('div', { class: 'nv-dw-body' },
        s.participants && s.participants.length ? section('참석 대상', h('div', { class: 'nv-who' }, s.participants.map((p) => h('span', { class: 'nv-person' }, avatar(p.name), p.name)))) : '',
        s.agenda && s.agenda.length ? section('안건', s.agenda.map((a) => h('div', { class: 'nv-row' }, h('span', { class: 'nv-tag' }, String(a.seq)), h('div', { class: 'nv-grow' }, a.title)))) : '',
        h('div', { class: 'nv-sec' }, drop, input), run),
    ];
  }

  // ---- 분공 진행: 담당자별 (Asana 업무량 · Jira 담당자별 분포처럼 한 줄에 한 사람, 막대는 완료 · 진행 중 · 미착수 · 기한 지남).
  // 사람이 많으면 소속별로 묶어 접는다 (GitHub Projects · Linear의 묶어 보기). 사람을 누르면 그 사람의 할 일이 펼쳐진다. #home/people
  const MANY_PEOPLE = 8;
  let peopleBy = null; // 'person' | 'org' — 처음에는 사람 수로 정한다
  let peopleQuery = '';
  let peopleLate = false;
  const peopleOpen = new Map(); // 펼침 · 접음을 사람 · 소속마다 기억 (다시 읽어도 그대로)

  // 소속: '그룹' + '그룹 재무실' → '그룹 재무실', 'K전자' + '기술연구소' → 'K전자 · 기술연구소', 외부 → '외부 · OO회계법인'
  const orgOf = (p) => {
    if (p.unit) return p.name;
    const org = p.organization || '';
    const dept = p.department && p.department !== org ? p.department : '';
    if (dept && org && dept.startsWith(org)) return dept;
    return [p.external ? '외부' : '', org, dept].filter(Boolean).join(' · ') || '소속 미상';
  };
  // 소속별로 묶는 단위: 회사 (그룹 · K전자), 외부 사람은 '외부 · 회사', 부서가 맡은 일은 '부서 담당'
  const groupOf = (p) => (p.unit ? '부서 담당' : p.external ? ['외부', p.organization].filter(Boolean).join(' · ') : p.organization || '소속 미상');
  // 직함 · 소속 (묶음 안에서는 회사를 빼고 부서만). 직함에 이미 있는 것은 빼고 ('외부 자문 위원, OO회계법인' → 직함만)
  const whoLine = (p, nested) => {
    const title = p.title || '';
    const where = nested ? [p.department && p.department !== p.organization ? p.department : ''] : orgOf(p).split(' · ');
    return [title, ...where.filter((x) => x && !title.includes(x))].join(' · ').replace(/^ · /, '') || ' ';
  };
  const tally = (items) => items.reduce((t, i) => {
    t.total += 1;
    if (i.status === 'done') t.done += 1; else if (i.overdue) t.late += 1; else if (i.status === 'open') t.open += 1; else t.prog += 1;
    return t;
  }, { total: 0, done: 0, prog: 0, open: 0, late: 0 });
  const pct = (t) => (t.total ? Math.round((t.done / t.total) * 100) : 0);

  function stackBar(t) {
    const seg = (n, cls) => (n ? h('span', { class: cls, style: `flex:${n}` }) : '');
    return h('div', { class: 'nv-wbar', title: `완료 ${t.done} · 진행 중 ${t.prog} · 미착수 ${t.open} · 기한 지남 ${t.late}` },
      seg(t.done, 'done'), seg(t.prog, 'prog'), seg(t.open, 'open'), seg(t.late, 'late'));
  }

  function folder(key, dflt, head, body) {
    const open = peopleQuery || peopleLate ? true : peopleOpen.has(key) ? peopleOpen.get(key) : dflt;
    const box = h('div', { class: 'nv-pp-body', hidden: !open }, body);
    const toggle = () => { box.hidden = !box.hidden; row.classList.toggle('open', !box.hidden); peopleOpen.set(key, !box.hidden); };
    const row = h('div', { class: `${head.cls}${open ? ' open' : ''}`, role: 'button', tabindex: '0', 'aria-expanded': String(open), onclick: toggle,
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } } }, h('span', { class: 'nv-caret' }, '›'), head.cells);
    return h('div', {}, row, box);
  }

  function ownedItem(it, reload) {
    const done = it.status === 'done';
    const [due, tone] = done ? ['완료', ''] : dueText(it.due);
    const set = (status) => act(async () => { await api('items', { item_id: it.id, status }); await reload(); });
    return h('div', { class: `nv-oi${done ? ' done' : ''}` },
      h('span', { class: `nv-st ${it.overdue ? 'live' : ITEM_TONE[it.status] || ''}` }, it.overdue ? '기한 지남' : ITEM[it.status] || it.status),
      h('div', { class: 'nv-grow' }, h('div', { class: 'nv-oi-text' }, it.text),
        h('div', { class: 'nv-meta' }, h('span', { class: tone }, due), ' · ',
          h('a', { class: 'nv-oi-src', href: deskLink('home', it.meeting.id), title: `${it.meeting.title} · ${it.meeting.id}` }, `${md(it.meeting.date)} ${it.meeting.title}`))),
      done ? '' : h('div', { class: 'nv-btns' },
        it.status === 'open' ? h('button', { class: 'nv-btn small', type: 'button', onclick: set('in_progress') }, '진행 중') : '',
        h('button', { class: 'nv-btn small', type: 'button', onclick: set('done') }, '완료')));
  }

  function personRow(p, reload, nested) {
    const t = tally(p.items);
    const [next, tone] = p.next_due ? dueText(p.next_due) : ['', ''];
    return folder(`p:${p.name}`, false, {
      cls: `nv-pp${nested ? ' nested' : ''}`,
      cells: [
        p.unit ? h('span', { class: 'nv-av unit' }, p.name.slice(0, 1)) : avatar(p.name),
        h('div', { class: 'nv-pp-who' }, h('b', {}, p.name), h('small', {}, p.unit ? '부서 담당' : whoLine(p, nested))),
        stackBar(t),
        h('span', { class: 'nv-pp-n' }, h('b', {}, `${pct(t)}%`), h('small', {}, `${t.done}/${t.total}`)),
        h('span', { class: 'nv-pp-flag' }, t.late ? h('span', { class: 'nv-st live' }, `지남 ${t.late}`)
          : t.done === t.total ? h('span', { class: 'nv-st ok' }, '모두 완료') : next ? h('span', { class: `nv-due ${tone}` }, next) : h('span', { class: 'dim' }, '기한 없음')),
      ],
    }, p.items.map((it) => ownedItem(it, reload)));
  }

  function orgGroup(name, people, reload) {
    const t = tally(people.flatMap((p) => p.items));
    return folder(`g:${name}`, t.late > 0, {
      cls: 'nv-pp grp',
      cells: [
        h('span', { class: 'nv-av org' }, name.slice(0, 1)),
        h('div', { class: 'nv-pp-who' }, h('b', {}, name), h('small', {}, `${people.length}명 · 할 일 ${t.total}건`)),
        stackBar(t),
        h('span', { class: 'nv-pp-n' }, h('b', {}, `${pct(t)}%`), h('small', {}, `${t.done}/${t.total}`)),
        h('span', { class: 'nv-pp-flag' }, t.late ? h('span', { class: 'nv-st live' }, `지남 ${t.late}`) : t.done === t.total ? h('span', { class: 'nv-st ok' }, '모두 완료') : ''),
      ],
    }, people.map((p) => personRow(p, reload, true)));
  }

  function peopleList(all, reload) {
    const q = peopleQuery.trim().toLowerCase();
    // 찾기: 사람 · 소속이 맞으면 그 사람의 할 일 모두, 아니면 맞는 할 일만
    const has = (x) => (x || '').toLowerCase().includes(q);
    const people = all.map((p) => ({ ...p, items: p.items.filter((i) => (!q || [p.name, p.title, orgOf(p), groupOf(p), i.text, i.meeting.title].some(has)) && (!peopleLate || i.overdue)) }))
      .filter((p) => p.items.length);
    if (!people.length) return empty(peopleLate ? '기한이 지난 할 일이 없습니다' : '맞는 담당자가 없습니다');
    if (peopleBy === 'person') return people.map((p) => personRow(p, reload, false));
    const groups = new Map();
    for (const p of people) groups.set(groupOf(p), [...(groups.get(groupOf(p)) || []), p]);
    return [...groups.entries()]
      .map(([name, list]) => ({ name, list, t: tally(list.flatMap((p) => p.items)) }))
      .sort((a, b) => b.t.late - a.t.late || pct(a.t) - pct(b.t) || a.name.localeCompare(b.name, 'ko'))
      .map((g) => orgGroup(g.name, g.list, reload));
  }

  function peopleDrawer(drawer) {
    const render = async () => {
      const d = await api('control');
      if (deskRoute().id !== 'people') return;
      const people = d.people || [];
      if (!peopleBy) peopleBy = people.length > MANY_PEOPLE ? 'org' : 'person';
      const t = tally(people.flatMap((p) => p.items));
      const meetings = new Set(people.flatMap((p) => p.items.map((i) => i.meeting.id))).size;
      const list = h('div', { class: 'nv-pp-list' });
      const draw = () => list.replaceChildren(...[peopleList(people, render)].flat(Infinity).filter(Boolean));
      const seg = h('div', { class: 'nv-seg', role: 'tablist' }, [['person', '사람별'], ['org', '소속별']].map(([k, label]) =>
        h('button', { class: peopleBy === k ? 'on' : '', type: 'button', role: 'tab', 'aria-selected': String(peopleBy === k),
          onclick: (e) => { peopleBy = k; for (const b of seg.children) b.classList.toggle('on', b === e.currentTarget); draw(); } }, label)));
      const late = h('button', { class: `nv-btn small${peopleLate ? ' on' : ''}`, type: 'button', disabled: !t.late,
        onclick: () => { peopleLate = !peopleLate; late.classList.toggle('on', peopleLate); draw(); } }, `기한 지남만 ${t.late}`);
      const search = h('input', { class: 'nv-input nv-pp-q', type: 'search', placeholder: '이름 · 소속 · 할 일 찾기', value: peopleQuery,
        oninput: () => { peopleQuery = search.value; draw(); } });
      draw();
      const legend = [['done', '완료', t.done], ['prog', '진행 중', t.prog], ['open', '미착수', t.open], ['late', '기한 지남', t.late]];
      drawer.replaceChildren(
        drawerHead('분공 진행', `회의 ${meetings}건 · 담당 ${people.length}명 · 할 일 ${t.total}건`, h('span', { class: `nv-st ${t.late ? 'live' : 'ok'}` }, `${pct(t)}% 완료`)),
        h('div', { class: 'nv-pp-sum' }, stackBar(t),
          h('div', { class: 'nv-legend' }, legend.map(([k, label, n]) => h('span', {}, h('i', { class: k }), label, h('b', {}, String(n)))))),
        h('div', { class: 'nv-pp-tools' }, seg, search, late),
        h('div', { class: 'nv-dw-body' }, list),
        h('div', { class: 'nv-dw-foot' }, h('span', { class: 'nv-meta' }, '확정된 회의록의 할 일은 기한 다음 날부터 매주 회의 Agent가 담당자에게 기한 알림 메일을 보냅니다')));
    };
    drawer.replaceChildren(h('div', { class: 'nv-loading' }, '불러오는 중…'));
    render().catch((e) => drawer.replaceChildren(h('div', { class: 'nv-loading' }, `불러오지 못했습니다: ${e.message}`)));
  }

  // 이 회의를 두고 회의 Agent에게 묻기 · 시키기: 회의 이름 · id를 붙여 새 회의지원 채팅으로 보낸다 (제안 문장은 누르면 바로)
  function askBox(m, suggestions) {
    const send = (text) => { if (text.trim()) ask(`[${m.title} · ${m.id}] ${text.trim()}`); };
    const input = h('input', { class: 'nv-input', placeholder: '이 회의에 대해 묻거나 시키기', 'aria-label': '회의 Agent에게 묻기',
      onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) send(input.value); } });
    return h('div', { class: 'nv-dw-ask' },
      h('div', { class: 'nv-ask-title' }, '회의 Agent에게 묻기'),
      h('div', { class: 'nv-ask-row' }, input, h('button', { class: 'nv-btn small primary', type: 'button', onclick: () => send(input.value) }, '보내기')),
      h('div', { class: 'nv-ask-chips' }, suggestions.map((t) => h('button', { class: 'nv-ask-chip', type: 'button', onclick: () => send(t) }, t))));
  }

  function drawerFor(id, drawer) {
    if (id === 'people') { peopleDrawer(drawer); return; }
    drawer.replaceChildren(h('div', { class: 'nv-loading' }, '불러오는 중…'));
    (async () => {
      try {
        const d = await api('meeting', { meeting_id: id });
        if (deskRoute().id !== id) return;
        if (d.scheduled) {
          const s = d.scheduled;
          const live = s.status === 'scheduled' && new Date(`${s.starts_at.replace(' ', 'T')}:00+09:00`) <= new Date();
          drawer.replaceChildren(...(live ? liveDrawer(s, drawer)
            : [drawerHead(s.title, `${dateLabel(s.starts_at)} ${slot(s)}${s.location ? ` · ${s.location}` : ''} · ${s.id}`, h('span', { class: 'nv-st plan' }, '예정')),
              h('div', { class: 'nv-dw-body' }, scheduledView(s, () => {}).slice(1)),
              askBox(s, ['이 회의 준비 자료 정리해 줘', '지난 회의에서 밀린 일 담당자에게 독촉해 줘'])]).filter(Boolean));
        } else {
          drawer.replaceChildren(...doneDrawer(d).filter(Boolean));
        }
      } catch (e) { drawer.replaceChildren(h('div', { class: 'nv-loading' }, `불러오지 못했습니다: ${e.message}`)); }
    })();
  }

  function controlView() {
    const list = controlList();
    const drawer = h('aside', { class: 'nv-drawer', hidden: true, 'aria-label': '회의' });
    const show = (id) => {
      drawer.hidden = !id;
      if (id) drawerFor(id, drawer); else drawer.replaceChildren();
      for (const el of list.querySelectorAll('tr.row')) el.classList.toggle('sel', el.dataset.id === id);
      for (const el of list.querySelectorAll('[data-kpi]')) el.classList.toggle('sel', el.dataset.kpi === id);
    };
    const node = h('div', { class: 'nv-ctl' }, list, drawer);
    show(deskRoute().id);
    return { node, show, list };
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && location.pathname.startsWith('/meetings') && deskRoute().key === 'home' && deskRoute().id) location.hash = '#home'; });

  // 주제 하나로 들어가기: 지금 상태 · 이유, 회의 순서대로 결정이 어떻게 이어지고 바뀌었는지, 열린 할 일. 회의를 누르면 옆에 회의록
  function topicView(subject) {
    return shell(async (reload) => {
      const d = await api('control');
      const s = d.screens.find((x) => x.subject === subject);
      if (!s) return [cardHead(subject, ''), empty('이 주제의 회의가 없습니다')];
      const [label, chip] = STATE[s.state];
      const shaken = (s.signals || []).find((x) => x.effect === 'broken') || (s.signals || [])[0];
      const flow = s.meetings.map((m) => [
        listItem({ key: 'topic', id: m.id, href: topicLink(subject, m.id), dot: m.status === 'scheduled' ? 'brand' : m.status === 'final' ? 'ok' : 'warn',
          title: m.title, meta: `${when(m.date, m.time)} · ${m.id}`,
          chips: m.status === 'scheduled' ? h('span', { class: 'nv-chip' }, '예정') : minutesChip(m.status) }),
        s.decisions.filter((x) => x.ref.startsWith(`${m.id}-`)).map((x) => h('div', { class: `nv-flow-d${x.in_force ? '' : ' old'}` },
          h('span', { class: `nv-tag ${x.in_force ? 'brand' : ''}` }, x.in_force ? '결정' : '바뀜'), ' ', x.statement,
          x.premises.map((p) => h('div', { class: `nv-meta ${p.status === 'broken' ? 'nv-danger' : p.status === 'at_risk' ? 'nv-warn' : ''}` },
            `${p.kind === 'condition' ? '조건' : '전제'} ${(PREMISE[p.status] || [p.status])[0]} · ${p.statement}`)))),
      ]);
      return [
        h('div', { class: 'nv-head' },
          h('div', { class: 'nv-grow' }, h('a', { class: 'nv-more', href: '#home' }, '← 회의 관제'), h('div', { class: 'nv-title', style: 'margin-top:4px' }, subject),
            h('div', { class: 'nv-meta' }, `회의 ${s.counts.meetings} · 진행 중인 결정 ${s.counts.decisions} · 열린 할 일 ${s.counts.open_items}`)),
          h('span', { class: `nv-chip ${chip}` }, label)),
        s.reasons.length ? h('div', { class: 'nv-sec' }, s.reasons.map((r) => h('div', { class: `nv-cam-why ${tone(s.state)}` }, r)),
          shaken ? h('div', { class: 'nv-btns', style: 'margin-top:8px' },
            h('button', { class: 'nv-btn small primary', type: 'button', onclick: () => ask(`${shaken.ref} 결정의 전제가 흔들렸어. 지금 상태를 정리하고 재검토 회의를 제안해 줘.`) }, '재검토 제안')) : '') : '',
        h('div', { class: 'nv-group-title' }, '결정 흐름 — 회의 순서대로'), flow,
        s.items.length ? section(`열린 할 일 ${s.items.length}`, s.items.map((it) => h('div', { class: 'nv-row' },
          h('div', { class: 'nv-grow' }, h('div', {}, it.text), h('div', { class: 'nv-meta' }, `${it.owner || '담당 미정'} · `,
            h('span', { class: it.overdue ? 'nv-danger' : '' }, it.due ? `기한 ${it.due}${it.overdue ? ' (지남)' : ''}` : '기한 없음')))))) : '',
      ];
    });
  }

  // 확인할 일 (Linear의 Inbox처럼 종류별로): 흔들린 전제 · 확정 전 회의록 · 보내지 못한 메일
  function inboxView() {
    return shell(async (reload) => {
      const [o, drafts, mail] = await Promise.all([api('overview'), api('minutes', { status: 'draft' }), api('mail', { action: 'list' })]);
      const unsent = (mail.mails || []).filter((m) => ['failed', 'needs_address'].includes(m.status));
      const n = (drafts.counts || {}).draft || drafts.minutes.length;
      const group = (title, rows) => [h('div', { class: 'nv-group-title' }, title), rows];
      const groups = [
        o.watch.length ? group(`전제가 흔들린 결정 ${o.watch.length}`, o.watch.map((s) => watchItem(s, reload, 'inbox'))) : '',
        n ? group(`확정 전 회의록 ${n}`, [drafts.minutes.map((m) => minutesItem(m, 'inbox')),
          drafts.more ? h('a', { class: 'nv-li link nv-more', href: '#minutes', onclick: () => { deskStatus = 'draft'; deskQuery = ''; } }, `초안 ${n}건 모두 보기 →`) : '']) : '',
        unsent.length ? group(`보내지 못한 메일 ${unsent.length}`, h('div', { class: 'nv-sec' }, unsent.map((m) => mailRow(m, reload)))) : '',
      ].filter(Boolean);
      return [cardHead('확인할 일', '회의가 끝난 뒤 사람이 보고 정해야 하는 것'), groups.length ? groups : empty('확인할 일이 없습니다')];
    });
  }

  // 회의록: 검색어(회의명 · 주제 · 내용 · id) · 초안/확정, 최근 순으로 한 쪽씩
  function minutesListView() {
    let timer;
    const list = h('div', {});
    const chips = h('div', { class: 'nv-filter' });
    const more = h('button', { class: 'nv-btn small', type: 'button', hidden: true }, '더 보기');
    const input = h('input', { class: 'nv-input', type: 'search', value: deskQuery, placeholder: '회의명 · 주제 · 내용 · 회의 id' });
    async function load(offset = 0) {
      try {
        const d = await api('minutes', { query: deskQuery, status: deskStatus || null, offset });
        if (!offset) list.replaceChildren();
        list.append(...(d.minutes.length || offset ? d.minutes.map((m) => minutesItem(m, 'minutes')) : [empty('찾는 회의록이 없습니다')]));
        more.hidden = !d.more;
        more.onclick = () => load(offset + d.minutes.length);
        const c = d.counts || {};
        chips.replaceChildren(...[['', '전체', c.total], ['draft', '초안', c.draft], ['final', '확정', c.final]].map(([key, label, k]) =>
          h('button', { class: key === deskStatus ? 'on' : '', type: 'button', onclick: () => { deskStatus = key; load(); } }, `${label} ${k ?? ''}`)));
      } catch (e) {
        list.replaceChildren(h('div', { class: 'nv-err', style: 'padding:0 16px 12px' }, `회의록을 불러오지 못했습니다: ${e.message}`));
      }
    }
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { deskQuery = input.value.trim(); load(); }, 300); });
    const node = h('div', { class: 'nv-card' }, cardHead('회의록', '최근 순'), h('div', { class: 'nv-sec' }, input, chips), list,
      h('div', { style: 'padding:10px 16px' }, more));
    mounted.set(node, () => load());
    load();
    return node;
  }

  function scheduleView() {
    return shell(async () => {
      const o = await api('overview');
      return [cardHead(`다가오는 회의 ${o.upcoming.length}건`, '앞으로 14일'), o.upcoming.length ? agenda(o.upcoming, 'schedule', o.today) : empty('잡힌 회의가 없습니다')];
    });
  }

  // 할 일: 내 할 일 / 전체를 기한으로 묶어서 (Todoist · Asana처럼)
  function dueGroup(it, today) {
    if (!it.due) return 4;
    if (it.overdue_days > 0) return 0;
    const left = Math.round((new Date(`${it.due}T00:00:00`) - new Date(`${today}T00:00:00`)) / 86400000);
    return left <= 0 ? 1 : left <= 7 ? 2 : 3;
  }

  function itemsView() {
    let view = 'mine';
    return shell(async (reload) => {
      const d = await api('items', { view });
      const items = d.items || [];
      const today = todayIso();
      const groups = DUE_GROUPS.map((label, i) => [label, items.filter((it) => dueGroup(it, today) === i)]).filter(([, list]) => list.length);
      const tabs = h('div', { class: 'nv-filter', style: 'padding:0 16px 10px' }, [['mine', '내 할 일'], ['all', '전체 할 일']].map(([key, label]) =>
        h('button', { class: key === view ? 'on' : '', type: 'button', onclick: () => { view = key; reload(); } }, label)));
      return [cardHead(`할 일 ${items.length}건`, d.as_of ? `기준 ${d.as_of}` : ''), tabs,
        groups.length ? groups.map(([label, list]) => section(`${label} ${list.length}`, list.map((it) => itemRow(it, reload, true))))
          : empty(view === 'mine' ? '맡은 할 일이 없습니다' : '열린 할 일이 없습니다')];
    }, 'nv-card nv-narrow');
  }

  function mailView() {
    let filter = 'all';
    return shell(async (reload) => {
      const d = await api('mail', { action: 'list' });
      const mails = d.mails || [];
      const shown = mails.filter(MAIL_FILTERS.find(([k]) => k === filter)[2]);
      return [cardHead(`메일 ${d.matched || mails.length}건`, d.smtp_configured === false ? '메일 서버가 설정되지 않아 발송 대기 중입니다' : '회의록 · 업무 배정 · 회의 안내 · 기한 알림 · 전제 변화'),
        h('div', { class: 'nv-filter', style: 'padding:0 16px 10px' }, MAIL_FILTERS.map(([key, label, fn]) =>
          h('button', { class: key === filter ? 'on' : '', type: 'button', onclick: () => { filter = key; reload(); } }, `${label} ${mails.filter(fn).length}`))),
        h('div', { class: 'nv-sec' }, shown.length ? shown.map((m) => mailRow(m, reload)) : h('div', { class: 'nv-meta', style: 'padding:8px 0' }, '해당하는 메일이 없습니다'))];
    }, 'nv-card nv-narrow');
  }

  // 목록 옆 칸: 고른 회의의 카드 (없으면 안내)
  function detailPane(back, id) {
    if (!id) return [h('div', { class: 'nv-placeholder' }, '왼쪽 목록에서 고르면 여기에 회의록 · 일정이 열립니다')];
    return [h('div', { class: 'nv-close' }, h('a', { class: 'nv-btn small', href: back }, '닫기')), meetingCard(id)];
  }

  const backOf = (r) => (r.key === 'topic' ? topicLink(r.subject) : deskLink(r.key));

  function splitView(list) {
    const r = deskRoute();
    const id = r.id;
    const detail = h('div', { class: 'nv-detail' }, detailPane(backOf(r), id));
    const node = h('div', { class: `nv-split${id ? ' has' : ''}` }, list, detail);
    return { node, detail };
  }

  const VIEWS = {
    home: () => controlView(),
    topic: () => splitView(topicView(deskRoute().subject)),
    inbox: () => splitView(inboxView()),
    minutes: () => splitView(minutesListView()),
    schedule: () => splitView(scheduleView()),
    items: () => ({ node: itemsView() }),
    mail: () => ({ node: mailView() }),
  };

  // 왼쪽 메뉴: 구역마다 건수 (흔들린 전제 · 지난 할 일 · 못 보낸 메일이 있으면 빨갛게)
  function deskSide() {
    const nav = h('nav', { class: 'nv-side', 'aria-label': '회의 업무 메뉴' });
    let counts = {};
    const draw = () => {
      const r = deskRoute();
      nav.replaceChildren(...SECTIONS.map(([key, label]) => {
        const c = counts[key];
        const on = r.key === key || (r.key === 'topic' && key === 'home');
        return h('a', { class: `nv-nav${on ? ' on' : ''}`, href: deskLink(key), 'aria-current': on ? 'page' : null },
          svgIcon(ICON[key]), label, c && c.n ? h('span', { class: `nv-count${c.alert ? ' alert' : ''}` }, String(c.n)) : '');
      }));
    };
    const load = async () => {
      try {
        const [o, w] = await Promise.all([api('overview'), api('control')]);
        const c = o.counts;
        const drafts = (o.minutes || []).filter((m) => m.status === 'draft').length;
        const unsent = c.mail_failed + c.mail_needs_address;
        counts = { home: { n: w.counts.alarm, alert: true }, inbox: { n: o.watch.length + drafts + unsent, alert: o.watch.length > 0 }, schedule: { n: o.upcoming.length },
          items: { n: c.my_items, alert: c.my_overdue > 0 }, mail: { n: unsent, alert: unsent > 0 } };
      } catch { counts = {}; } // 건수 없이 메뉴만
      draw();
    };
    mounted.set(nav, load);
    draw();
    load();
    return { nav, draw };
  }

  function deskTop(onSearch) {
    const input = h('input', { type: 'search', placeholder: '회의록 찾기 — 회의명 · 주제 · 내용 · 회의 id', 'aria-label': '회의록 찾기' });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') onSearch(input.value.trim()); });
    return h('header', { class: 'nv-top' },
      h('a', { class: 'nv-brand', href: '/' }, h('img', { src: '/static/favicon.png', alt: '' }), 'Navitech', h('small', {}, '회의 업무')),
      h('label', { class: 'nv-search' }, svgIcon(ICON.search), input),
      h('div', { class: 'nv-top-end' },
        h('a', { class: 'nv-ghost', href: '/' }, '채팅으로'),
        h('button', { class: 'nv-btn primary', type: 'button', onclick: toMeetingChat }, '회의지원 Agent에게 묻기')));
  }

  function deskApp(root) {
    cardStyle();
    const main = h('main', { class: 'nv-main' });
    const side = deskSide();
    let current = null; // { key, node, detail }
    const render = (force = false) => {
      const r = deskRoute();
      side.draw();
      document.title = `${r.key === 'topic' ? r.subject : SECTIONS.find(([k]) => k === r.key)[1]} · 회의 업무 · Navitech`;
      if (!force && current && current.key === r.key && current.subject === r.subject) {
        // 같은 구역에서 다른 회의를 고름: 목록은 그대로 두고 옆 칸만 바꾼다
        if (current.show) {
          current.show(r.id);
          if (r.id && window.innerWidth <= 900) window.scrollTo(0, 0);
        } else if (current.detail) {
          current.detail.replaceChildren(...detailPane(backOf(r), r.id));
          current.node.classList.toggle('has', !!r.id);
          for (const li of current.node.querySelectorAll('.nv-li[data-id]')) li.classList.toggle('sel', li.dataset.id === r.id);
          if (r.id && window.innerWidth <= 900) window.scrollTo(0, 0);
        }
        return;
      }
      const view = VIEWS[r.key]();
      main.replaceChildren(view.node);
      current = { key: r.key, subject: r.subject, ...view };
      window.scrollTo(0, 0);
    };
    const top = deskTop((q) => {
      deskQuery = q;
      deskStatus = '';
      if (deskRoute().key === 'minutes' && !deskRoute().id) render(true); else location.hash = '#minutes';
    });
    root.replaceChildren(h('div', { class: 'nv-app' }, top, h('div', { class: 'nv-body' }, side.nav, main)));
    window.addEventListener('hashchange', () => render());
    setInterval(() => { // 관제 화면은 그대로 두어도 새 상황이 보이게
      if (!current || current.key !== 'home' || document.hidden) return;
      const load = mounted.get(current.list || current.node);
      if (load) load();
      const nav = mounted.get(side.nav);
      if (nav) nav();
    }, LIVE_MS);
    render();
  }

  // 채팅 화면 왼쪽 메뉴 '노트' 아래 '회의 업무' → 회의 업무 화면 (/meetings/, gateway/static/meetings/index.html의 #nv-desk)
  const DESK = '/meetings/';
  const NAV_ID = 'navitech-meetings-link';
  let recordAsked = new URLSearchParams(location.search).get('nv_record'); // 회의 업무 화면의 '녹음 시작'으로 연 채팅

  function toMeetingChat() {
    location.href = `/?models=${MODEL}`;
  }

  function addNav() {
    if (document.getElementById(NAV_ID)) return;
    const notes = document.querySelector('a[href="/notes"]');
    if (!notes) return;
    // 같은 모양을 쓰도록 '노트' 항목(감싼 요소가 있으면 그것까지)을 복제합니다.
    const item = notes.parentElement && notes.parentElement.children.length === 1 ? notes.parentElement : notes;
    const copy = item.cloneNode(true);
    const link = copy.matches('a') ? copy : copy.querySelector('a');
    copy.id = NAV_ID;
    link.href = DESK;
    link.removeAttribute('aria-current');
    link.setAttribute('aria-label', '회의 업무');
    const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeValue.trim()) { n.nodeValue = '회의 업무'; break; }
    }
    const svg = link.querySelector('svg');
    if (svg) {
      svg.innerHTML = '';
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.5');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('d', CALENDAR);
      svg.append(path);
    }
    // Open WebUI(SvelteKit) 라우터가 가로채지 않도록 전체 페이지로 이동합니다.
    link.addEventListener('click', (e) => { e.preventDefault(); location.href = DESK; });
    item.insertAdjacentElement('afterend', copy);
  }

  function navTick() {
    addNav();
    if (recordAsked && document.getElementById('voice-input-button') && inMeetingChat()) {
      const id = recordAsked;
      recordAsked = null;
      startRecording(id);
    }
  }

  function startRecording(meetingId) {
    const mic = document.getElementById('voice-input-button');
    if (!mic || !inMeetingChat()) {
      // 회의 업무 화면에서: 새 회의지원 채팅을 열어 녹음한다
      location.href = `/?models=${MODEL}&nv_record=${encodeURIComponent(meetingId)}`;
      return;
    }
    if (rec) return;
    pendingMeeting = meetingId;
    mic.click();
  }

  const RENDER = { meeting: (c) => meetingCard(c.id), meetings: (c) => meetingsCard(c.ids || []), items: (c) => itemsCard(c.ids || []), mail: (c) => mailCard(c.ids || []) };

  // 답변 안의 ```navitech 블록 → 카드 (Open WebUI가 메시지를 다시 그리면 다시 붙인다)
  function mountCards() {
    for (const code of document.querySelectorAll('.language-navitech')) {
      const block = code.closest('.rounded-2xl.border') || code.parentElement;
      if (!block || block.classList.contains('nv-hidden-block')) continue;
      const text = (code.querySelector('.cm-content') || code).textContent.trim();
      let card;
      try { card = JSON.parse(text); } catch { continue; } // 아직 스트리밍 중
      const render = RENDER[card.card];
      if (!render) continue;
      block.classList.add('nv-hidden-block');
      const node = render(card);
      node.dataset.nvCard = text;
      block.after(node);
    }
  }

  const deskRoot = document.getElementById('nv-desk');
  if (deskRoot) {
    deskApp(deskRoot);
  }

  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; mountCards(); navTick(); }, 250);
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
