// explore_pp_frames.js — 遍历 frames 找列表接口（微应用 iframe 内的网络也在 page 事件里，但微应用域请求可能未过过滤器——直接抓 frames.url + 在 frame 里点查询）
const path = require('path');
const cdp = require(path.join(__dirname, 'cdp_pool.js'));
const { ensureLogin } = require(path.join(__dirname, 'pw_login.js'));
const { ensureTenant, findJtPage } = require(path.join(__dirname, 'pw_tenant.js'));
(async () => {
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335, 9336, 9337], purpose: '平台价格frames', verbose: true });
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${c.port}`);
  let page = null;
  try {
    await ensureLogin(c.port);
    await ensureTenant(browser, '智冷仓链', () => {});
    page = await findJtPage(browser) || (await browser.contexts()[0].newPage());

    const biz = [];
    page.on('response', async (res) => {
      try {
        const url = res.url();
        if (/\.js$|\.css$|\.png$|\.svg|\.woff|clarity|10\.7\.76|uas\/|merak\/|echo\/|smartOffice|version\.json|blob:/.test(url)) return;
        const reqBody = (res.request().postData() || '').slice(0, 500);
        const body = (await res.text().catch(() => '')).slice(0, 500);
        biz.push({ url: url.slice(0, 160), method: res.request().method(), status: res.status(), req: reqBody, res: body });
      } catch (e) {}
    });

    await page.goto('http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice', { timeout: 30000, waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 15; i++) { await page.waitForTimeout(2000); const ok = await page.evaluate(() => !document.body.innerText.includes('资源加载中')).catch(() => false); if (ok) break; }
    await page.waitForTimeout(2000);
    // frames
    const frames = page.frames().map(f => ({ url: f.url().slice(0, 150), name: f.name() }));
    console.log('[frames]', JSON.stringify(frames, null, 1));
    // 在主 frame 点查询
    // 等表格真正 ready（th>3 且无加载遮罩）再点
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(2000);
      const ok = await page.evaluate(() => document.querySelectorAll('.el-table__header-wrapper th').length > 3 && !document.querySelector('.el-loading-mask')).catch(() => false);
      if (ok) break;
    }
    await page.locator('button:has-text("查询")').first().click({ timeout: 8000 }).catch(e => console.log('[click]', e.message.slice(0, 60)));
    await page.waitForTimeout(3000);
    await page.locator('button:has-text("查询")').first().click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(6000);
    console.log('[biz]('+biz.length+')', JSON.stringify(biz, null, 1).slice(0, 4000));
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
    try { cdp.removeLock(c.port); } catch (_) {}
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
