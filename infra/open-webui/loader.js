// Open WebUI가 모든 페이지에서 불러오는 빈 훅(/static/loader.js)입니다 (docker-compose.yml에서 이 파일을 덮어씀).
// 고정 Agent 목록의 제목을 바꾸고, 회의지원 Agent 채팅에 녹음 효과 · 자동 회의록 요청 · 회의 카드를 더합니다.
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
  // 회의 카드: 회의지원 Agent 답변 끝의 ```navitech 블록(gateway가 회의 Tool 결과로 붙임)을 카드로 바꾼다.
  // 카드 내용은 회의 업무 API(/meetings/api/*)에서 그때그때 읽고, 버튼도 그 API를 부른다 (확정만 Agent에게 요청).
  // 새 회의지원 채팅의 첫 화면에는 오늘의 회의 업무 카드를 둔다. 모든 글자는 textContent로 넣는다.
  // ---------------------------------------------------------------------------
  const LEVEL = { 1: '공개', 2: '사내', 3: '대외비', 4: '극비' };
  const ROLE = { chair: '의장', secretary: '간사', observer: '배석', optional: '선택' };
  const KIND = { decision: '결정', resolution: '의결', criterion: '기준', opinion: '의견', issue: '쟁점' };
  const ITEM = { open: '미착수', in_progress: '진행 중', blocked: '막힘', done: '완료', cancelled: '취소' };
  const MAIL = { sent: '보냄', approved: '보내는 중', pending: '대기', needs_address: '주소 없음', failed: '보내지 못함', rejected: '취소함' };
  const MAIL_KIND = { minutes: '회의록', assignment: '업무 배정', schedule: '회의 안내', reminder: '기한 알림' };
  const WEEK = '일월화수목금토';
  const doneItems = new Map(); // 이 화면에서 완료한 할 일 id → 그 할 일 (목록 API는 열린 것만 돌려줌)

  const CARD_CSS = `
  :root{--nv-bg:#fff;--nv-sub:#f6f6f8;--nv-line:rgba(0,0,0,.09);--nv-muted:#6b7280;--nv-brand:#5b5bd6}
  :root.dark{--nv-bg:#1b1b1d;--nv-sub:#232326;--nv-line:rgba(255,255,255,.1);--nv-muted:#9ca3af;--nv-brand:#8b8cf8}
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
  .nv-hidden-block{display:none!important}`;

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

  // 채팅 입력창에 글을 넣고 보낸다 (확정처럼 Agent가 해야 하는 일)
  function ask(text) {
    const input = document.getElementById('chat-input');
    if (!input || !input.editor) return;
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

  function shell(build) {
    cardStyle();
    const node = h('div', { class: 'nv-card' }, h('div', { class: 'nv-loading' }, '불러오는 중…'));
    const load = async () => {
      try { node.replaceChildren(...[await build(load)].flat().filter((c) => c != null && c !== '')); } catch (e) {
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

  // 할 일 한 줄: 완료 · 진행 중, 담당 · 기한 지정 (확정된 회의록의 할 일이면 새 담당자에게 업무 배정 메일이 감)
  function itemRow(it, reload, withMeeting, open = false) {
    const [due, tone] = dueText(it.due);
    const done = it.status === 'done';
    const owner = h('input', { class: 'nv-input', placeholder: '담당 (이름 또는 부서, 예: 박지훈 · 재무기획팀)', value: it.owner || '' });
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
          h('span', { class: it.owner ? '' : 'nv-danger' }, it.owner || '담당 미정'),
          withMeeting && it.meeting ? ` · ${it.meeting.title}` : '', ` · ${ITEM[it.status] || it.status}`),
        editor),
      done ? h('span', { class: 'nv-chip final' }, '완료') : h('div', { class: 'nv-btns' },
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

  function minutesView(d, reload) {
    const m = d.meeting;
    const open = (d.flags || []).filter((f) => f.status === 'open');
    const missing = m.status === 'final' ? [] : m.open_action_items.filter((it) => !it.owner || !it.due);
    const decided = m.decisions.filter((x) => ['decision', 'resolution', 'criterion'].includes(x.kind));
    const people = (d.participants || []).map((p) => `${p.name}${ROLE[p.role] ? ` · ${ROLE[p.role]}` : ''}`);
    const details = h('div', { hidden: true },
      m.decisions.length ? section('결정 · 기준 · 의견', m.decisions.map((x) => h('div', { class: 'nv-row top' },
        h('span', { class: `nv-tag ${['decision', 'resolution', 'criterion'].includes(x.kind) ? 'brand' : ''}` }, KIND[x.kind] || x.kind),
        h('div', { class: 'nv-grow' }, h('div', {}, x.statement), x.speaker ? h('div', { class: 'nv-meta' }, x.speaker) : '')))) : '',
      m.open_issues.length ? section('미결 쟁점', m.open_issues.map((x) => h('div', { class: 'nv-row' }, h('div', { class: 'nv-grow' }, x.statement)))) : '',
      m.open_action_items.length ? section('열린 할 일', m.open_action_items.map((it) => itemRow(it, reload))) : '');
    const more = h('button', { class: 'nv-btn', type: 'button', onclick: () => { details.hidden = !details.hidden; more.textContent = details.hidden ? '자세히' : '접기'; } }, '자세히');
    return [
      head(h('span', {}, m.title, m.classification >= 3 ? h('span', { class: 'nv-chip secret' }, LEVEL[m.classification]) : ''),
        `${when(m.date, m.time)} · ${m.id}`,
        h('span', { class: `nv-chip ${m.status === 'final' ? 'final' : 'draft'}` }, m.status === 'final' ? '확정' : '초안')),
      people.length ? h('div', { class: 'nv-people' }, `참석 ${people.join(', ')}`) : '',
      m.summary ? h('div', { class: 'nv-summary' }, m.summary) : '',
      h('div', { class: 'nv-stats' }, stat('결정', decided.length), stat('열린 할 일', m.open_action_items.length),
        m.open_issues.length ? stat('미결 쟁점', m.open_issues.length) : '', open.length ? stat('위험 발언', open.length, 'draft') : ''),
      open.length ? section(`위험 발언 검토 ${open.length}건 — 검토해야 확정할 수 있습니다`, flagRows(m.id, open, reload)) : '',
      missing.length ? section(`담당 · 기한을 정해야 확정할 수 있습니다 (${missing.length}건)`, missing.map((it) => itemRow(it, reload, false, true))) : '',
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

  // 열린 할 일 전체 (담당 · 기한 지정 포함)
  function allItemsCard() {
    return shell(async (reload) => {
      const d = await api('items', { view: 'all' });
      const items = d.items || [];
      return [head(`열린 할 일 ${items.length}건`, d.as_of ? `기준 ${d.as_of}` : ''), h('div', { class: 'nv-sec' }, items.map((it) => itemRow(it, reload, true)))];
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

  // 최근 메일 (보내지 못한 메일을 먼저)
  function recentMailCard() {
    return shell(async (reload) => {
      const d = await api('mail', { action: 'list' });
      const order = { failed: 0, needs_address: 1, pending: 2, approved: 3 };
      const mails = (d.mails || []).slice().sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9)).slice(0, 12);
      return [head(`최근 메일 ${d.matched || mails.length}건 중 ${mails.length}건`, d.smtp_configured === false ? '메일 서버가 설정되지 않아 발송 대기 중입니다' : '보내지 못한 메일이 위에 옵니다'),
        h('div', { class: 'nv-sec' }, mails.map((m) => mailRow(m, reload)))];
    });
  }

  function mailCard(ids) {
    return shell(async (reload) => {
      const d = await api('mail', { action: 'list' });
      const byId = Object.fromEntries((d.mails || []).map((m) => [m.id, m]));
      const rows = ids.map((id) => (byId[id] ? mailRow(byId[id], reload) : h('div', { class: 'nv-row nv-meta' }, `${id} · 지난 메일`)));
      return [head(`메일 ${ids.length}건`, d.smtp_configured === false ? '메일 서버가 설정되지 않아 발송 대기 중입니다' : ''), h('div', { class: 'nv-sec' }, rows)];
    });
  }

  // 새 회의지원 채팅의 첫 화면: 다가오는 회의 · 최근 회의록 · 내 할 일 · 검토 · 보내지 못한 메일
  function overviewCard() {
    return shell(async (reload) => {
      const d = await api('overview');
      const c = d.counts;
      const today = d.today;
      const upcoming = (d.upcoming || []).slice(0, 3).map((s) => meetingRow(s.id, s.title, `${dateLabel(s.starts_at)} ${slot(s)}${s.location ? ` · ${s.location}` : ''}`,
        h('span', { class: 'nv-chip' }, s.starts_at.slice(0, 10) === today ? '오늘' : '예정'),
        s.starts_at.slice(0, 10) === today ? h('button', { class: 'nv-btn small rec', type: 'button', onclick: (e) => { e.stopPropagation(); startRecording(s.id); } }, '녹음 시작') : ''));
      const minutes = (d.minutes || []).slice(0, 3).map((m) => meetingRow(m.id, m.title, when(m.date, m.time),
        h('span', { class: `nv-chip ${m.status === 'final' ? 'final' : 'draft'}` }, m.status === 'final' ? '확정' : '초안'),
        m.open_flags ? h('span', { class: 'nv-chip draft' }, `위험 발언 ${m.open_flags}`) : ''));
      const mine = h('div', { hidden: true }, (d.my_items || []).map((it) => itemRow(it, reload, true)));
      const all = h('div', { style: 'padding:0 16px' });
      const mails = h('div', { style: 'padding:0 16px' });
      const unsent = c.mail_failed + c.mail_needs_address;
      return [
        head('오늘의 회의 업무', `${dateLabel(today)} · ${d.viewer.name || d.viewer.email}`),
        h('div', { class: 'nv-stats' },
          h('button', { class: 'nv-btn small', type: 'button', onclick: () => { mine.hidden = !mine.hidden; } },
            `내 할 일 ${c.my_items}`, c.my_overdue ? h('span', { class: 'nv-danger' }, ` · 지남 ${c.my_overdue}`) : ''),
          h('button', { class: 'nv-btn small', type: 'button', onclick: () => { if (all.firstChild) all.replaceChildren(); else all.append(allItemsCard()); } }, '전체 할 일'),
          c.flags_open ? h('button', { class: 'nv-btn small', type: 'button', onclick: () => ask('검토가 필요한 위험 발언이 있는 회의록 보여 줘.') }, h('span', { class: 'nv-warn' }, `위험 발언 검토 ${c.flags_open}`)) : '',
          h('button', { class: 'nv-btn small', type: 'button', onclick: () => { if (mails.firstChild) mails.replaceChildren(); else mails.append(recentMailCard()); } },
            `메일 · 보냄 ${c.mail_sent}`, unsent ? h('span', { class: 'nv-warn' }, ` · 못 보냄 ${unsent}`) : '')),
        all, mails,
        mine.childNodes.length ? h('div', { class: 'nv-sec' }, mine) : '',
        upcoming.length ? section('다가오는 회의', upcoming) : '',
        minutes.length ? section('최근 회의록', minutes) : '',
      ];
    });
  }

  function startRecording(meetingId) {
    const mic = document.getElementById('voice-input-button');
    if (!mic || rec) return;
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

  function mountOverview() {
    if (document.getElementById('nv-overview') || location.pathname.startsWith('/c/') || !inMeetingChat()) return;
    const label = [...document.querySelectorAll('div')].find((e) => e.children.length <= 2 && e.textContent.trim() === '제안');
    const anchor = label && label.closest('.mx-auto');
    const place = anchor || (document.getElementById('chat-input') && document.getElementById('chat-input').closest('.m-auto'));
    if (!place) return;
    const node = overviewCard();
    node.id = 'nv-overview';
    node.style.margin = '18px auto 6px';
    if (anchor) anchor.before(node); else place.append(node);
  }

  function unmountOverview() {
    const node = document.getElementById('nv-overview');
    if (node && (location.pathname.startsWith('/c/') || !inMeetingChat())) node.remove();
  }

  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; mountCards(); unmountOverview(); mountOverview(); }, 250);
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
