// 独立离线回归：章节顺序、入口过滤，以及 OCS 接管后不重复打开首章。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  if (!process.env.OCS_PLAYWRIGHT_DIR) throw new Error('设置 OCS_PLAYWRIGHT_DIR 指向 playwright-core 目录');
  const { chromium } = require(process.env.OCS_PLAYWRIGHT_DIR);
  const browser = await chromium.launch({ executablePath: process.env.OCS_CHROME_PATH, headless: true });
  const source = fs.readFileSync(path.join(__dirname, 'ocs-course-switcher.user.js'), 'utf8');
  const key = 'ocs-course-switcher.v1';
  const listUrl = 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse?courseid=101&clazzid=201';
  const studyUrl = id => `https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=101&clazzid=201&chapterId=${id}`;
  const link = (id, extra = '') => `<a ${extra} href="${studyUrl(id)}">章节 ${id}</a>`;
  const checks = [];

  async function scenario(name, content, expected, followOCS = false, unidentified = false) {
    const context = await browser.newContext();
    let store = { [key]: {
      queue: [{ id: '101:201', name: '离线测试课程', url: listUrl, enabled: true }],
      running: true, owner: 'chapter-test', index: 0, phase: 'opening', mode: 'completion',
      epoch: Date.now(), openedAt: Date.now(), log: [],
    } };
    const visited = [], errors = [];
    await context.exposeBinding('__saveStore', (_, value) => { store = structuredClone(value); });
    await context.route('**/*', async route => {
      const request = route.request();
      if (!request.isNavigationRequest()) return route.abort();
      const url = new URL(request.url());
      if (!url.hostname.endsWith('.chaoxing.com')) return route.abort();
      visited.push(request.url());
      const isStudy = url.pathname.endsWith('/studentstudy');
      const body = unidentified && url.pathname === '/unidentified'
        ? '<h1>身份未知的父页面</h1><iframe src="/unknown-child"></iframe>'
        : isStudy ? `<h1>章节学习页</h1>${link('first')}` : content;
      const bridge = `window.__mockStore=${JSON.stringify(store)};
        window.GM_getValue=(k,d)=>structuredClone(window.__mockStore[k]??d);
        window.GM_setValue=(k,v)=>{window.__mockStore[k]=structuredClone(v);window.__saveStore(window.__mockStore)};
        window.GM={setValue:async(k,v)=>{window.__mockStore[k]=structuredClone(v);await window.__saveStore(window.__mockStore)}};
        window.GM_getTab=cb=>cb({ocsCourseSwitcherId:'chapter-test'});window.GM_saveTab=()=>{};
        window.getTeacherAjax=(course,clazz,id)=>{location.href=${JSON.stringify(studyUrl(''))}+id};
        window.toOld=(course,id)=>{location.href=${JSON.stringify(studyUrl(''))}+id};`;
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body>${body}<script>${bridge}</script><script>${source}</script></body></html>` });
    });
    try {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(unidentified ? 'https://mooc2-ans.chaoxing.com/unidentified' : listUrl, { waitUntil: 'domcontentloaded' });
      if (unidentified) {
        await page.waitForTimeout(3300);
        assert.equal(store[key].phase, 'opening', '未知身份的 iframe 不得写入 entering');
        assert.equal(store[key].log.length, 0);
        assert.ok(!visited.some(url => url.includes('/studentstudy')));
      } else {
        await page.waitForURL(studyUrl(expected));
        await page.waitForFunction(() => GM_getValue('ocs-course-switcher.v1').phase === 'studying');
        const entryLogs = store[key].log.filter(entry => entry.message.startsWith('正在进入第一个可点击章节'));
        assert.equal(entryLogs.length, 1);
        assert.ok(entryLogs[0].message.includes(`章节 ID：${expected}`));
        assert.ok(!entryLogs[0].message.includes('https://'));
        if (followOCS) {
          // OCS 后续前往另一章节，切换器只等待完成提示，不再点击首章。
          await page.goto(studyUrl('later'), { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(3300);
          assert.equal(page.url(), studyUrl('later'));
          assert.equal(store[key].phase, 'studying');
          assert.equal(store[key].log.filter(entry => entry.message.startsWith('正在进入第一个可点击章节')).length, 1);
          assert.equal(visited.filter(url => url === studyUrl(expected)).length, 1);
        }
      }
      assert.deepEqual(errors, []);
      checks.push(name);
    } finally { await context.close(); }
  }

  try {
    await scenario('普通链接首章优先于后面的 getTeacherAjax 章节', `${link('first')}<a onclick="getTeacherAjax('101','201','second')">第二节按钮</a>`, 'first', true);
    await scenario('toOld 首章优先于后面的高优先级类型', `<div class="chapter_item" onclick="toOld('101','first','201',0)">第一节按钮</div><a onclick="getTeacherAjax('101','201','second')">第二节按钮</a>`, 'first');
    await scenario('隐藏及锁定章节不作为可点击入口', `${link('hidden', 'style="display:none"')}<div class="locked"><a onclick="getTeacherAjax('101','201','locked')">锁定章节</a></div><div aria-disabled="true">${link('disabled')}</div>${link('first')}<a onclick="getTeacherAjax('101','201','second')">第二节按钮</a>`, 'first');
    await scenario('当前目录中其他课程的链接不能抢占入口', `<a href="https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=999&clazzid=201&chapterId=foreign">其他课程</a>${link('first')}`, 'first');
    await scenario('身份未知的 iframe 不得点击章节或写入执行阶段', '<a onclick="getTeacherAjax(\'101\',\'201\',\'wrong\')">未知页面章节</a>', '', false, true);
    checks.push('首章入口仅执行一次，OCS 后续章节导航不会被拉回首章');
    const report = { passed: true, version: source.match(/@version\s+(\S+)/)[1], checks, testedAt: new Date().toISOString(), scope: '独立 Chromium + 离线页面；不连接实际 OCS 浏览器或学习通服务器' };
    fs.writeFileSync(path.join(__dirname, 'chapters-verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
