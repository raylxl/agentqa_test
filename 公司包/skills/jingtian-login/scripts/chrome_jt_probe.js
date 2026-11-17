/**
 * 鲸天页面结构探测（Chrome 9333 · jingtian-login 技能自带脚本）
 *
 * 作用：连接 Chrome 9333，打开鲸天欢迎页，dump SSO 跳转后的页面结构
 *      （输入框/按钮/切换链接/正文开头），用于登录失败时摸清页面变化。
 * 输出：probe1.png 截图 + 页面结构 JSON；末尾 URL 出现 https:// 即 Chrome 缺防升级参数。
 *
 * 用法：node chrome_jt_probe.js [url]
 */
const path = require('path');

let chromium;
try { chromium = require('playwright').chromium; }
catch (_) { console.error('找不到 playwright：重跑部署器自动安装，或在部署根执行 npm i playwright'); process.exit(1); }

const TARGET = process.argv[2] || 'http://jt-ll.test.ztoeco.com/welcome';
const SHOT = path.join(__dirname, 'probe1.png');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333', { timeout: 10000 });

  // 复用已有页签：优先取空白/新标签页，否则新建
  const ctx = browser.contexts()[0];
  let page = ctx.pages().find(p => p.url() === 'about:blank' || p.url().startsWith('chrome://newtab'));
  if (!page) page = await ctx.newPage();

  console.log('[nav] 打开', TARGET);
  await page.goto(TARGET, { timeout: 30000, waitUntil: 'domcontentloaded' });

  // 等 SSO 重定向链走完
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(2000);
    const u = page.url();
    console.log(`[wait ${(i + 1) * 2}s] URL = ${u.slice(0, 110)}`);
    if (u.includes('sso.') || u.includes('/dashboard') || u.includes('/welcome')) break;
  }

  console.log('\n=== 页面结构 ===');
  console.log('FINAL_URL :', page.url());
  console.log('TITLE     :', await page.title().catch(() => ''));

  const facts = await page.evaluate(() => {
    const vis = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const inputs = [...document.querySelectorAll('input')].filter(vis).map(el => ({
      type: el.type, name: el.name || '', id: el.id || '',
      placeholder: el.placeholder || '', maxlength: el.maxLength > 0 ? el.maxLength : null,
    }));
    const clickables = [...document.querySelectorAll('button, a, [class*="switch"], [class*="btn"]')]
      .filter(vis)
      .map(el => ({ tag: el.tagName.toLowerCase(), cls: (el.className + '').slice(0, 60), text: (el.innerText || el.value || '').trim().slice(0, 30) }))
      .filter(x => x.text)
      .slice(0, 25);
    return { inputs, clickables, bodyHead: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300) };
  });

  console.log('INPUTS    :', JSON.stringify(facts.inputs, null, 1));
  console.log('CLICKABLES:', JSON.stringify(facts.clickables, null, 1));
  console.log('BODY_HEAD :', facts.bodyHead);

  await page.screenshot({ path: SHOT });
  console.log('\n[screenshot]', SHOT);
  await browser.close(); // 仅断开 CDP，不关浏览器
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
