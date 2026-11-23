/**
 * 鲸天租户切换（API 版，Chrome 9333）
 *
 * 机制（参考库 switch_via_redirect.js 的业务知识 + 2026-10-27 本机实测）：
 *   POST http://gateway-ll.test.ztoeco.com/uas/auth/changeTenant
 *   headers: Authorization/authtoken = localStorage.MICRO_APP_MAIN_TOKEN_KEY
 *            PlatformCode: ZTOCC_PLATFORM_001, client-Type: pc
 *   body: { platformCode, tenantId }
 *   → code 200 + data.token（新租户 JWT，本版本无 refreshUrl）
 *   → 新 token 写回 MICRO_APP_MAIN_TOKEN_KEY，清租户菜单缓存，reload /dashboard
 *
 * 租户ID：冷链快运=1(ZTOCC) 智冷仓链=43(T00011) 物料商城=46 网络货运=49 …
 * 用法：node chrome_jt_switch_tenant_api.js <tenantId> [租户名] [--port <CDP端口，缺省9333>]
 */
const path = require('path');
let chromium;
try { chromium = require('playwright').chromium; }
catch (_) { console.error('找不到 playwright：重跑部署器自动安装，或在部署根执行 npm i playwright'); process.exit(1); }
if (!chromium) { console.error('找不到 playwright 库'); process.exit(1); }

const TENANT_ID = parseInt(process.argv[2] || '43', 10);
const TENANT_NAME = process.argv[3] || '智冷仓链';
const portIdx = process.argv.indexOf('--port');
const PORT = portIdx > -1 ? process.argv[portIdx + 1] : '9333';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = browser.contexts()[0].pages().find(p => {
    try { return p.url().includes('jt-ll.test.ztoeco.com'); } catch (_) { return false; }
  });
  if (!page) { console.error('未找到 jt-ll 页签'); process.exit(2); }
  console.log('[tab]', page.url());

  // 1) 调 changeTenant
  const res = await page.evaluate(async ({ tenantId }) => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const resp = await fetch('http://gateway-ll.test.ztoeco.com/uas/auth/changeTenant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': token, 'authtoken': token, 'PlatformCode': 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' },
      body: JSON.stringify({ platformCode: 'ZTOCC_PLATFORM_001', tenantId })
    });
    const data = await resp.json().catch(() => ({}));
    return { code: data.code, msg: data.msg || data.message, dataKeys: data.data ? Object.keys(data.data) : [], token: data.data && data.data.token };
  }, { tenantId: TENANT_ID }).catch(e => ({ err: e.message }));
  console.log('[api]', JSON.stringify({ code: res.code, msg: res.msg, dataKeys: res.dataKeys }));
  if (res.err || String(res.code) !== '200' || !res.token) {
    console.error('RESULT: api-failed'); process.exit(2);
  }

  // 2) 解码新 JWT 的 payload 看租户声明
  try {
    const payload = JSON.parse(Buffer.from(res.token.split('.')[1], 'base64').toString('utf8'));
    const tenantInfo = {};
    for (const k of Object.keys(payload)) if (/tenant|org/i.test(k)) tenantInfo[k] = payload[k];
    console.log('[jwt tenant claims]', JSON.stringify(tenantInfo));
  } catch (_) {}

  // 3) 写回 token + 清租户缓存 + reload
  await page.evaluate((token) => {
    localStorage.setItem('MICRO_APP_MAIN_TOKEN_KEY', token);
    localStorage.removeItem('MICRO_APP_MAIN_MENU_LIST');
    localStorage.removeItem('MICRO_APP_MAIN_MICRO_ROUTES');
    location.href = 'http://jt-ll.test.ztoeco.com/dashboard';
  }, res.token);

  // 4) 等 /dashboard 渲染并校验当前租户
  await sleep(6000);
  for (let i = 0; i < 4; i++) {
    const state = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.tenant-item'));
      const selected = items.find(e => e.querySelector('.selected-icon'));
      const active = document.querySelector('.tenant-item.active');
      return {
        url: location.href,
        selected: selected ? (selected.innerText || '').trim() : null,
        active: active ? (active.innerText || '').trim() : null,
        headerTabs: items.slice(0, 4).map(e => (e.innerText || '').trim()),
        user: (document.body.innerText || '').includes('预发环境')
      };
    }).catch(() => null);
    if (state) {
      console.log('[state]', JSON.stringify(state));
      const cur = state.selected || state.active || '';
      if (cur.includes(TENANT_NAME) || state.headerTabs[0] === TENANT_NAME) {
        await page.screenshot({ path: path.join(__dirname, `tenant_${TENANT_ID}_switched.png`) });
        console.log('RESULT: switch-success');
        await browser.close();
        return;
      }
    }
    await sleep(3000);
  }
  await page.screenshot({ path: path.join(__dirname, 'tenant_switch_error.png') });
  console.error('RESULT: switch-unverified');
  process.exit(2);
})().catch(e => { console.error('FATAL', e.message); process.exit(2); });
