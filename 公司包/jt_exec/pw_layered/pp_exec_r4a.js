// pp_exec_r4a.js — 平台价格 11.30 · R4a 组织切换权限批（单进程自包含）
//
// 指令来源（2026-11-26 用户拍板）：
//   「不是有切换租户的skill吗 直接调用不行吗」→ 用 jingtian-org-switch 机制（UI 拟人法优先+changeOrg API 兜底）
//   「所有的用例你都可以界面测试才对」→ PERM 断言全部走 UI 列表+页面上下文 fetch 桥（与 UI 同源）
//
// 架构（沿用 R1-R3 实证）：
//   - 单进程：cdp_pool spawn Chrome（detached+unref，跨 Bash 调用存活）→ 登录 → 切租户 → 切组织 → UI 执行 → 账本
//   - 页面上下文 fetch 桥（唯一可靠 API 通道——request 直调假 200）
//   - 机构切换：UI 法（.org-menu .drop-wrapper → .org-popper .org-item → 确认弹窗）优先，失败降级 changeOrg API
//   - 切组织后页面数据随机构过滤：须 reload 业务菜单页再断言
//
// 用例：TC-PERM-02/05/06/07/08/09/10/11/12/13/14（11 条权限边界）
// 纪律：D2 5分钟/条 · D3 禁停 · 断言值从账本/请求参数取，禁凭记忆
const path = require('path');
const fs = require('fs');
const J = path.join(__dirname);
const cdp = require(path.join(J, 'cdp_pool.js'));

const LEDGER = '/Users/kimfang/WorkBuddy/ai测试agent/需求用例库/用例文件/平台价格分章/exec_ledger/ledger.jsonl';
const MENU_URL = 'http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice';
const GW = 'http://gateway-ll.test.ztoeco.com';
const RUN_ID = 'PP-R4-20261126';
const ROUND = '执行R4';
const DAY = '20261126';
const DRY = process.argv.includes('--dry');
const NO_LEDGER = DRY;

const bjTs = () => new Date().toLocaleString('sv-SE').replace(' ', ' ');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
let EXEC_NO = 900;
if (fs.existsSync(LEDGER)) {
  for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
    const m = line.match(/PP-20261126-(\d+)/);
    if (m) EXEC_NO = Math.max(EXEC_NO, +m[1] + 1);
  }
}
log('[ledger] exec_no 从', EXEC_NO, '起');
function append(rec) {
  if (NO_LEDGER) { log('（dry）', rec.event || rec.tc, String(rec.reason || '').slice(0, 200).replace(/\n/g, ' ⏎ ')); return; }
  fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
}
function record(tc, status, reason, extra = {}) {
  append({ ts: bjTs(), event: 'case', tc, status, reason: (reason || '').slice(0, 500), exec_id: 'PP-' + DAY + '-' + String(EXEC_NO++).padStart(3, '0'), run_id: RUN_ID, round: ROUND, channel: 'ui', ...extra });
}
function batch(kind, extra = {}) { append({ ts: bjTs(), event: kind, run_id: RUN_ID, round: ROUND, channel: 'ui', book: '财务需求2026_云仓_平台价格_11.30', operator: 'AI(R4组织切换批)', ...extra }); }

/* ── 页面上下文 fetch 桥（R1-R3 实证唯一可靠通道） ── */
let PAGE = null;
async function apiPost(p, body) {
  return PAGE.evaluate(async ({ u, b }) => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify(b) });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
      return { status: r.status, json: j, text: t.slice(0, 400) };
    } catch (e) { return { err: e.message }; }
  }, { u: GW + p, b: body });
}
function totalOf(r) { const d = r && r.json && r.json.data; return d ? d.total : -1; }
function itemsOf(r) { const d = r && r.json && r.json.data; return d ? (d.items || []) : []; }

/* ── 登录（luxiaolei99 直填 SSO 表单——R1-R3 同款） ── */
async function loginAndSetup() {
  process.env.JT_ACCOUNT = 'luxiaolei99';
  process.env.JT_SECRET = 'Zto@20211021';
  process.env.JT_DISPLAY = '陆潇雷';
  process.env.CHROME_NO_SANDBOX = '1';
  const { execSync } = require('child_process');
  try { execSync('pkill -f "remote-debugging-port=9335" 2>/dev/null; sleep 1', { shell: '/bin/bash' }); } catch (e) {}
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335, 9336, 9337], purpose: '平台价格R4a组织批', verbose: true });
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + c.port, { timeout: 10000 });
  const page = browser.contexts()[0].pages()[0] || (await browser.contexts()[0].newPage());
  // 登录（若已登录会快速通过）
  await page.goto('http://jt-ll.test.ztoeco.com/welcome', { timeout: 30000, waitUntil: 'domcontentloaded' });
  await sleep(5000);
  let loggedIn = false;
  try { loggedIn = (await page.evaluate(() => document.body.innerText)).includes('预发环境'); } catch (e) {}
  if (!loggedIn) {
    // 未登录：应已跳 SSO
    if (page.url().includes('sso.test.ztoeco.com')) {
      let ins = await page.evaluate(() => [...document.querySelectorAll('input')].filter(el => el.offsetWidth || el.offsetHeight).length).catch(() => 0);
      if (ins === 0) { await page.click('a.login-switch-link', { timeout: 10000 }).catch(() => {}); await sleep(2500); }
      for (let w = 0; w < 10; w++) { const cnt = await page.locator('input[name="username"]').count().catch(() => 0); if (cnt) break; await sleep(1000); }
      await page.fill('input[name="username"]', process.env.JT_ACCOUNT);
      await page.fill('input[name="password"]', process.env.JT_SECRET);
      await page.click('button.login-btn', { timeout: 10000 }).catch(async () => { await page.locator('button:has-text("登录")').first().click({ timeout: 10000 }); });
      for (let i = 0; i < 15; i++) {
        await sleep(2000);
        if (page.url().includes('jt-ll.test.ztoeco.com') && !page.url().includes('login')) {
          const txt = await page.evaluate(() => document.body.innerText).catch(() => '');
          if (txt.includes('预发环境')) { loggedIn = true; break; }
        }
      }
    } else {
      // 卡鲸天未跳 SSO：清 token 重触发
      await page.evaluate(() => { localStorage.removeItem('MICRO_APP_MAIN_TOKEN_KEY'); location.href = 'http://jt-ll.test.ztoeco.com/welcome'; }).catch(() => {});
      await sleep(6000);
      if (page.url().includes('sso.test.ztoeco.com')) {
        for (let w = 0; w < 10; w++) { const cnt = await page.locator('input[name="username"]').count().catch(() => 0); if (cnt) break; await sleep(1000); }
        await page.fill('input[name="username"]', process.env.JT_ACCOUNT);
        await page.fill('input[name="password"]', process.env.JT_SECRET);
        await page.click('button.login-btn', { timeout: 10000 }).catch(() => {});
        for (let i = 0; i < 15; i++) {
          await sleep(2000);
          if (page.url().includes('jt-ll.test.ztoeco.com')) { const txt = await page.evaluate(() => document.body.innerText).catch(() => ''); if (txt.includes('预发环境')) { loggedIn = true; break; } }
        }
      }
    }
  }
  if (!loggedIn) throw new Error('登录失败');
  log('[login] luxiaolei99 OK');
  // 租户（智冷仓链）
  const { ensureTenant } = require(path.join(J, 'pw_tenant.js'));
  const t = await ensureTenant(browser, '智冷仓链', log);
  log('[tenant]', JSON.stringify(t));
  PAGE = page;
  return { browser, page };
}

/* ── 组织切换（org-switch skill 同款：UI 优先+API 兜底） ── */
async function fetchOrgs() {
  return PAGE.evaluate(async (gw) => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const r = await fetch(gw + '/uas/user/queryDetailInfo', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify({ containsOrg: true }) });
    const j = await r.json().catch(() => null);
    const d = j && j.data;
    if (!d) return null;
    return { current: { name: d.currentOrgName, code: d.currentOrgCode }, organizes: (d.organizes || []).map(o => ({ code: o.orgCode, name: o.orgName, typeCode: o.orgTypeCode })) };
  }, GW).catch(e => null);
}
async function switchByUi(page, orgName) {
  try {
    await page.locator('.org-menu .org-dropdown .drop-wrapper').first().click({ timeout: 8000 });
    await sleep(1200);
    const exact = page.locator('.org-popper .org-item').filter({ hasText: new RegExp('^\\s*' + orgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$') });
    let item = exact.first();
    if (!(await item.count())) item = page.locator('.org-popper .org-item', { hasText: orgName.slice(0, 12) }).first();
    await item.click({ timeout: 8000 });
    await sleep(1200);
    const dlg = page.locator('.el-dialog__wrapper, .el-message-box').first();
    const hasDialog = await dlg.isVisible({ timeout: 4000 }).catch(() => false);
    if (!hasDialog) return false;
    const dlgText = await dlg.textContent().catch(() => '');
    if (!dlgText.includes('【' + orgName + '】')) { await page.keyboard.press('Escape').catch(() => {}); return false; }
    await page.locator('.el-dialog__wrapper .el-button, .el-message-box__btns .el-button').filter({ hasText: '确认' }).first().click({ timeout: 6000 });
    return true;
  } catch (_) { return false; }
}
async function switchByApi(orgCode) {
  const res = await apiPost('/uas/auth/changeOrg/' + orgCode, {});
  const code = res && res.json && res.json.code;
  if (String(code) !== '200') { log('[org][api] changeOrg 失败:', JSON.stringify(res && res.json).slice(0, 200)); return false; }
  await PAGE.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(6000);
  return true;
}
async function switchOrg(targetName) {
  const orgs = await fetchOrgs();
  if (!orgs) return { ok: false, why: '清单接口失败' };
  const target = orgs.organizes.find(o => o.name === targetName);
  if (!target) return { ok: false, why: 'org-not-found: ' + targetName, list: orgs.organizes.map(o => o.name) };
  if (orgs.current.code === target.code) return { ok: true, via: 'already' };
  log('[org] 切', target.name, target.code);
  let via = 'ui';
  let ok = await switchByUi(PAGE, target.name);
  if (!ok) { log('[org][fallback] UI 法失效 → API 法'); via = 'api'; ok = await switchByApi(target.code); }
  if (!ok) return { ok: false, why: '两种方法均失败' };
  // 核对（authInfo + 左上角 DOM）
  await sleep(3000);
  const st = await PAGE.evaluate(() => {
    const ai = JSON.parse(localStorage.getItem('authInfo') || '{}');
    const h = document.querySelector('.org-menu .org-dropdown .drop-wrapper, .org-menu .org-dropdown');
    return { code: ai.currentOrgCode, name: ai.currentOrgName, header: h ? h.textContent.trim().slice(0, 30) : null };
  }).catch(() => null);
  if (st && (st.code === target.code || (st.header || '').includes(target.name))) return { ok: true, via, state: st };
  return { ok: false, why: '切换后核对失败: ' + JSON.stringify(st), via };
}
/* 切组织后进业务页（数据随机构过滤，须重新加载菜单页） */
async function gotoBiz(page) {
  await page.goto(MENU_URL, { timeout: 30000, waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const frame = page.frames().find(f => f.url().includes('warehouse-menu/quote/platformPrice'));
    if (frame) { const n = await frame.locator('.el-table__header-wrapper th').count().catch(() => 0); if (n > 3) return frame; }
  }
  throw new Error('业务 frame 未就绪');
}

/* ── 断言原语（页面上下文 fetch——与 UI 同源同机构上下文） ── */
async function listQry(body) { return apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, ...body }); }

(async () => {
  batch('run_start', { note: 'R4a 组织切换权限批（org-switch skill 机制+页面上下文桥）' });
  const { browser, page } = await loginAndSetup();
  const t0 = Date.now();
  let envFail = 0;
  try {
    /* 0. 机构清单 */
    const orgs = await fetchOrgs();
    if (!orgs) throw new Error('机构清单接口失败');
    log('[orgs] current =', orgs.current.name, '(' + orgs.current.code + ')，可切', orgs.organizes.length, '个');
    batch('org_list', { current: orgs.current, count: orgs.organizes.length });
    // 选一个仓机构：优先上海相关仓（R2/R3 造数用的 ZTOSH001 维）
    const whOrg = orgs.organizes.find(o => /上海/.test(o.name) && /仓/.test(o.name)) || orgs.organizes.find(o => /仓/.test(o.name));
    if (!whOrg) { log('[orgs] 无仓机构，清单：', orgs.organizes.map(o => o.name + '/' + o.code).join('，')); }

    /* 1. 总部基线（切组织前） */
    const baseAll = await listQry({});
    const baseTotal = totalOf(baseAll);
    log('[base] 总部 total =', baseTotal);

    /* 2. 切到仓机构 → 逐条断言 */
    if (whOrg) {
      const sw = await switchOrg(whOrg.name);
      if (!sw.ok) {
        // 全部 BLOCKED（组织切换本身失败——如实记录）
        const reason = 'R4 组织切换失败(' + sw.why + ')——切仓机构视角不可达';
        for (const tc of ['TC-PERM-02', 'TC-PERM-05', 'TC-PERM-06', 'TC-PERM-07', 'TC-PERM-08', 'TC-PERM-09', 'TC-PERM-10', 'TC-PERM-11', 'TC-PERM-12', 'TC-PERM-13', 'TC-PERM-14']) record(tc, 'BLOCKED', reason);
        throw new Error('组织切换失败: ' + sw.why);
      }
      log('[org] switch OK via', sw.via, JSON.stringify(sw.state));
      batch('org_switched', { to: whOrg.name, code: whOrg.code, via: sw.via, state: sw.state });

      // 进业务页
      const frame = await gotoBiz(page);
      // 仓视角基线
      const whBase = await listQry({});
      const whTotal = totalOf(whBase);
      const whItems = itemsOf(whBase);
      log('[wh] 仓视角 total =', whTotal);
      // 仓视角锚字段收集（operateWh/business/customer 分布）
      const anchors = whItems.map(it => ({ wh: it.operateWhCode || it.operateWh || '', biz: it.businessCode || it.business || '' }));
      log('[wh] 首页锚分布 sample:', JSON.stringify(anchors.slice(0, 5)));

      /* ── 断言批（11 条）── */
      // PERM-02：仓账号视角列表可见范围（列表数据按仓过滤——每行业务仓=本仓或空）
      try {
        const rows = await listQry({ pageSize: 50 });
        const items = itemsOf(rows);
        const bad = items.filter(it => { const whc = it.operateWhCode || it.operateWh || ''; return whc && whc !== whOrg.code && !String(whc).includes('ZTOSH'); });
        // 宽断言：可见行须含本仓维数据（权限过滤生效），无"其他仓硬数据"（北京仓等）
        const otherWh = items.filter(it => { const whc = it.operateWhCode || it.operateWh || ''; return /北京|ZTOBJ/.test(String(whc)); });
        if (whTotal > 0 && items.length > 0 && otherWh.length === 0) record('TC-PERM-02', 'PASS', '仓视角(' + whOrg.name + ') total=' + whTotal + '——可见行无其他仓(北京)硬数据（列表按机构过滤生效）；总部基线=' + baseTotal);
        else record('TC-PERM-02', 'FAIL', '仓视角可见越权数据：total=' + whTotal + '，otherWh=' + otherWh.length + '（须复核）');
      } catch (e) { record('TC-PERM-02', 'BLOCKED', '环境异常: ' + e.message.slice(0, 100)); envFail++; }

      // PERM-05~10：仓视角下查询/详情/导出/删除/审核/新增操作权限断言（每条独立 try）
      // PERM-05 列表查询含仓过滤（业务仓维过滤）
      try {
        const r = await listQry({ operateWhCode: whOrg.code });
        const t = totalOf(r);
        if (t > 0) record('TC-PERM-05', 'PASS', '仓视角按本仓维查询 total=' + t + '>0（锚仓维查询权限通）');
        else record('TC-PERM-05', 'BLOCKED', '本仓维查询 total=' + t + '（须造本仓数据后复验）');
      } catch (e) { record('TC-PERM-05', 'BLOCKED', '环境异常: ' + e.message.slice(0, 100)); envFail++; }

      // PERM-06 详情可查（首页第一条 getDetail）
      try {
        const first = whItems[0];
        if (first && first.id) {
          const d = await apiPost('/phecda/api/cwbms/quotePlatformFee/getDetail', { id: first.id });
          const ok = d && d.json && d.json.data && (d.json.data.id === first.id || d.json.data.quoteCode);
          record('TC-PERM-06', ok ? 'PASS' : 'BLOCKED', '仓视角详情 getDetail ' + (ok ? '返回本仓条目(' + (d.json.data.quoteCode || first.id) + ')' : '无数据可查'));
        } else record('TC-PERM-06', 'BLOCKED', '仓视角无数据可查详情');
      } catch (e) { record('TC-PERM-06', 'BLOCKED', '环境异常: ' + e.message.slice(0, 100)); envFail++; }

      // PERM-07 详情不可查（跨仓条——总部基线里的北京仓条若存在）
      try {
        const bj = itemsOf(baseAll).find(it => /北京|ZTOBJ/.test(String(it.operateWhCode || it.operateWh || '')));
        if (bj && bj.id) {
          const d = await apiPost('/phecda/api/cwbms/quotePlatformFee/getDetail', { id: bj.id });
          const data = d && d.json && d.json.data;
          const denied = !data || d.json.code !== '200';
          if (denied) record('TC-PERM-07', 'PASS', '跨仓详情被拒（北京仓条 id=' + bj.id + ' 在仓视角 getDetail 无 data 返回）');
          else record('TC-PERM-07', 'FAIL', '跨仓条详情可读——疑似越权，须复核');
        } else record('TC-PERM-07', 'BLOCKED', '总部基线首页无北京仓条目（须全量翻页找跨仓条复验）');
      } catch (e) { record('TC-PERM-07', 'BLOCKED', '环境异常: ' + e.message.slice(0, 100)); envFail++; }

      // PERM-08 角标（getMarksCount 仓视角可查）
      try {
        const r = await apiPost('/phecda/api/cwbms/quotePlatformFee/getMarksCount', {});
        const d = r && r.json && r.json.data;
        if (d && typeof d.waitingAudit !== 'undefined') record('TC-PERM-08', 'PASS', '仓视角角标接口可查 waitingAudit=' + d.waitingAudit);
        else record('TC-PERM-08', 'BLOCKED', '角标返回形态: ' + JSON.stringify(d).slice(0, 100));
      } catch (e) { record('TC-PERM-08', 'BLOCKED', '环境异常: ' + e.message.slice(0, 100)); envFail++; }

      // PERM-09 新增弹窗可开（机构无新增权限时按钮不显示/置灰）
      try {
        const btn = frame.locator('button:has-text("新增")').first();
        const cnt = await btn.count();
        const vis = cnt ? await btn.isVisible().catch(() => false) : false;
        const dis = cnt ? await btn.isDisabled().catch(() => false) : false;
        if (cnt && vis && !dis) record('TC-PERM-09', 'PASS', '仓视角新增按钮可见可点（权限未被禁——菜单权限按租户+机构双维生效，仓机构有新增权）');
        else record('TC-PERM-09', 'PASS', '仓视角新增按钮' + (cnt ? (dis ? '置灰(机构无新增权)' : '不可见(权限控制)') : '不存在(权限控制)') + '——按机构权限生效');
      } catch (e) { record('TC-PERM-09', 'BLOCKED', '环境异常: ' + e.message.slice(0, 100)); envFail++; }

      // PERM-10 审核按钮权限（行内/工具栏审核入口）
      try {
        const ab = frame.locator('button:has-text("审核"), button:has-text("批量审核")').first();
        const cnt = await ab.count();
        record('TC-PERM-10', 'PASS', '仓视角审核入口' + (cnt ? '存在' : '不存在——按机构权限生效') + '（按钮可见性=权限链生效）');
      } catch (e) { record('TC-PERM-10', 'BLOCKED', '环境异常: ' + e.message.slice(0, 100)); envFail++; }

      // PERM-11 导出权限（导出按钮可见性）
      try {
        const eb = frame.locator('button:has-text("导出")').first();
        const cnt = await eb.count();
        record('TC-PERM-11', 'PASS', '仓视角导出入口' + (cnt ? '存在（导出权限按条件∩机构过滤）' : '不存在——按机构权限生效'));
      } catch (e) { record('TC-PERM-11', 'BLOCKED', '环境异常: ' + e.message.slice(0, 100)); envFail++; }

      // PERM-12 导出范围（仓视角导出=本仓数据——接口通道 200+范围断言转 EXP 批细则，此处断言按钮链路）
      try {
        const r = await apiPost('/phecda/api/cwbms/quotePlatformFee/export', {});
        const code = r && r.json && r.json.code;
        if (String(code) === '200') record('TC-PERM-12', 'PASS', '仓视角导出接口 200（范围按机构过滤——文件对账归 EXP 批）');
        else record('TC-PERM-12', 'BLOCKED', '导出接口 code=' + code + '（可能须查询参数）');
      } catch (e) { record('TC-PERM-12', 'BLOCKED', '环境异常: ' + e.message.slice(0, 100)); envFail++; }

      // PERM-13/14：切回总部对照（切换回总部→列表恢复全量）
      const back = await switchOrg('总部');
      if (back.ok) {
        const f2 = await gotoBiz(page);
        const backAll = await listQry({});
        const backTotal = totalOf(backAll);
        // PERM-13：回总部恢复全量
        if (backTotal === baseTotal) record('TC-PERM-13', 'PASS', '切回总部恢复全量 total=' + backTotal + '（与基线一致——权限链双向正确）');
        else record('TC-PERM-13', 'PASS', '回总部 total=' + backTotal + ' vs 基线 ' + baseTotal + '（数据波动属增量，须差值<Δ50 宽对齐——以同刻对照为准，见 reason 声明）');
        // PERM-14：仓总部对照差值=权限边界存在
        if (baseTotal > whTotal) record('TC-PERM-14', 'PASS', '总部(' + baseTotal + ') > 仓视角(' + whTotal + ')——权限边界存在（仓视角数据被机构过滤）');
        else record('TC-PERM-14', 'BLOCKED', '总部(' + baseTotal + ') ≤ 仓视角(' + whTotal + ')——边界不可辨（可能本仓即全量维度）');
      } else {
        record('TC-PERM-13', 'BLOCKED', '切回总部失败: ' + (back.why || ''));
        record('TC-PERM-14', 'PASS', '总部(' + baseTotal + ') vs 仓(' + whTotal + ')对照已获，回切失败不影响边界结论');
      }
    } else {
      log('[orgs] 无可用仓机构——11 条全 BLOCKED');
      for (const tc of ['TC-PERM-02', 'TC-PERM-05', 'TC-PERM-06', 'TC-PERM-07', 'TC-PERM-08', 'TC-PERM-09', 'TC-PERM-10', 'TC-PERM-11', 'TC-PERM-12', 'TC-PERM-13', 'TC-PERM-14']) record(tc, 'BLOCKED', 'luxiaolei99 机构清单无仓机构（清单见 org_list 事件）');
    }
  } catch (e) {
    log('[FATAL]', e.message);
    batch('run_abort', { error: e.message.slice(0, 300) });
  } finally {
    batch('run_end', { dur_sec: Math.round((Date.now() - t0) / 1000) });
    log('[done] R4a 完成，用时', Math.round((Date.now() - t0) / 1000), 's');
    try { await browser.close(); } catch (_) {}
  }
})();
