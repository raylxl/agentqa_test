/**
 * 鲸天机构工具（Chrome 9333 · jingtian-org-switch 技能自带脚本）
 *
 * 用法：
 *   node chrome_jt_org.js list                # 列出当前登录人员可切换的机构（当前租户内，实时接口；机构=人员专属配置，不同账号清单不同）
 *   node chrome_jt_org.js current             # 查看当前机构（authInfo + 左上角头部 DOM 双确认）
 *   node chrome_jt_org.js switch <code|名称>  # 切换机构（UI 拟人法优先：左上角下拉→点机构→确认弹窗；元素失效自动降级 API 法）
 *
 * 机制（2026-10-29 实测）：
 *   UI 法：点 .org-menu .org-dropdown .drop-wrapper → .org-popper 里点 .org-item →
 *          弹「切换机构：确定要切换到【X】吗」→ 点确认 → authInfo 即时更新
 *   API 法：POST gateway-ll/uas/auth/changeOrg/<orgCode>（body {}，响应不含新 token）→ reload 后 authInfo 更新
 *   数据源：POST gateway-ll/uas/user/queryDetailInfo {"containsOrg":true} → data.organizes + currentOrgXxx
 * 前提：Chrome 9333 已启动且鲸天已登录（jingtian-login 技能）；机构随租户变化，先用 jingtian-tenant-switch 切对租户
 * 输出 RESULT：switch-success | already-on-org | list-ok | current-ok | org-not-found | api-failed | no-jt-tab ...
 */
const path = require('path');
let chromium;
try { chromium = require('playwright').chromium; }
catch (_) { console.error('找不到 playwright：重跑部署器自动安装，或在部署根执行 npm i playwright'); process.exit(1); }

const GW = 'http://gateway-ll.test.ztoeco.com';
// 登录人显示名优先 JT_DISPLAY；未提供时只按鲸天页签/环境标识校验
const DISPLAY = process.env.JT_DISPLAY || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function findJtPage(browser) {
  return browser.contexts()[0].pages().find(p => {
    try { return p.url().includes('jt-ll.test.ztoeco.com'); } catch (_) { return false; }
  });
}

async function readState(page) {
  return page.evaluate((display) => {
    const ai = JSON.parse(localStorage.getItem('authInfo') || '{}');
    const headerOrg = document.querySelector('.org-menu .org-dropdown .drop-wrapper, .org-menu .org-dropdown');
    return {
      url: location.href,
      tenantName: ai.tenantName || null,
      org: { id: ai.currentOrgId, name: ai.currentOrgName, code: ai.currentOrgCode, typeCode: ai.orgTypeCode },
      headerOrgText: headerOrg ? headerOrg.textContent.trim().replace(/\s+/g, ' ').slice(0, 30) : null,
      loggedIn: (document.body.innerText || '').includes('预发环境') && (!display || (document.body.innerText || '').includes(display)),
    };
  }, DISPLAY).catch(() => null);
}

/** 实时机构清单：当前登录人员在当前租户内可切换的机构（人员专属）。 */
async function fetchOrgs(page) {
  return page.evaluate(async (gw) => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const resp = await fetch(gw + '/uas/user/queryDetailInfo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': token, 'authtoken': token, 'PlatformCode': 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' },
      body: JSON.stringify({ containsOrg: true }),
    });
    const j = await resp.json().catch(() => ({}));
    const d = j.data || {};
    return {
      code: j.code,
      tenant: { id: d.tenantId, name: d.tenantName },
      current: { id: d.currentOrgId, name: d.currentOrgName, code: d.currentOrgCode },
      organizes: (d.organizes || []).map(o => ({ orgCode: o.orgCode, orgName: o.orgName, orgType: o.orgType, orgTypeCode: o.orgTypeCode, id: o.id, isDefault: o.isDefault })),
    };
  }, GW).catch(e => ({ err: e.message }));
}

/** UI 拟人切换：下拉→机构项→确认弹窗。成功返回 true；元素缺失/点击失败返回 false（调用方降级 API）。 */
async function switchByUi(page, orgName) {
  try {
    await page.locator('.org-menu .org-dropdown .drop-wrapper').first().click({ timeout: 8000 });
    await sleep(1200);
    // 优先精确文本匹配（"总部"是"总部财务中心"的子串，子串匹配会点错机构）
    const exact = page.locator('.org-popper .org-item').filter({ hasText: new RegExp('^\\s*' + orgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$') });
    let item = exact.first();
    if (!(await item.count())) item = page.locator('.org-popper .org-item', { hasText: orgName.slice(0, 12) }).first();
    await item.click({ timeout: 8000 });
    await sleep(1200);
    const dlg = page.locator('.el-dialog__wrapper, .el-message-box').first();
    const hasDialog = await dlg.isVisible({ timeout: 4000 }).catch(() => false);
    if (!hasDialog) return false;
    // 弹窗文案按【机构全名】精确核对，防止同名前缀机构误切
    const dlgText = await dlg.textContent().catch(() => '');
    if (!dlgText.includes('【' + orgName + '】')) { await page.keyboard.press('Escape').catch(() => {}); return false; }
    await page.locator('.el-dialog__wrapper .el-button, .el-message-box__btns .el-button').filter({ hasText: '确认' }).first().click({ timeout: 6000 });
    return true;
  } catch (_) { return false; }
}

/** API 切换：changeOrg/{orgCode}，响应不含新 token，reload 后 authInfo 更新。 */
async function switchByApi(page, orgCode) {
  const res = await page.evaluate(async ({ gw, orgCode }) => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const resp = await fetch(gw + '/uas/auth/changeOrg/' + orgCode, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': token, 'authtoken': token, 'PlatformCode': 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' },
      body: '{}',
    });
    return await resp.json().catch(() => ({}));
  }, { gw: GW, orgCode }).catch(e => ({ err: e.message }));
  if (String(res.code || '') !== '200') { console.error('changeOrg 失败:', JSON.stringify(res).slice(0, 200)); return false; }
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(6000);
  return true;
}

(async () => {
  const cmd = (process.argv[2] || '').toLowerCase();
  const arg = process.argv[3];
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  let page = await findJtPage(browser);
  if (!page) { console.error('未找到 jt-ll 页签，先跑 jingtian-login 的 chrome_jt_login.js'); console.log('RESULT: no-jt-tab'); process.exit(2); }
  if (!['list', 'current', 'switch'].includes(cmd)) { console.error('用法: node chrome_jt_org.js list | current | switch <机构编码|机构名称>'); process.exit(2); }

  const st0 = await readState(page);
  const data = await fetchOrgs(page);
  if (!Array.isArray(data.organizes)) { console.error('机构清单获取失败:', JSON.stringify(data).slice(0, 200)); console.log('RESULT: api-failed'); process.exit(2); }

  if (cmd === 'list') {
    console.log(`[租户] ${data.tenant.name}(id=${data.tenant.id})  [当前机构] ${data.current.name}(${data.current.code})  [可切换] ${data.organizes.length} 个（当前登录人员专属配置）`);
    data.organizes.forEach(o => console.log(`  ${String(o.orgCode).padEnd(8)} ${o.orgName}${o.isDefault === 1 ? '（默认）' : ''}  [${o.orgTypeCode || o.orgType}]`));
    console.log('RESULT: list-ok'); await browser.close(); return;
  }
  if (cmd === 'current') {
    console.log(JSON.stringify(st0, null, 1));
    console.log('RESULT: current-ok'); await browser.close(); return;
  }

  // ---- switch <code|名称> ----
  if (!arg) { console.error('用法: switch <机构编码|机构名称>'); process.exit(2); }
  const target = data.organizes.find(o => String(o.orgCode) === String(arg)) || data.organizes.find(o => o.orgName === arg) || data.organizes.find(o => o.orgName.includes(arg));
  if (!target) { console.error('未匹配到机构:', arg, '；可先用 list 查看清单'); console.log('RESULT: org-not-found'); process.exit(2); }
  console.log('[target]', target.orgCode, target.orgName, `[${target.orgTypeCode || target.orgType}]`);
  if (String(st0.org.code) === String(target.orgCode)) { console.log('RESULT: already-on-org'); await browser.close(); return; }

  let via = 'ui';
  let ok = await switchByUi(page, target.orgName);
  if (ok) {
    // 机构切换会触发页面刷新、authInfo 异步更新：轮询核对最多 15 秒，避免校验过早误报失败
    for (let i = 0; i < 6; i++) {
      page = (await findJtPage(browser)) || page;
      const mid = await readState(page);
      if (mid && String(mid.org.code) === String(target.orgCode)) break;
      await sleep(2500);
    }
  }
  if (!ok) { console.log('[ui-fallback] UI 元素不可用，降级 API 法'); via = 'api'; ok = await switchByApi(page, target.orgCode); }
  if (!ok) { console.log('RESULT: switch-failed'); process.exit(2); }

  page = (await findJtPage(browser)) || page;
  const st = await readState(page);
  const headerOk = st.headerOrgText && st.headerOrgText.includes(target.orgName.slice(0, 6));
  console.log('[state]', JSON.stringify(st));
  if (String(st.org.code) === String(target.orgCode) && headerOk) {
    await page.screenshot({ path: path.join(__dirname, `org_${target.orgCode}_after.png`) }).catch(() => {});
    console.log(`[via] ${via}`);
    console.log('RESULT: switch-success');
  } else {
    console.log('RESULT: switch-unverified（核对 authInfo 与左上角展示）'); process.exit(2);
  }
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(2); });
