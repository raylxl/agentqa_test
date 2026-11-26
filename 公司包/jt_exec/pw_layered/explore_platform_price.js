// explore_platform_price.js — 平台价格菜单探索实查（module_config 落配置前置）
// 用法: CHROME_NO_SANDBOX=1 node explore_platform_price.js
// 步骤: 独占实例 → 登录 → 切冷链云仓租户 → 菜单树搜「平台价格」→ 开菜单 → dump 路由/控件/接口
const path = require('path');
const cdp = require(path.join(__dirname, 'cdp_pool.js'));
const { ensureLogin } = require(path.join(__dirname, 'pw_login.js'));
const { ensureTenant } = require(path.join(__dirname, 'pw_tenant.js'));

const NAME_RE = /平台价格/;

(async () => {
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335, 9336, 9337], purpose: '平台价格菜单探索', verbose: true });
  console.log('[pool] port=', c.port);
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${c.port}`);
  let page = null;
  try {
    // 1) 登录（ensureLogin(port)，内部自管理页签）
    const lg = await ensureLogin(c.port, { verbose: true });
    console.log('[login]', String(lg).slice(0, 200));
    // 2) 切冷链云仓租户（ensureTenant(browser, tenantName)）
    const t = await ensureTenant(browser, '智冷仓链', console.log);
    console.log('[tenant]', JSON.stringify(t).slice(0, 300));
    page = (await require(path.join(__dirname, 'pw_tenant.js')).findJtPage(browser)) || (await browser.contexts()[0].newPage());
    // 3) 菜单树找「平台价格」
    //    菜单接口：复用壳层已知菜单树 API（结算先例 queryMenuTree/queryMenus），先监听网络再点
    const menuHits = [];
    page.on('response', async (res) => {
      try {
        const url = res.url();
        if (/menu|Menu|route|permission/i.test(url) && res.status() === 200) {
          const ct = res.headers()['content-type'] || '';
          if (ct.includes('json')) {
            const body = await res.text();
            if (NAME_RE.test(body)) {
              menuHits.push({ url, len: body.length, sample: body.slice(0, 500) });
            }
          }
        }
      } catch (e) {}
    });
    // 4) 打开首页让菜单加载，然后在页面里搜菜单树
    await page.goto('http://jt-ll.test.ztoeco.com/app/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(6000);
    // 菜单树在 localStorage 或全局变量？先搜 DOM 文本
    const found = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('*'));
      const hits = all.filter(el => el.children.length === 0 && /平台价格/.test(el.textContent || ''));
      return hits.slice(0, 5).map(el => ({ tag: el.tagName, text: (el.textContent || '').slice(0, 60), cls: (el.className || '').toString().slice(0, 60) }));
    });
    console.log('[dom] 平台价格文本命中:', JSON.stringify(found));
    // 若未命中，尝试直接搜全部菜单树数据源
    if (!found.length) {
      const ls = await page.evaluate(() => {
        const out = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          const v = localStorage.getItem(k) || '';
          if (/平台价格/.test(v)) out.push({ key: k, len: v.length, sample: v.slice(0, 400) });
        }
        return out;
      });
      console.log('[ls] localStorage 命中:', JSON.stringify(ls).slice(0, 800));
    }
    console.log('[net] 菜单接口命中:', JSON.stringify(menuHits.map(h => ({ url: h.url, len: h.len }))).slice(0, 600));
    // 5) 尝试点击命中菜单
    try {
      const el = page.locator('text=平台价格').first();
      if (await el.count()) {
        await el.click({ timeout: 8000 });
        await page.waitForTimeout(5000);
        console.log('[nav] url=', page.url());
        const title = await page.title();
        console.log('[nav] title=', title);
        // dump 查询区与表格结构概览
        const info = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button')).map(b => (b.innerText || '').trim()).filter(Boolean).slice(0, 20);
          const tables = document.querySelectorAll('.el-table').length;
          const inputs = Array.from(document.querySelectorAll('.el-form .el-col')).slice(0, 30).map(c => (c.innerText || '').split('\n')[0]);
          return { btns, tables, formLabels: inputs, microPage: location.pathname + location.hash };
        });
        console.log('[page]', JSON.stringify(info, null, 1).slice(0, 1500));
      } else { console.log('[nav] 无可点菜单'); }
    } catch (e) { console.log('[nav] 点击失败:', e.message.slice(0, 120)); }
    // 截图留证
    const shot = path.join(__dirname, 'shots', `explore_pp_${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    console.log('[shot]', shot);
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
    try { cdp.removeLock(c.port); } catch (_) {}
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
