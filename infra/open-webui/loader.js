// Open WebUI가 모든 페이지에서 불러오는 빈 훅(/static/loader.js)입니다 (docker-compose.yml에서 이 파일을 덮어씀).
// 왼쪽 메뉴의 '노트' 아래에 '회의 업무' 화면(/meetings/, gateway/desk.py) 링크를 더하고, 고정 Agent 목록의 제목을 바꿉니다.
(() => {
  const ID = 'navitech-meetings-link';
  const CALENDAR = 'M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5';

  function add() {
    if (document.getElementById(ID)) return;
    const notes = document.querySelector('a[href="/notes"]');
    if (!notes) return;
    // 같은 모양을 쓰도록 '노트' 항목(감싼 요소가 있으면 그것까지)을 복제합니다.
    const item = notes.parentElement && notes.parentElement.children.length === 1 ? notes.parentElement : notes;
    const copy = item.cloneNode(true);
    const link = copy.matches('a') ? copy : copy.querySelector('a');
    copy.id = ID;
    link.href = '/meetings/';
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
    link.addEventListener('click', (e) => { e.preventDefault(); location.href = '/meetings/'; });
    item.insertAdjacentElement('afterend', copy);
  }

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

  const run = () => { add(); rename(); };
  new MutationObserver(run).observe(document.documentElement, { childList: true, subtree: true });
  run();
})();
