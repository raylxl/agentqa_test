// explore_pp_dump.js — 深度 dump 平台价格页面（等满加载+列表接口+列名）
const path = require('path');
const cdp = require(path.join(__dirname, 'cdp_pool.js'));
const { ensureLogin } = require(path.join(__dirname, 'pw_login.js'));
const { ensureTenant, findJtPage } = require(path.join(__dirname, 'pw_tenant.js'));
(async () => {
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335, 9336, 9337], purpose: '平台价格深度dump', verbose: true });
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${c.port}`);
  let page = null;
  try {
    const lg = await ensureLogin(c.port);
    const t = await ensureTenant(browser, '智冷仓链', console.log);
    page = await findJtPage(browser) || (await browser.contexts()[0].newPage());

    const apiHits = [];
    page.on('response', async (res) => {
      try {
        const url = res.url();
        if (/uas\/|merak\/|echo\/|\.js|\.css|\.png|\.svg|\.woff/.test(url)) return;
        const reqBody = res.request().postData() || '';
        const body = await res.text().catch(() => '');
        if (!body) return;
        apiHits.push({ url: url.replace('http://gateway-ll.test.ztoeco.com', 'GW').replace('http://jt-ll.test.ztoeco.com', 'JT'), method: res.request().method(), status: res.status(), req: reqBody.slice(0, 300), len: body.length, sample: body.slice(0, 300) });
      } catch (e) {}
    });

    await page.goto('http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice', { timeout: 30000, waitUntil: 'domcontentloaded' });
    // 等列表真实渲染（.el-table 出现且「资源加载中」消失）
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(2000);
      const ok = await page.evaluate(() => {
        const t = document.body.innerText || '';
        return !t.includes('资源加载中') && document.querySelectorAll('.el-table__header-wrapper th').length > 3;
      }).catch(() => false);
      if (ok) break;
    }
    // 主动点一次「查询」触发列表接口
    await page.locator('button:has-text("查询")').first().click({ timeout: 8000 }).catch(e => console.log('[query click]', e.message.slice(0, 80)));
    await page.waitForTimeout(5000);

    const info = await page.evaluate(() => {
      const ths = Array.from(document.querySelectorAll('.el-table__header-wrapper th')).map(th => (th.innerText || '').trim()).filter(Boolean);
      const rows = document.querySelectorAll('.el-table__body-wrapper tr').length;
      const formItems = Array.from(document.querySelectorAll('.el-form-item')).map(f => {
        const label = (f.querySelector('.el-form-item__label') || {}).innerText || '';
        const ctrl = f.querySelector('input, .el-select, .el-date-editor, .el-cascader') ? (f.querySelector('input') ? 'input' : (f.querySelector('.el-select') ? 'select' : (f.querySelector('.el-date-editor') ? 'date' : 'other'))) : 'none';
        const placeholder = ((f.querySelector('input') || {}).placeholder || '').slice(0, 30);
        return { label: label.trim(), ctrl, placeholder };
      }).filter(x => x.label);
      const pager = (document.querySelector('.el-pagination') || {}).innerText || '';
      const total = (document.body.innerText.match(/共\s*(\d+)\s*条/) || [])[1] || '';
      return { ths, rows, formItems, pager: pager.slice(0, 80), total };
    });
    console.log('[dump]', JSON.stringify(info, null, 1).slice(0, 3000));
    console.log('\n[api]', JSON.stringify(apiHits.slice(0, 15), null, 1).slice(0, 3000));
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
    try { cdp.removeLock(c.port); } catch (_) {}
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
