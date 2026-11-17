/**
 * 鲸天租户保障（分层执行模式 preflight 组件 · 端口参数化）
 * 机制照抄 jingtian-tenant-switch 技能 chrome_jt_tenant.js（2026-10-27 实测，API 法，下拉 UI 点击法已弃用）：
 *   读当前租户 = dashboard 页 .tenant-item 选中态；
 *   切换 = POST gateway-ll/uas/auth/changeTenant → 新 token 写回 localStorage → 清菜单缓存 → reload
 *
 * CLI：  node pw_tenant.js --port 9335 current | switch 43 | switch 智冷仓链
 * 模块： ensureTenant(browser, tenantName, log) → { mode: 'already' | 'switched', tenant }
 */
const GW = 'http://gateway-ll.test.ztoeco.com';
const DASH = 'http://jt-ll.test.ztoeco.com/dashboard';
const DISPLAY = process.env.JT_DISPLAY || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function findJtPage(browser) {
  return browser.contexts()[0].pages().find(p => {
    try { return p.url().includes('jt-ll.test.ztoeco.com'); } catch (_) { return false; }
  });
}

async function readState(page) {
  return page.evaluate(display => {
    const items = Array.from(document.querySelectorAll('.tenant-item'));
    const selected = items.find(e => e.querySelector('.selected-icon'));
    const active = document.querySelector('.tenant-item.active');
    return {
      url: location.href,
      tenant: (selected || active) ? ((selected || active).innerText || '').trim() : (items[0] ? items[0].innerText.trim() : null),
      via: selected ? 'selected-icon' : (active ? 'active-tab' : 'first-tab'),
      loggedIn: (document.body.innerText || '').includes('预发环境') && (!display || (document.body.innerText || '').includes(display)),
    };
  }, DISPLAY).catch(() => null);
}

async function api(page, fnSrc, arg1) {
  return page.evaluate(async ({ gw, fnSrc, arg1 }) => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const fn = eval('(' + fnSrc + ')');
    return await fn(gw, token, arg1);
  }, { gw: GW, fnSrc, arg1 }).catch(e => ({ err: e.message }));
}

const LIST_FN = async (gw, token) => {
  const resp = await fetch(gw + '/merak/user/queryOwnershipTenant', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify({ platformCode: 'ZTOCC_PLATFORM_001' }) });
  const j = await resp.json().catch(() => ({}));
  return (j.data || []).map(t => ({ tenantId: t.tenantId, tenantCode: t.tenantCode, tenantName: t.tenantName }));
};

const SWITCH_FN = async (gw, token, tenantId) => {
  const resp = await fetch(gw + '/uas/auth/changeTenant', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify({ platformCode: 'ZTOCC_PLATFORM_001', tenantId }) });
  const j = await resp.json().catch(() => ({}));
  return { code: j.code, msg: j.msg || j.message || '', token: j.data && j.data.token };
};

async function ensureTenant(browser, tenantName, log = () => {}) {
  let page = await findJtPage(browser);
  if (!page) {
    page = await browser.contexts()[0].newPage();
    await page.goto(DASH, { timeout: 30000, waitUntil: 'domcontentloaded' });
    await sleep(4000);
  }
  if (!/dashboard|welcome/.test(page.url())) {
    await page.goto(DASH, { timeout: 30000, waitUntil: 'domcontentloaded' });
    await sleep(4000);
  }
  const st0 = await readState(page);
  if (st0 && st0.tenant === tenantName) { log(`租户已就位 ${tenantName}（${st0.via}）`); return { mode: 'already', tenant: tenantName }; }

  const tenants = await api(page, LIST_FN.toString());
  if (!Array.isArray(tenants) || !tenants.length) throw new Error('租户列表获取失败: ' + JSON.stringify(tenants).slice(0, 150));
  const target = tenants.find(t => t.tenantName === tenantName) || tenants.find(t => t.tenantName.includes(tenantName));
  if (!target) throw new Error('未匹配到租户: ' + tenantName + '；可选: ' + tenants.map(t => t.tenantId + ':' + t.tenantName).join(' '));
  if (st0 && st0.tenant === target.tenantName) return { mode: 'already', tenant: target.tenantName };

  log(`切租户 ${st0 && st0.tenant} → ${target.tenantName}(${target.tenantId})`);
  const res = await api(page, SWITCH_FN.toString(), target.tenantId);
  if (String(res.code) !== '200' || !res.token) throw new Error('changeTenant 失败: ' + JSON.stringify(res).slice(0, 150));
  await page.evaluate(token => {
    localStorage.setItem('MICRO_APP_MAIN_TOKEN_KEY', token);
    localStorage.removeItem('MICRO_APP_MAIN_MENU_LIST');
    localStorage.removeItem('MICRO_APP_MAIN_MICRO_ROUTES');
    location.href = 'http://jt-ll.test.ztoeco.com/dashboard';
  }, res.token);
  await sleep(8000);
  const page2 = (await findJtPage(browser)) || page;
  const st = await readState(page2);
  if (st && st.tenant === target.tenantName && st.loggedIn) return { mode: 'switched', tenant: target.tenantName };
  if (st && /sso\./.test(st.url)) throw new Error('切租户途中登录态丢失（login-lost）');
  throw new Error('切换后核验未通过: ' + JSON.stringify(st));
}

module.exports = { ensureTenant, readState, findJtPage, LIST_FN, SWITCH_FN };

if (require.main === module) {
  const path = require('path');
  const { chromium } = require('playwright');
  const i = process.argv.indexOf('--port');
  const port = i >= 0 ? parseInt(process.argv[i + 1], 10) : 9333;
  const args = process.argv.slice(2);
  let cmd = '', argTenant = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') { i++; continue; }
    if (!cmd) cmd = args[i]; else if (!argTenant) argTenant = args[i];
  }
  cmd = (cmd || '').toLowerCase();
  (async () => {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 10000 });
    if (cmd === 'current') {
      const page = await findJtPage(browser);
      if (!page) { console.log('RESULT: no-jt-tab'); process.exit(2); }
      console.log(JSON.stringify(await readState(page), null, 1));
      console.log('RESULT: current-ok');
    } else if (cmd === 'switch') {
      const r = await ensureTenant(browser, argTenant, (...a) => console.log('[tenant]', ...a));
      console.log('RESULT: switch-ok', JSON.stringify(r));
    } else {
      console.error('用法: node pw_tenant.js --port <p> current | switch <id|名称>');
      process.exit(2);
    }
    await browser.close();
  })().catch(e => { console.error('ERR:', e.message); process.exit(1); });
}
