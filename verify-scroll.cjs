const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const { chromium } = require(process.env.OCS_PLAYWRIGHT_DIR);
  const browser = await chromium.launch({ executablePath: process.env.OCS_CHROME_PATH, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    await page.setContent('<h1>长课程列表滚动测试</h1>');
    const queue = Array.from({ length: 40 }, (_, i) => ({ id: `${100+i}:201`, name: `测试课程 ${i+1}`, url: `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=${100+i}&clazzid=201`, enabled: true }));
    await page.evaluate(queue => {
      window.testStore = { 'ocs-course-switcher.v1': { queue, running: false, phase: 'idle', log: [] } };
      window.GM_getValue = (k,d) => structuredClone(testStore[k] ?? d);
      window.GM_setValue = (k,v) => { testStore[k] = structuredClone(v); };
      window.GM = { setValue: async(k,v) => { testStore[k] = structuredClone(v); } };
      window.GM_getTab = callback => callback({ ocsCourseSwitcherId: 'scroll-test' });
      window.GM_saveTab = () => {};
    }, queue);
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname,'ocs-course-switcher.user.js'),'utf8') });
    const list = page.locator('.course-list');
    const positions = () => page.evaluate(() => { const root = document.querySelector('[data-ocs-switcher]').shadowRoot; return { list: root.querySelector('.course-list').scrollTop, body: root.querySelector('.body').scrollTop }; });
    await list.evaluate(el => { el.scrollTop = 780; });
    await page.locator('.body').evaluate(el => { el.scrollTop = 80; });
    for (let step = 0; step < 4; step++) {
      const index = await list.evaluate(el => { const r = el.getBoundingClientRect(); return [...el.querySelectorAll('input')].findIndex(x => { const b=x.getBoundingClientRect(); return b.top>r.top+5 && b.bottom<r.bottom-5; }); });
      assert.ok(index >= 0);
      await list.locator('input').nth(index).click();
      const before = await positions();
      assert.ok(before.list > 500);
      await page.waitForTimeout(1700);
      const after = await positions();
      assert.ok(Math.abs(after.list-before.list)<2,`list moved ${JSON.stringify({before,after})}`);
      assert.ok(Math.abs(after.body-before.body)<2,`panel moved ${JSON.stringify({before,after})}`);
    }
    const beforeCollapse = await positions();
    await page.getByRole('button',{name:'收起',exact:true}).click();
    await page.getByRole('button',{name:'展开',exact:true}).click();
    assert.deepEqual(await positions(),beforeCollapse);
    const report = { passed:true,version:'0.2.2',courseCount:40,checks:['连续勾选与取消勾选后列表不回顶','面板外层滚动不回顶','收起展开后保持滚动位置'],testedAt:new Date().toISOString() };
    fs.writeFileSync(path.join(__dirname,'scroll-verification.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
