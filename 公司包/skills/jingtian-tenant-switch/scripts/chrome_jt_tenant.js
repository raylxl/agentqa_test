/**
 * 鲸天租户工具（Chrome 9333 · jingtian-tenant-switch 技能自带脚本）
 *
 * 用法：
 *   node chrome_jt_tenant.js list                # 列出全部可切租户（实时接口）
 *   node chrome_jt_tenant.js current             # 查看当前租户
 *   node chrome_jt_tenant.js switch <id|名称>    # 切换租户（支持租户ID或名称，如 switch 43 / switch 智冷仓链）
 *
 * 机制：POST gateway-ll/uas/auth/changeTenant 拿新 token 写回 localStorage → 清菜单缓存 → reload /dashboard
 * 前提：Chrome 9333 已启动且鲸天已登录（jingtian-login 技能）
 * 输出 RESULT：switch-success | already-on-target | list-ok | current-ok | api-failed | not-logged-in ...
 */
const path = require('path');
let chromium;
try { chromium = require('playwright').chromium; }
catch (_) { console.error('找不到 playwright：重跑部署器自动安装，或在部署根执行 npm i playwright'); process.exit(1); }

const GW = 'http://gateway-ll.test.ztoeco.com';
const DASH = 'http://jt-ll.test.ztoeco.com/dashboard';
// 登录人显示名优先 JT_DISPLAY；未提供时只按鲸天页签/环境标识校验
const DISPLAY = process.env.JT_DISPLAY || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HEADERS = t => ({ 'Content-Type': 'application/json', 'Authorization': t, 'authtoken': t, 'PlatformCode': 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' });
const BODY = extra => JSON.stringify({ platformCode: 'ZTOCC_PLATFORM_001', ...extra });

function findJtPage(browser) {
  return browser.contexts()[0].pages().find(p => {
    try { return p.url().includes('jt-ll.test.ztoeco.com'); } catch (_) { return false; }
  });
}

async function readState(page) {
  return page.evaluate((display) => {
    const items = Array.from(document.querySelectorAll('.tenant-item'));
    const selected = items.find(e => e.querySelector('.selected-icon'));
    const active = document.querySelector('.tenant-item.active');
    let menuTopCount = 0;
    try { menuTopCount = JSON.parse(localStorage.getItem('MICRO_APP_MAIN_MENU_LIST') || '[]').length; } catch (_) {}
    return {
      url: location.href,
      tenant: (selected || active) ? ((selected || active).innerText || '').trim() : (items[0] ? items[0].innerText.trim() : null),
      via: selected ? 'selected-icon' : (active ? 'active-tab' : 'first-tab'),
      menuTopCount,
      loggedIn: (document.body.innerText || '').includes('预发环境') && (!display || (document.body.innerText || '').includes(display))
    };
  }, DISPLAY).catch(() => null);
}

(async () => {
  const cmd = (process.argv[2] || '').toLowerCase();
  const arg = process.argv[3];
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const page = await findJtPage(browser);
  if (!page) { console.error('未找到 jt-ll 页签，先跑 jingtian-login 的 chrome_jt_login.js'); console.log('RESULT: no-jt-tab'); process.exit(2); }

  const api = async (fn, arg1) => page.evaluate(async ({ gw, fnSrc, arg1 }) => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const fn = eval('(' + fnSrc + ')');
    return await fn(gw, token, arg1);
  }, { gw: GW, fnSrc: fn.toString(), arg1 }).catch(e => ({ err: e.message }));

  // ---- list / current ----
  if (cmd === 'list' || cmd === 'current' || cmd === 'switch') {
    const tenants = await api(async (gw, token) => {
      const resp = await fetch(gw + '/merak/user/queryOwnershipTenant', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': token, 'authtoken': token, 'PlatformCode': 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify({ platformCode: 'ZTOCC_PLATFORM_001' }) });
      const j = await resp.json().catch(() => ({}));
      return (j.data || []).map(t => ({ tenantId: t.tenantId, tenantCode: t.tenantCode, tenantName: t.tenantName, tenantType: t.tenantType, domain: t.domain, simpleName: t.simpleName }));
    });
    if (!Array.isArray(tenants) || !tenants.length) { console.error('租户列表获取失败:', JSON.stringify(tenants).slice(0, 200)); console.log('RESULT: api-failed'); process.exit(2); }
    if (cmd === 'list') {
      console.table ? console.table(tenants.map(t => ({ id: t.tenantId, code: t.tenantCode, name: t.tenantName, type: t.tenantType, menus: '' }))) : console.log(JSON.stringify(tenants, null, 1));
      console.log('RESULT: list-ok'); await browser.close(); return;
    }
    const st0 = await readState(page);
    if (cmd === 'current') {
      console.log(JSON.stringify(st0, null, 1));
      console.log('RESULT: current-ok'); await browser.close(); return;
    }
    // ---- switch <id|名称> ----
    if (!arg) { console.error('用法: switch <租户ID|租户名称>'); process.exit(2); }
    const target = tenants.find(t => String(t.tenantId) === String(arg)) || tenants.find(t => t.tenantName === arg) || tenants.find(t => t.tenantName.includes(arg));
    if (!target) { console.error('未匹配到租户:', arg, '；可选:', tenants.map(t => `${t.tenantId}:${t.tenantName}`).join(' ')); console.log('RESULT: tenant-not-found'); process.exit(2); }
    console.log('[target]', target.tenantId, target.tenantName);
    if (st0 && st0.tenant === target.tenantName) { console.log('RESULT: already-on-target'); await browser.close(); return; }

    const res = await api(async (gw, token, tenantId) => {
      const resp = await fetch(gw + '/uas/auth/changeTenant', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': token, 'authtoken': token, 'PlatformCode': 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify({ platformCode: 'ZTOCC_PLATFORM_001', tenantId }) });
      const j = await resp.json().catch(() => ({}));
      return { code: j.code, msg: j.msg || j.message || '', token: j.data && j.data.token };
    }, target.tenantId);
    if (String(res.code) !== '200' || !res.token) { console.error('changeTenant 失败:', JSON.stringify(res).slice(0, 200)); console.log('RESULT: api-failed'); process.exit(2); }

    await page.evaluate((token) => {
      localStorage.setItem('MICRO_APP_MAIN_TOKEN_KEY', token);
      localStorage.removeItem('MICRO_APP_MAIN_MENU_LIST');
      localStorage.removeItem('MICRO_APP_MAIN_MICRO_ROUTES');
      location.href = 'http://jt-ll.test.ztoeco.com/dashboard';
    }, res.token);
    await sleep(8000);
    const page2 = (await findJtPage(browser)) || page;
    const st = await readState(page2);
    console.log('[state]', JSON.stringify(st));
    if (st && st.tenant === target.tenantName && st.loggedIn) {
      await page2.screenshot({ path: path.join(__dirname, `tenant_${target.tenantId}_after.png`) }).catch(() => {});
      console.log('RESULT: switch-success');
    } else if (st && /sso\./.test(st.url)) {
      console.log('RESULT: login-lost（重跑 chrome_jt_login.js 后重试）'); process.exit(2);
    } else {
      console.log('RESULT: switch-unverified'); process.exit(2);
    }
    await browser.close();
    return;
  }
  console.error('用法: node chrome_jt_tenant.js list | current | switch <id|名称>');
  process.exit(2);
})().catch(e => { console.error('FATAL', e.message); process.exit(2); });
