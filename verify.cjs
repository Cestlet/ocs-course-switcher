// 独立离线页面验证；不连接用户当前浏览器，不访问学习通服务器。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('./ocs-course-switcher.user.js');

async function main() {
  const a = 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=101&clazzid=201&cpi=301';
  const b = 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=102&clazzid=202&cpi=302';
  assert.equal(core.course(a).id, '101:201');
  assert.equal(core.course(a.replace('chaoxing.com', 'chaoxing.com.evil.test')), null);
  assert.equal(core.course(a.replace('https:', 'javascript:')), null);
  assert.equal(core.course('https://mooc1.chaoxing.com/mycourse/studentstudy'), null);
  assert.equal(core.merge([core.course(a)], [core.course(a), core.course(b)]).length, 2);
  assert.equal(core.merge([{...core.course(a),enabled:false}], [core.course(a,'安全操作课程')])[0].name, '安全操作课程');
  assert.equal(core.merge([{...core.course(a),enabled:false}], [core.course(a,'安全操作课程')])[0].enabled, false);
  for (const text of ['全部任务点已完成！', ' 全部任务点已完成! ']) assert.ok(core.isDone(text));
  for (const text of ['仍有任务点未完成', '已经抵达最后一个章节！', '作业完成', '章节任务点已完成', '全部任务点已完成，但仍需检查']) assert.ok(!core.isDone(text));
  assert.equal(core.nextIndex([{ enabled: true }, { enabled: false }, { enabled: true }], 0), 2);
  assert.equal(core.nextIndex([{ enabled: true }], 0), -1);

  const moduleDir = process.env.OCS_PLAYWRIGHT_DIR;
  if (!moduleDir) throw new Error('设置 OCS_PLAYWRIGHT_DIR 指向本机 playwright-core 目录');
  const { chromium } = require(moduleDir);
  const browser = await chromium.launch({ executablePath: process.env.OCS_CHROME_PATH, headless: true });
  let store = {};
  const key = 'ocs-course-switcher.v1';
  const source = fs.readFileSync(path.join(__dirname, 'ocs-course-switcher.user.js'), 'utf8');
  const visited = [];
  const context = await browser.newContext();
  await context.exposeBinding('__saveStore', (_, value) => { store = structuredClone(value); });
  await context.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (!u.hostname.endsWith('.chaoxing.com')) return route.abort();
    if (!route.request().isNavigationRequest()) return route.abort();
    visited.push(u.pathname + u.search);
    let content;
    if (u.pathname === '/base') {
      content = `<h1>课程列表</h1><div class="course"><a href="${a}"><img></a><div class="course-info"><h3 title="课程甲">课程甲</h3></div></div><div class="course"><a href="${b}"><img></a><div class="course-info"><h3 title="课程乙">课程乙</h3></div></div>`;
    } else if (u.pathname.endsWith('/stu')) {
      const id = u.searchParams.get('courseid'), clazz = u.searchParams.get('clazzid');
      const src = `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse?courseid=${id}&clazzid=${clazz}`;
      content = `<h1>课程首页</h1><a title="章节" href="javascript:void(0)" onclick="const f=document.createElement('iframe');f.src='${src}';document.body.append(f)">章节 <span>NEW</span></a>`;
    } else if (u.pathname.endsWith('/studentcourse')) {
      const id = u.searchParams.get('courseid'), clazz = u.searchParams.get('clazzid');
      const firstUrl = `https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=${id}&clazzid=${clazz}&chapterId=first`;
      const firstEntry = id === '102'
        ? `<script>function toOld(){location.href=${JSON.stringify(firstUrl)}}</script><div class="chapter_item" onclick="toOld('102','first','202',0)">第一章节</div>`
        : `<a href="${firstUrl}">第一章节</a>`;
      content = `<h1>课程 ${id}</h1>${firstEntry}<a href="https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=${id}&clazzid=${clazz}&chapterId=second">第二章节</a>`;
    } else {
      content = '<h1>章节学习页</h1><p>OCS 在此运行</p><div id="message"></div>';
    }
    const bridge = `window.__mockStore=${JSON.stringify(store)}; window.GM_getValue=(k,d)=>structuredClone(window.__mockStore[k]??d); window.GM_setValue=(k,v)=>{window.__mockStore[k]=structuredClone(v);window.__saveStore(window.__mockStore)};window.GM={setValue:async(k,v)=>{window.__mockStore[k]=structuredClone(v);await window.__saveStore(window.__mockStore)}};window.GM_getTab=cb=>cb({ocsCourseSwitcherId:${JSON.stringify(u.searchParams.get('tab') === 'other' ? 'other-tab' : 'test-tab')}});window.GM_saveTab=()=>{};`;
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body>${content}<script>${bridge}</script><script>${source}</script></body></html>` });
  });
  try {
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto('https://i.chaoxing.com/base');
    await page.getByRole('button', { name: '扫描本页课程', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-ocs-switcher]').shadowRoot.textContent.includes('课程甲'));
    assert.equal(store[key].queue.length, 2);
    assert.deepEqual(store[key].queue.map(x=>x.name), ['课程甲','课程乙']);
    const floating = page.locator('[data-ocs-switcher]');
    const original = await floating.boundingBox();
    assert.ok(original.width >= 500);
    const handle = page.locator('.handle');
    const bar = await handle.boundingBox();
    await page.mouse.move(bar.x+70,bar.y+15);await page.mouse.down();await page.mouse.move(bar.x-120,bar.y-90,{steps:8});await page.mouse.up();
    const moved = await floating.boundingBox();assert.ok(Math.abs(moved.x-original.x)>100);
    await page.reload();
    const restored = await floating.boundingBox();assert.ok(Math.abs(restored.x-moved.x)<3);
    await page.getByRole('button',{name:'收起',exact:true}).click();
    await page.getByRole('button',{name:'展开',exact:true}).click();
    await page.getByRole('combobox',{name:'悬浮窗大小'}).selectOption('640,20');
    assert.ok((await floating.boundingBox()).width >= 630);
    await page.getByRole('button', { name: '开始队列', exact: true }).click();
    await page.waitForURL(/studentstudy.*chapterId=first/, { timeout: 15000 });
    await page.waitForFunction(() => GM_getValue('ocs-course-switcher.v1').phase === 'studying');
    assert.equal(store[key].index, 0);

    // 最后一章/未完成消息不会导致切课。
    await page.locator('#message').evaluate(el => { el.textContent = '已经抵达最后一个章节！但仍然有任务点未完成，请手动切换至未完成的章节。'; });
    await page.waitForTimeout(6500);
    assert.equal(store[key].index, 0);

    // 隐藏的历史消息不算实时完成提示。
    await page.locator('#message').evaluate(el => { el.style.display = 'none'; el.textContent = '全部任务点已完成！'; });
    await page.waitForTimeout(1700);
    assert.equal(store[key].index, 0);

    // 其他标签页看到同样的提示也不能切换主队列。
    const other = await context.newPage();
    await other.goto('https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=101&clazzid=201&chapterId=first&tab=other');
    await other.locator('#message').evaluate(el => { el.textContent = '全部任务点已完成！'; });
    await other.waitForTimeout(1700);
    assert.equal(store[key].index, 0);
    await other.close();

    await page.locator('#message').evaluate(el => { el.style.display = ''; el.textContent = '全部任务点已完成！'; });
    await page.waitForURL(/courseId=102.*chapterId=first/, { timeout: 15000 });
    await page.waitForFunction(() => GM_getValue('ocs-course-switcher.v1').phase === 'studying');
    assert.equal(store[key].index, 1);
    await page.waitForTimeout(6000);
    await page.locator('#message').evaluate(el => { el.textContent = '全部任务点已完成！'; });
    await page.waitForFunction(() => GM_getValue('ocs-course-switcher.v1').phase === 'finished', null, { timeout: 10000 });
    assert.equal(store[key].running, false);
    assert.ok(!visited.some(u => /chapterId=second/.test(u)));
    assert.deepEqual(errors, []);
    await page.waitForFunction(() => document.querySelector('[data-ocs-switcher]').shadowRoot.textContent.includes('队列结束'));
    await page.screenshot({ path: path.join(__dirname, 'verification.png'), fullPage: true });
    const report = { passed: true, checks: ['课程链接白名单与身份', '课程去重及跳过未勾选项', '只接受完整完成提示', '扫描两门课程并依次进入第一章', '带 NEW 标记的章节菜单、原生链接与 toOld 按钮入口', '悬浮窗拖动、位置恢复、收起与大小调整', '未完成提示不切课', '隐藏提示不切课', '其他标签页不接管队列', '队列末尾停止并显示结束状态', '无页面脚本异常'], navigationCount: visited.length, testedAt: new Date().toISOString(), scope: '独立 Chromium + 离线模拟学习通页面；GM 接口为模拟，不代表实际整门课程播放验收' };
    fs.writeFileSync(path.join(__dirname, 'verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
