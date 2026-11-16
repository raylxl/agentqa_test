/**
 * 项目管理中心页面探测（Chrome 9333 · pm-center-login 技能自带脚本）
 * 作用：连到 project-manage 页签，dump 可见输入框/按钮/链接/表格结构；登录页和系统内页面通用。
 * 用法：node pm_center_probe.js
 */
const path = require('path');

let chromium;
for (const p of [
  'playwright',
  path.join('d:', 'WorkBuddy-projects', 'testcase', 'node_modules', 'playwright'),
]) {
  try { chromium = require(p).chromium; if (chromium) break; } catch (_) {}
}
if (!chromium) { console.error('找不到 playwright 库'); process.exit(1); }

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333', { timeout: 10000 });
  const tab = browser.contexts()[0].pages().find(p => /project-manage|sso\.zt-express/.test(p.url()));
  if (!tab) { console.error('未找到 project-manage 页签（先跑 pm_center_login.js）'); process.exit(1); }
  await tab.bringToFront().catch(() => {});
  await new Promise(r => setTimeout(r, 1500));

  console.log('[URL]', tab.url());
  console.log('[TITLE]', await tab.title().catch(() => ''));
  const facts = await tab.evaluate(() => {
    const vis = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const uniq = arr => [...new Set(arr)];
    return {
      inputs: [...document.querySelectorAll('input')].filter(vis).map(el => ({ type: el.type, ph: el.placeholder || '', val: (el.value || '').slice(0, 15) })).slice(0, 20),
      selects: uniq([...document.querySelectorAll('.el-select, [class*=select]')].filter(vis).map(e => (e.textContent || '').trim().slice(0, 25))).slice(0, 15),
      buttons: uniq([...document.querySelectorAll('button')].filter(vis).map(b => (b.innerText || '').trim()).filter(Boolean)).slice(0, 25),
      links: uniq([...document.querySelectorAll('a, [class*=menu] li, [class*=nav] li')].filter(vis).map(e => (e.textContent || '').trim().split('\n')[0]).filter(Boolean)).slice(0, 40),
      tables: [...document.querySelectorAll('.el-table')].length,
      body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300),
    };
  });
  console.log(JSON.stringify(facts, null, 1));
  await tab.screenshot({ path: path.join(__dirname, 'probe.png') });
  console.log('[screenshot]', path.join(__dirname, 'probe.png'));
  await browser.close();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
