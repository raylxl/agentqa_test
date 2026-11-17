/**
 * 鲸天菜单打开器 v2（Chrome 9333 · 抽屉流程，2026-10-27 实测）
 *
 * 交互模型（实测）：
 *   侧边栏一级栏目是 LI.el-menu-item → 点击弹出左侧抽屉 .el-drawer.menu-drawer_tree
 *   抽屉内是 el-tree（该栏目完整菜单树）+ 顶部搜索框"请输入菜单名称"
 *   点叶子树节点 → 内容区新开页签（el-tabs）加载微应用页面
 *   ⚠️ 直跳 URL（location.href=uri）会让微应用资源 404 卡"资源加载中"，禁用
 *
 * 用法：node chrome_jt_open_menu.js <一级栏目> <菜单名> [--tenant <租户ID|名称>] [--port <CDP端口，缺省9333>]
 * v3（2026-11-09 鲸天菜单改版适配）：侧栏默认停「常用菜单」页签时无栏目→先切「全部菜单」；栏目树改为自研 .tree-node-label（非 el-tree）→新增新版树路径；
 *   业务 frame URL 含菜单 uri 末段亦判打开成功；--port 参数化（注意：--tenant 调用的切租户脚本仍硬编码 9333，非 9333 端口勿带 --tenant）
 *   例：node chrome_jt_open_menu.js <一级栏目> <菜单名>
 * 输出：RESULT: menu-opened | already-open | menu-not-found | column-click-failed | open-unverified
 */
const path = require('path');
let chromium;
try { chromium = require('playwright').chromium; }
catch (_) { console.error('找不到 playwright：重跑部署器自动安装，或在部署根执行 npm i playwright'); process.exit(1); }
if (!chromium) { console.error('找不到 playwright 库'); process.exit(1); }

const ALIAS = { '冷链云仓': 43, '云仓': 43, '智冷仓链': 43, '冷链快运': 1, '快运': 1, '总部': 1, '财务中台': 78, '项目管理': 81, '网络货运': 49, '冷链智运': 77, '物料商城': 46, '客户服务平台': 48 };
const ID2NAME = { 1: '冷链快运', 43: '智冷仓链', 46: '物料商城', 48: '客户服务平台', 49: '网络货运', 77: '冷链智运', 78: '财务中台', 81: '项目管理' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const args = process.argv.slice(2);
const flagIdx = args.indexOf('--tenant');
const COLUMN = args[0];
const MENU = args[1];
const TENANT_ARG = flagIdx > -1 ? args[flagIdx + 1] : null;
const portIdx = args.indexOf('--port');
const PORT = portIdx > -1 ? args[portIdx + 1] : '9333';
if (!COLUMN || !MENU) { console.error('用法: node chrome_jt_open_menu.js <一级栏目> <菜单名> [--tenant <租户ID|名称>]'); process.exit(2); }

function findJtPage(browser) {
  return browser.contexts()[0].pages().find(p => {
    try { return p.url().includes('jt-ll.test.ztoeco.com'); } catch (_) { return false; }
  });
}
async function currentTenant(page) {
  return page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.tenant-item'));
    const sel = items.find(e => e.querySelector('.selected-icon'));
    const act = document.querySelector('.tenant-item.active');
    return (sel || act) ? (sel || act).innerText.trim() : (items[0] ? items[0].innerText.trim() : null);
  }).catch(() => null);
}

(async () => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  let page = await findJtPage(browser);
  if (!page) { console.error('未找到 jt-ll 页签，先跑 jingtian-login'); console.log('RESULT: no-jt-tab'); process.exit(2); }

  // 1) 租户校验/切换（别名：冷链云仓/云仓=智冷仓链）
  if (TENANT_ARG) {
    const wantId = ALIAS[TENANT_ARG] || parseInt(TENANT_ARG, 10);
    const realName = ID2NAME[wantId];
    if (!realName) { console.error('未知租户:', TENANT_ARG); process.exit(2); }
    const cur = await currentTenant(page);
    if (cur !== realName) {
      console.log(`[tenant] ${cur} → ${realName}，调租户切换脚本`);
      const { execSync } = require('child_process');
      try {
        execSync(`node "${path.join(require('os').homedir(), '.zcode', 'skills', 'jingtian-tenant-switch', 'scripts', 'chrome_jt_tenant.js')}" switch ${wantId}`, { stdio: 'inherit', timeout: 90000 });
      } catch (_) { console.log('RESULT: tenant-switch-failed'); process.exit(2); }
      page = (await findJtPage(browser)) || page;
      await sleep(2000);
    }
  }
  const tenantNow = await currentTenant(page);
  console.log('[tenant]', tenantNow);

  // 2) 已开页签查重：内容区 el-tabs 已有同名页签 → 直接激活
  const tabs = await page.evaluate(() => Array.from(document.querySelectorAll('.el-tabs__item')).filter(e => e.getBoundingClientRect().width > 0).map(e => (e.textContent || '').trim())).catch(() => []);
  if (tabs.includes(MENU)) {
    await page.locator('.el-tabs__item', { hasText: MENU }).first().click().catch(() => {});
    await sleep(2500);
    console.log('[tabs]', JSON.stringify(tabs));
    console.log('RESULT: already-open');
    await browser.close(); return;
  }

  // 3) 树内解析（限定一级栏目子树，确认菜单归属+面包屑+重名情况）
  const resolved = await page.evaluate(({ column, menu }) => {
    const arr = JSON.parse(localStorage.getItem('MICRO_APP_MAIN_MENU_LIST') || '[]');
    const findCol = (nodes) => { for (const n of nodes) { if ((n.categoryName || '') === column) return n; const r = findCol(n.childPlatformCategoryList || []); if (r) return r; } return null; };
    const col = findCol(arr);
    if (!col) return { err: 'column-not-found' };
    const hits = [];
    const walk = (node, trail) => {
      for (const m of (node.chilePlatformMenuList || [])) {
        const nm = m.menuName || m.displayName || '';
        if (nm === menu || nm.includes(menu) || menu.includes(nm)) hits.push({ name: nm, uri: m.uri, trail: [...trail, node.categoryName].filter(Boolean) });
      }
      for (const c of (node.childPlatformCategoryList || [])) walk(c, [...trail, node.categoryName].filter(Boolean));
    };
    walk(col, []);
    hits.sort((a, b) => (a.name === menu ? 0 : 1) - (b.name === menu ? 0 : 1));
    return { hits: hits.slice(0, 6) };
  }, { column: COLUMN, menu: MENU }).catch(e => ({ err: e.message }));
  if (!resolved || resolved.err || !resolved.hits || !resolved.hits.length) {
    console.error('菜单未找到（在栏目' + COLUMN + '子树内）:', JSON.stringify(resolved).slice(0, 200));
    console.log('RESULT: menu-not-found'); process.exit(2);
  }
  let target = resolved.hits[0];
  // 用户口径（2026-10-27）：快运租户下指令不带"新"，一律开新版（（新）/-新 变体优先）
  const tenantId = Object.keys(ID2NAME).find(k => ID2NAME[k] === tenantNow);
  if (String(tenantId) === '1' && !/新/.test(MENU) && !/新/.test(target.name)) {
    const newVariant = resolved.hits.find(h => h.name === target.name + '（新）' || h.name === target.name + '-新' || h.name === target.name + '新');
    if (newVariant) { target = newVariant; console.log('[新版优先]', resolved.hits[0].name, '→', target.name); }
  }
  console.log('[resolved]', target.name, '→', target.trail.join(' > '), 'uri=' + target.uri, resolved.hits.length > 1 ? `(重名${resolved.hits.length}个，取第1)` : '');

  // 4) 若不在 dashboard，先回（菜单交互从 dashboard 稳态出发）
  if (!page.url().includes('/dashboard')) {
    await page.evaluate(() => { location.href = 'http://jt-ll.test.ztoeco.com/dashboard'; });
    await sleep(7000);
    page = (await findJtPage(browser)) || page;
  }

  // 5) 点侧栏一级栏目 → 等抽屉
  // v3：侧栏默认停「常用菜单」页签时无栏目 → 先切「全部菜单」
  if (!(await page.locator('.el-menu-item', { hasText: COLUMN }).count())) {
    const allTab = page.locator('.sidebar-tabs .tab-item', { hasText: '全部菜单' }).first();
    if (await allTab.count()) { await allTab.click({ timeout: 5000 }).catch(() => {}); await sleep(1000); console.log('[sidebar] 切到「全部菜单」页签'); }
  }
  const colItem = page.locator('.el-menu-item', { hasText: COLUMN }).first();
  if (!(await colItem.count())) { console.error('侧栏未见栏目:', COLUMN); console.log('RESULT: column-click-failed'); process.exit(2); }
  await colItem.click({ timeout: 6000 });
  let drawerOk = false;
  for (let i = 0; i < 5; i++) {
    await sleep(700);
    drawerOk = await page.evaluate(() => !!document.querySelector('.el-drawer.open') || [...document.querySelectorAll('.tree-node-label')].some(e => e.getBoundingClientRect().width > 0));
    if (drawerOk) break;
  }
  if (!drawerOk) { console.error('抽屉未弹出'); console.log('RESULT: column-click-failed'); process.exit(2); }
  await sleep(800);

  // 6) 打开菜单：主路径=抽屉搜索（el-select 联想）输入菜单名→点联想项；兜底=逐级展开树点叶子
  let clicked = false;
  const selInput = page.locator('.el-drawer.open .el-select input, .el-drawer.open input.el-select__input').first();
  if (await selInput.count()) {
    try {
      await selInput.click({ timeout: 4000 });
      await selInput.fill(target.name, { timeout: 4000 });
      await sleep(1200);
      const opt = page.locator(`.el-select-dropdown__item:visible:text-is("${target.name}")`).first()
        .or(page.locator('.el-select-dropdown__item:visible').filter({ hasText: new RegExp('^\\s*' + target.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$') }).first());
      if (await opt.count()) {
        await opt.click({ timeout: 5000 });
        clicked = true;
        console.log('[open] via 搜索联想');
      } else {
        await page.keyboard.press('Escape').catch(() => {});
      }
    } catch (_) { await page.keyboard.press('Escape').catch(() => {}); }
  }
  if (!clicked && await page.locator('.tree-node-label:visible').count()) {
    // v3：新版栏目树（自研 .tree-node-label）——下一级已可见就不点本级（防收起），再点叶子
    const exactRe = t => new RegExp('^\\s*' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$');
    const label = t => page.locator('.tree-node-label:visible').filter({ hasText: exactRe(t) }).first();
    const chain = [...target.trail.slice(1), target.name];
    for (let k = 0; k < chain.length - 1; k++) {
      if (await label(chain[k + 1]).count()) continue;
      if (await label(chain[k]).count()) { await label(chain[k]).click({ timeout: 4000 }).catch(() => {}); await sleep(800); }
    }
    if (await label(target.name).count()) {
      await label(target.name).click({ timeout: 5000 }).then(() => { clicked = true; console.log('[open] via 新版栏目树'); }).catch(e => console.error('新版树叶子点击失败:', e.message.slice(0, 100)));
    }
  }
  if (!clicked) {
    // 兜底：按面包屑逐级展开树分组，再点可见叶子
    for (const g of target.trail.slice(1)) {
      const gNode = page.locator('.el-drawer.open .el-tree-node', { hasText: g }).first();
      const exp = gNode.locator('.el-tree-node__expand-icon').first();
      if (await exp.count()) {
        const expanded = await gNode.evaluate(n => n.classList.contains('is-expanded')).catch(() => false);
        if (!expanded) { await exp.click({ timeout: 3000 }).catch(() => {}); await sleep(600); }
      }
    }
    await sleep(800);
    const leaf = page.locator(`.el-drawer.open .el-tree-node__content:visible:text-is("${target.name}")`).first()
      .or(page.locator('.el-drawer.open .el-tree-node__content:visible').filter({ hasText: new RegExp('^\\s*' + target.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$') }).first());
    if (await leaf.count()) {
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(300);
      try { await leaf.click({ timeout: 5000 }); clicked = true; console.log('[open] via 树展开'); }
      catch (_) { await leaf.click({ timeout: 3000, force: true }).catch(e => console.error('叶子点击失败:', e.message.slice(0, 100))); }
    }
  }
  if (!clicked) { console.log('RESULT: menu-not-found-in-drawer'); process.exit(2); }

  // 7) 等待内容区加载并校验（新页签 或 内容文本出现）
  let opened = false;
  const HINT = (target.uri || '').split('/').pop(); // v3：业务 frame URL 含 uri 末段亦判打开
  for (let i = 0; i < 8; i++) {
    await sleep(1500);
    const st = await page.evaluate((nm) => {
      const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0; };
      const tabs = Array.from(document.querySelectorAll('.el-tabs__item')).filter(vis).map(e => (e.textContent || '').trim());
      const main = document.querySelector('.el-main') || document.querySelector('[class*=micro-app],[class*=main-container]');
      const drawerOpen = !!document.querySelector('.el-drawer.open');
      return { url: location.href, tabs, mainLen: main ? main.innerText.length : 0 };
    }, MENU).catch(() => null);
    const frameOk = !!HINT && page.frames().some(f => f.url().includes(HINT));
    if (st && (st.tabs.includes(target.name) || frameOk || (st.tabs.length > 1 && st.mainLen > 50))) { opened = true; console.log('[tabs]', JSON.stringify(st.tabs), frameOk ? '[业务frame✓]' : ''); break; }
  }
  await page.screenshot({ path: path.join(__dirname, `menu_open_${Date.now()}.png`) }).catch(() => {});
  if (opened) {
    console.log('[url]', page.url());
    console.log('RESULT: menu-opened');
  } else {
    console.log('[url]', page.url());
    console.log('RESULT: open-unverified');
    process.exit(2);
  }
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(2); });
