// ==UserScript==
// @name         OCS 学习通多课程切换器
// @namespace    local.ocs-course-switcher
// @version      0.2.2
// @description  指定课程队列，进入首个章节，收到 OCS 完成提示后切换课程。
// @match        https://*.chaoxing.com/*
// @match        https://chaoxing.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.setValue
// @grant        GM_getTab
// @grant        GM_saveTab
// ==/UserScript==

(() => {
  'use strict';
  const KEY = 'ocs-course-switcher.v1';
  const DONE = '全部任务点已完成';
  function course(raw, name = '') {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || !/(^|\.)chaoxing\.com$/i.test(url.hostname)) return null;
      if (!/\/(?:mycourse\/(?:stu|studentcourse|studentstudy|transfer)|visit\/stucoursemiddle)\/?$/.test(url.pathname)) return null;
      const params = new Map([...url.searchParams].map(([k, v]) => [k.toLowerCase(), v]));
      const id = params.get('courseid'), clazz = params.get('clazzid');
      if (!id || !clazz) return null;
      return { id: `${id}:${clazz}`, name: name.trim().slice(0, 100) || `课程 ${id}`, url: url.href, enabled: true };
    } catch { return null; }
  }
  function merge(queue, items) {
    const out = queue.map(x => ({ ...x }));
    for (const item of items) {
      if (!item) continue;
      const old = out.find(x => x.id === item.id);
      if (!old) out.push(item);
      else {
        if (/^课程\s*\d+$/.test(old.name) && !/^课程\s*\d+$/.test(item.name)) old.name = item.name;
        old.url = item.url;
      }
    }
    return out;
  }
  function isDone(text) {
    // 未完成、最后一章、作业完成等消息均不能触发切课。
    return new RegExp(`^${DONE}[！!。\\s]*$`).test(text.trim());
  }
  function nextIndex(queue, index) {
    for (let i = index + 1; i < queue.length; i++) if (queue[i].enabled) return i;
    return -1;
  }
  function sameCourse(a, b) { return Boolean(a && b && a.id === b.id); }
  const core = { course, merge, isDone, nextIndex, sameCourse };
  if (typeof module === 'object' && module.exports) { module.exports = core; return; }

  let tabId, panel, lastView = '', busy = false, dragging = false;
  let pendingWrite = Promise.resolve();
  const scrollPosition = { body: 0, list: 0 };
  const UIKEY = `${KEY}.window`;
  const view = { width: 540, font: 18, collapsed: false, ...GM_getValue(UIKEY, {}) };
  function saveView() { GM_setValue(UIKEY, view); }
  function placePanel() {
    panel.style.width = `${Math.min(view.width, innerWidth - 24)}px`;
    panel.style.fontSize = `${view.font}px`;
    if (Number.isFinite(view.left) && Number.isFinite(view.top)) {
      const rect = panel.getBoundingClientRect();
      panel.style.left = `${Math.max(8, Math.min(view.left, innerWidth - rect.width - 8))}px`;
      panel.style.top = `${Math.max(8, Math.min(view.top, innerHeight - Math.min(rect.height, 80) - 8))}px`;
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    }
  }
  function dragWindow(handle) {
    handle.onpointerdown = event => {
      if (event.button !== 0 || event.target.closest('button,select')) return;
      event.preventDefault(); dragging = true;
      const rect = panel.getBoundingClientRect(), startX = event.clientX, startY = event.clientY;
      handle.setPointerCapture(event.pointerId);
      handle.onpointermove = move => {
        view.left = rect.left + move.clientX - startX;
        view.top = rect.top + move.clientY - startY;
        placePanel();
      };
      const finish = () => { dragging = false; handle.onpointermove = null; saveView(); };
      handle.onpointerup = finish; handle.onpointercancel = finish;
    };
  }
  let observedDone = false;
  const initial = () => ({ queue: [], running: false, owner: '', index: -1, phase: 'idle', mode: 'completion', minutes: 60, log: [], epoch: 0 });
  const read = () => ({ ...initial(), ...GM_getValue(KEY, {}) });
  function write(s) { GM_setValue(KEY, s); pendingWrite = GM.setValue(KEY, s); }
  function note(s, message) {
    s.log = [...s.log, { time: new Date().toLocaleTimeString(), message }].slice(-30);
  }
  function commit(change) {
    const s = read(); change(s); write(s); return s;
  }
  function stop(message) {
    commit(s => { s.running = false; s.phase = 'paused'; s.error = message; note(s, message); });
  }
  function visible(el) {
    if (!el || el.closest('[data-ocs-switcher]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }
  function title() {
    const el = document.querySelector('.course-name,.courseName,.course_name,dd.textHidden[title],h1');
    const text = el?.getAttribute('title') || el?.textContent?.trim() || document.title;
    return /学生学习页面|个人空间/.test(text) ? '' : text;
  }
  function cardName(el) {
    const clean = value => (value || '').replace(/\s+/g, ' ').trim();
    let node = el;
    for (let depth = 0; node && depth < 6 && !/^(BODY|HTML)$/.test(node.tagName); depth++, node = node.parentElement) {
      const identities = new Set([...node.querySelectorAll('a[href]')].map(a => course(a.href)?.id).filter(Boolean));
      if (identities.size > 1) break;
      const titles = [...node.querySelectorAll('.course-name,.courseName,.course_name,.course-title,.course-info h3,.course-info h2,h3,h4,.coursename')];
      const heading = titles.find(x => clean(x.getAttribute('title') || x.textContent));
      if (heading) return clean(heading.getAttribute('title') || heading.textContent);
      const direct = clean(node.getAttribute('title') || (node === el ? node.textContent : ''));
      if (direct && direct.length < 120 && !/^(进入课程|课程封面|点击进入|课程门户)$/.test(direct)) return direct;
      // 不跨到含多个课程的列表容器，避免给全部课程套用第一门名称。
    }
    return clean(el.querySelector('img')?.getAttribute('alt'));
  }
  function scan() {
    const results = [];
    const walk = doc => {
      for (const a of doc.querySelectorAll('a[href]')) {
        const item = course(a.href, cardName(a));
        if (item) results.push(item);
      }
      // 新版课程卡片常由 onclick 打开，优先保留页面自带的完整 URL。
      for (const el of doc.querySelectorAll('[onclick],[data-url]')) {
        const code = el.getAttribute('onclick') || '';
        const urls = [el.getAttribute('data-url'), ...[...code.matchAll(/['"]((?:https:\/\/|\/)[^'"]+)['"]/g)].map(m => m[1])];
        for (const raw of urls) {
          if (!raw) continue;
          const item = course(new URL(raw, doc.location.href).href, cardName(el));
          if (item) results.push(item);
        }
      }
      for (const frame of doc.querySelectorAll('iframe')) { try { if (frame.contentDocument) walk(frame.contentDocument); } catch {} }
    };
    walk(document);
    return merge([], results);
  }
  async function persist() { await pendingWrite; }
  async function go(url) { await persist(); location.assign(url); }
  function activate(index, reason) {
    const s = read();
    if (index < 0) {
      s.running = false; s.phase = 'finished'; s.error = ''; note(s, '所选课程队列已结束'); write(s); return;
    }
    const target = s.queue[index];
    if (!target || !course(target.url)) { stop('课程链接无效，请重新添加'); return; }
    Object.assign(s, { running: true, owner: tabId, index, phase: 'opening', error: '', epoch: Date.now(), openedAt: Date.now(), menuAt: 0, clickedAt: 0, studyingAt: 0, chapterListOpened: false });
    note(s, `${reason}：${target.name}`); write(s);
    go(target.url);
  }
  function next(reason) {
    const s = read();
    if (!s.running || s.owner !== tabId) return;
    activate(nextIndex(s.queue, s.index), reason);
  }
  async function clickHere(el) {
    await persist();
    const link = el.closest('a[href]');
    if (link && /^https?:/.test(link.href)) { go(link.href); return; }
    el.click();
  }
  function findFirstChapter() {
    // 只查找用于进入章节的按钮，不读取任务点数量或章节完成状态。
    const selectors = [
      '[onclick^="getTeacherAjax"]',
      '[onclick*="clickChapter("]',
      '[onclick*="jumpToChapter("]',
      '[onclick*="toKnowledge("]',
      '.chapter_item[onclick^="toOld("]',
      'a[href*="/mycourse/studentstudy"][href*="chapterId="]',
      'a[href*="/mycourse/studentstudy"][href*="chapterid="]',
      '.posCatalog_name[onclick]',
      '.chapter_item [onclick*="getTeacherAjax"]',
      '.chapter_unit .catalog_name',
      '.chapter_item .catalog_name',
      '.chapter_unit .chapter_name',
      '[data-knowledgeid][onclick]'
    ];
    for (const selector of selectors) {
      const found = [...document.querySelectorAll(selector)].find(el => visible(el) && !el.closest('[aria-disabled="true"],.locked,.lock'));
      if (found) return found;
    }
    return null;
  }
  function studyPage() { return /\/mycourse\/studentstudy(?:\/|$)/.test(location.pathname); }
  function contextCourse() { return course(location.href) || course(document.referrer); }
  function completionVisible() {
    const roots = [document];
    // OCS 面板版本可能使用 Shadow DOM。
    for (let i = 0; i < roots.length; i++) for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
    for (const root of roots) for (const el of root.querySelectorAll('*')) {
      if ((el.textContent || '').length < 100 && isDone(el.textContent || '') && visible(el)) return true;
    }
    return false;
  }
  function clearOldCompletion() { observedDone = completionVisible(); }
  async function tick() {
    if (busy || !tabId) return;
    busy = true;
    try {
      const s = read();
      if (window === window.top) render(s);
      if (!s.running || s.owner !== tabId) return;
      // 登录、验证由用户处理，停止后队列仍保留。
      if (/passport2\.chaoxing\.com/.test(location.hostname)) { stop('登录已失效，请登录后点“继续当前门”'); return; }
      const expected = s.queue[s.index];
      const current = window === window.top ? course(location.href) : contextCourse();
      if (current && !sameCourse(current, expected)) {
        if (s.phase === 'opening' && Date.now() - s.openedAt < 30000) return;
        if (window === window.top) stop('当前页面不是队列中的课程，已暂停，请点“继续当前门”');
        return;
      }
      const now = Date.now();
      if (window === window.top && current) {
        const named = course(location.href, title());
        const old = s.queue.find(x => x.id === current.id);
        if (old && /^课程\s*\d+$/.test(old.name) && named && !/^课程\s*\d+$/.test(named.name)) {
          old.name = named.name; write(s);
        }
      }
      if (s.phase === 'opening') {
        if (window === window.top && !s.chapterListOpened) {
          const listFrame = [...document.querySelectorAll('iframe[src]')].find(frame => {
            try { const url = new URL(frame.src); return /\/mycourse\/studentcourse$/.test(url.pathname) && sameCourse(course(url.href), expected); } catch { return false; }
          });
          if (listFrame) {
            s.chapterListOpened = true; s.openedAt = now; note(s, '打开课程章节列表'); write(s); go(listFrame.src); return;
          }
        }
        const first = findFirstChapter();
        if (first) {
          // 必须属于当前课程。跨课程旧 iframe 不执行。
          if (!current && window === window.top) return;
          const fresh = read();
          if (fresh.epoch !== s.epoch || fresh.phase !== 'opening') return;
          fresh.phase = 'entering'; fresh.clickedAt = now; note(fresh, '正在进入第一个可点击章节'); write(fresh);
          clearOldCompletion(); clickHere(first); return;
        }
        if (!s.menuAt) {
          const menu = [...document.querySelectorAll('a,[role="tab"],li[onclick]')].find(el => visible(el) && (/^(章节|课程章节)$/.test(el.getAttribute('title') || '') || /^(章节|课程章节)(?:\s*NEW)?$/i.test(el.textContent.trim())));
          if (menu) { s.menuAt = now; write(s); clickHere(menu); return; }
        }
        if (window === window.top && now - s.openedAt > 45000) stop('未找到首个章节入口。请手动进入第一个章节，再点“已进入章节”');
      } else if (s.phase === 'entering') {
        if (studyPage() && current && sameCourse(current, expected)) {
          s.phase = 'studying'; s.studyingAt = now; note(s, '已进入章节，交给 OCS 运行'); write(s); clearOldCompletion();
        } else if (window === window.top && now - s.clickedAt > 30000) stop('章节入口已点击，但未确认进入学习页；请手动进入后点“已进入章节”');
      } else if (s.phase === 'studying') {
        // 仅当前课程的学习页面可以发送完成信号。
        if (!(studyPage() || /\/knowledge\/cards$/.test(location.pathname)) || !sameCourse(current, expected)) return;
        if (s.mode === 'timer') {
          if (now - s.studyingAt >= s.minutes * 60000) next('到达设定停留时间，进入下一门');
        } else {
          const done = completionVisible();
          if (done && !observedDone && now - s.studyingAt > 5000) {
            // 先保存阶段，阻止 iframe 或定时器重复切课。
            s.phase = 'switching'; note(s, '收到 OCS“全部任务点已完成”提示'); write(s);
            if (window === window.top) next('OCS 提示完成，进入下一门');
          }
          // 初始已有的完成弹窗必须先消失，防止旧消息误触发。
          if (!done) observedDone = false;
        }
      } else if (s.phase === 'switching' && window === window.top) next('OCS 提示完成，进入下一门');
    } catch (error) { stop(`运行异常：${error.message}`); }
    finally { busy = false; }
  }

  function button(text, handler, parent) {
    const el = document.createElement('button'); el.textContent = text; el.onclick = handler; parent.append(el); return el;
  }
  function render(s) {
    if (dragging) return;
    const snapshot = JSON.stringify(s);
    if (snapshot === lastView) return;
    lastView = snapshot;
    if (!panel) {
      panel = document.createElement('div'); panel.dataset.ocsSwitcher = 'true';
      panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;width:540px;max-width:calc(100vw - 24px);max-height:85vh;color:#202b3c;background:white;border:1px solid #b9c8dc;border-radius:12px;box-shadow:0 6px 28px #0004;font:18px/1.65 system-ui;text-align:left;';
      panel.attachShadow({ mode: 'open' }); document.documentElement.append(panel);
    }
    const root = panel.shadowRoot;
    const oldBody = root.querySelector('.body'), oldList = root.querySelector('.course-list');
    if (oldBody?.closest('details')?.open) scrollPosition.body = oldBody.scrollTop;
    if (oldList?.closest('details')?.open) scrollPosition.list = oldList.scrollTop;
    root.replaceChildren();
    const style = document.createElement('style');
    style.textContent = ':host{display:block}*{box-sizing:border-box}summary{cursor:pointer;font-weight:700;padding:10px}.handle{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#eef4ff;border-radius:12px 12px 0 0;cursor:move;touch-action:none;user-select:none}.handle strong{font-size:1em}.body{padding:10px 16px 16px;max-height:72vh;overflow:auto}button,input,select,textarea{font:inherit}button{cursor:pointer;border:1px solid #bdcadb;border-radius:6px;background:#f5f8fc;color:#20344d;padding:7px 10px;margin:4px}button:disabled{opacity:.45;cursor:default}.row{display:flex;align-items:center;border-bottom:1px solid #e7ecf3;padding:8px 0;gap:5px}.name{flex:1;word-break:break-word}input[type=checkbox]{width:18px;height:18px}input[type=text],textarea,select{width:100%;border:1px solid #bdcadb;border-radius:5px;padding:8px;margin:5px 0}input[type=number]{width:80px}small{color:#5c6c80;font-size:.85em}p{margin:9px 0}.error{color:#b12727}';
    root.append(style);
    const handle = document.createElement('div'); handle.className = 'handle';
    const heading = document.createElement('strong'); heading.textContent = 'OCS 多课程切换器 · 0.2.2'; handle.append(heading);
    button(view.collapsed ? '展开' : '收起', () => { view.collapsed = !view.collapsed; saveView(); lastView = ''; render(read()); }, handle);
    root.append(handle); dragWindow(handle);
    const details = document.createElement('details'); details.open = !view.collapsed;
    const hiddenSummary = document.createElement('summary'); hiddenSummary.style.display = 'none'; details.append(hiddenSummary);
    const body = document.createElement('div'); body.className = 'body'; details.append(body); root.append(details);
    const status = document.createElement('p');
    const labels = { idle: '未开始', opening: '正在打开课程', entering: '正在进入第一章节', studying: s.mode === 'completion' ? '等待 OCS 完成提示' : '按时间等待切课', switching: '正在切换', paused: '已暂停', finished: '队列结束' };
    status.textContent = `${labels[s.phase] || s.phase}${s.index >= 0 && s.queue[s.index] ? ' · ' + s.queue[s.index].name : ''}`; body.append(status);
    if (s.running && s.owner !== tabId) { const other = document.createElement('p'); other.textContent = '队列在另一标签页运行；此页仅显示状态。'; body.append(other); }
    if (s.error) { const err = document.createElement('p'); err.className = 'error'; err.textContent = s.error; body.append(err); }
    const controls = document.createElement('div'); body.append(controls);
    const size = document.createElement('select'); size.setAttribute('aria-label', '悬浮窗大小');
    for (const [width, font, label] of [[460,16,'标准'],[540,18,'大号（默认）'],[640,20,'超大']]) {
      const option = document.createElement('option'); option.value = `${width},${font}`; option.textContent = `界面大小：${label}`; size.append(option);
    }
    size.value = `${view.width},${view.font}`;
    size.onchange = () => { [view.width, view.font] = size.value.split(',').map(Number); saveView(); placePanel(); };
    body.prepend(size);
    button('添加当前课程', () => {
      const item = course(location.href, title());
      if (!item) return alert('请先进入某门课程的首页或章节学习页，再添加。');
      commit(x => { if (x.running) return; x.queue = merge(x.queue, [item]); });
    }, controls).disabled = s.running;
    button('扫描本页课程', () => {
      const items = scan();
      if (!items.length) return alert('本页没有识别到完整课程链接。可以逐门进入课程后点“添加当前课程”，或粘贴课程链接。');
      commit(x => { if (!x.running) x.queue = merge(x.queue, items); });
    }, controls).disabled = s.running;
    const list = document.createElement('div');
    list.className = 'course-list';
    list.style.cssText = 'max-height:30vh;overflow:auto;border:1px solid #e1e7f0;border-radius:6px;padding:0 5px;margin:8px 0;';
    body.append(list);
    s.queue.forEach((item, i) => {
      const row = document.createElement('div'); row.className = 'row';
      const checked = document.createElement('input'); checked.type = 'checkbox'; checked.checked = item.enabled; checked.disabled = s.running;
      checked.onchange = () => commit(x => { if (!x.running) x.queue[i].enabled = checked.checked; }); row.append(checked);
      const name = document.createElement('span'); name.className = 'name'; name.textContent = `${i === s.index ? '▶ ' : ''}${item.name}`; row.append(name);
      button('↑', () => commit(x => { if (!x.running && i > 0) [x.queue[i - 1], x.queue[i]] = [x.queue[i], x.queue[i - 1]]; }), row).disabled = s.running || i === 0;
      button('×', () => commit(x => { if (!x.running) x.queue.splice(i, 1); }), row).disabled = s.running;
      list.append(row);
    });
    const add = document.createElement('details'), addSummary = document.createElement('summary'); addSummary.textContent = '粘贴课程链接'; add.append(addSummary);
    const input = document.createElement('textarea'); input.placeholder = '每行：课程名称 | https://…课程链接\n也可以只填课程链接'; add.append(input);
    button('加入队列', () => {
      const items = input.value.split('\n').filter(x => x.trim()).map(line => { const at = line.indexOf('|'); return at < 0 ? course(line.trim()) : course(line.slice(at + 1).trim(), line.slice(0, at).trim()); });
      if (!items.length || items.some(x => !x)) return alert('链接无效。请使用学习通课程首页或章节页的完整 HTTPS 地址。');
      commit(x => { if (!x.running) x.queue = merge(x.queue, items); }); input.value = '';
    }, add).disabled = s.running; body.append(add);
    const mode = document.createElement('select');
    for (const [value, text] of [['completion', '收到 OCS“全部任务点已完成”后切换'], ['timer', '按指定分钟数切换（不代表课程完成）']]) {
      const opt = document.createElement('option'); opt.value = value; opt.textContent = text; mode.append(opt);
    }
    mode.value = s.mode; mode.disabled = s.running; mode.onchange = () => commit(x => { if (!x.running) x.mode = mode.value; }); body.append(mode);
    if (s.mode === 'timer') {
      const minutes = document.createElement('input'); minutes.type = 'number'; minutes.min = '1'; minutes.max = '1440'; minutes.value = String(s.minutes); minutes.disabled = s.running;
      minutes.onchange = () => commit(x => { if (!x.running) x.minutes = Math.max(1, Math.min(1440, Number(minutes.value) || 60)); }); body.append('每门停留 ', minutes, ' 分钟');
    }
    const actions = document.createElement('div'); body.append(actions);
    button('开始队列', () => activate(nextIndex(read().queue, -1), '开始课程'), actions).disabled = s.running || !s.queue.some(x => x.enabled);
    button('暂停', () => stop('已暂停自动切课；OCS 的当前播放需在 OCS 面板控制'), actions).disabled = !s.running;
    button('继续当前门', () => { const x = read(); if (x.index >= 0) activate(x.index, '重新打开当前课程'); }, actions).disabled = s.running || s.index < 0;
    button('立即下一门', () => { if (confirm('现在切换下一门？当前课程可能尚未完成。')) next('用户手动切换下一门'); }, actions).disabled = !s.running || s.owner !== tabId;
    button('已进入章节', () => {
      const x = read();
      if (!studyPage() || !sameCourse(course(location.href), x.queue[x.index])) return alert('请在队列当前课程的章节学习页操作。');
      Object.assign(x, { running: true, owner: tabId, phase: 'studying', studyingAt: Date.now(), error: '' }); note(x, '用户确认已进入章节，等待 OCS 完成提示'); write(x); clearOldCompletion();
    }, actions).disabled = s.index < 0 || (s.running && s.owner !== tabId);
    const hint = document.createElement('p'); hint.innerHTML = '<small>默认只监听 OCS 的完整完成提示。不判断章节进度。请关闭 OCS“完成全部后重新学习”；不要同时运行两个课程队列。</small>'; body.append(hint);
    const logs = document.createElement('details'), ls = document.createElement('summary'); ls.textContent = '运行记录'; logs.append(ls);
    for (const entry of s.log.slice(-8).reverse()) { const p = document.createElement('p'); p.textContent = `${entry.time} ${entry.message}`; logs.append(p); } body.append(logs);
    const dragHint = document.createElement('small'); dragHint.textContent = '拖动顶部标题栏可移动悬浮窗，位置和字号会自动保存。'; body.append(dragHint);
    placePanel();
    if (!view.collapsed) {
      list.scrollTop = scrollPosition.list;
      body.scrollTop = scrollPosition.body;
    }
  }
  function initTab() { GM_getTab(tab => {
    if (!tab.ocsCourseSwitcherId && window !== window.top) { setTimeout(initTab, 500); return; }
    tab.ocsCourseSwitcherId ||= `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    GM_saveTab(tab); tabId = tab.ocsCourseSwitcherId;
    clearOldCompletion(); tick(); setInterval(tick, 1500);
  }); }
  initTab();
})();
