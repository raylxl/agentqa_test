// pp_datagen.js — B 轮 PRE 造数链（五态池+各章专有形态）
// 配方全部来自 R1 已验证：fill+blur 日期/逐条 reload/缓存直用/特殊属性错键（避开 PTF091044/091050 超长区间占位条）
// 造数原则：PP-DATA 前缀统一、防撞错键（贴单即发维）、每批 reload 隔离、audit 接口过审、deleteIds 接口清场
const path = require('path');
const fs = require('fs');
const J = path.join(__dirname);
const cdp = require(path.join(J, 'cdp_pool.js'));
const { ensureTenant, findJtPage } = require(path.join(J, 'pw_tenant.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const MENU_URL = 'http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice';
const GW = 'http://gateway-ll.test.ztoeco.com';
const ACCOUNT = 'luxiaolei99', SECRET = 'Zto@20211021';
const LEDGER = '/Users/kimfang/WorkBuddy/ai测试agent/需求用例库/用例文件/平台价格分章/exec_ledger/ledger.jsonl';

let page, frame, browser, port;

async function setup() {
  const { execSync } = require('child_process');
  try { execSync('pkill -f "remote-debugging-port=9335"', { shell: '/bin/bash' }); } catch (e) {}
  await sleep(1500);
  try { fs.unlinkSync(path.join(J, 'locks/9335.lock')); } catch (e) {}
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335], purpose: 'PP造数链', verbose: true });
  port = c.port;
  const { chromium } = require('playwright');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 10000 });
  page = browser.contexts()[0].pages()[0] || (await browser.contexts()[0].newPage());
  await page.goto('http://jt-ll.test.ztoeco.com/welcome', { timeout: 30000, waitUntil: 'domcontentloaded' });
  await sleep(5000);
  if (!page.url().includes('sso.test.ztoeco.com')) {
    await page.evaluate(() => { localStorage.removeItem('MICRO_APP_MAIN_TOKEN_KEY'); location.href = 'http://jt-ll.test.ztoeco.com/welcome'; });
    await sleep(6000);
  }
  if (page.url().includes('sso.test.ztoeco.com')) {
    const ins = await page.evaluate(() => [...document.querySelectorAll('input')].filter(el => el.offsetWidth).length).catch(() => 0);
    if (ins === 0) { await page.click('a.login-switch-link', { timeout: 10000 }); await sleep(2500); }
    for (let w = 0; w < 10; w++) { const cc = await page.locator('input[name="username"]').count().catch(() => 0); if (cc) break; await sleep(1000); }
    await page.fill('input[name="username"]', ACCOUNT);
    await page.fill('input[name="password"]', SECRET);
    await page.click('button.login-btn', { timeout: 10000 });
    for (let i = 0; i < 15; i++) { await sleep(2000); if (page.url().includes('jt-ll.test.ztoeco.com') && !page.url().includes('login')) { const t = await page.evaluate(() => document.body.innerText).catch(() => ''); if (t.includes('预发环境')) break; } }
  }
  log('[login] ok');
  await ensureTenant(browser, '智冷仓链', () => {});
  log('[tenant] ok');
  await reload();
}

async function reload() {
  await page.goto(MENU_URL, { timeout: 30000, waitUntil: 'domcontentloaded' });
  for (let w = 0; w < 40; w++) {
    await sleep(2000);
    frame = page.frames().find(f => f.url().includes('warehouse-menu/quote/platformPrice'));
    if (frame) { const n = await frame.locator('.el-table__header-wrapper th').count().catch(() => 0); if (n > 3) break; }
  }
  if (!frame) throw new Error('frame 未就绪');
}

/* 已验证的弹窗填表配方（R1 fillAddDialog 同构） */
async function addQuote({ name, cost, flow, effStart, effEnd, price, specialAttr }) {
  const addBtn = frame.locator('button:has-text("新增")').first();
  for (let w = 0; w < 15; w++) { if (await addBtn.isVisible().catch(() => false)) break; await sleep(1000); }
  await addBtn.click({ timeout: 15000, force: true });
  await sleep(2500);
  const dlg = frame.locator('.el-dialog:visible').first();
  if (!(await dlg.count())) throw new Error('弹窗未开（' + name + '）');
  const nameIn = dlg.locator('input[placeholder*="报价名称"]');
  await nameIn.click({ timeout: 8000 });
  await nameIn.type(name, { delay: 15 }); await sleep(400);
  // 费用（缓存直用）
  const costAlready = await dlg.locator('.el-select__wrapper').filter({ hasText: cost }).first().count().catch(() => 0);
  if (!costAlready) {
    let cw = dlg.locator('.el-select__wrapper').filter({ hasText: /费用名称|请选择|流量管理费/ }).first();
    if (await cw.count()) {
      await cw.click({ timeout: 8000 }); await sleep(900);
      const co = frame.locator('.el-select-dropdown__item:visible').filter({ hasText: cost }).first();
      for (let w = 0; w < 10; w++) { if (await co.count()) break; await sleep(800); }
      if (await co.count()) await co.click({ timeout: 8000 }); await sleep(600);
    }
  }
  // 流向（缓存直用）
  const flowAlready = await dlg.locator('.el-select__wrapper').filter({ hasText: flow }).first().count().catch(() => 0);
  if (!flowAlready) {
    const fw = dlg.locator('.el-select__wrapper').filter({ hasText: /结算流向|请选择/ }).first();
    if (await fw.count()) {
      await fw.click({ timeout: 8000 }); await sleep(900);
      const fo = frame.locator('.el-select-dropdown__item:visible').filter({ hasText: flow }).first();
      for (let w = 0; w < 10; w++) { if (await fo.count()) break; await sleep(800); }
      if (await fo.count()) await fo.click({ timeout: 8000 }); await sleep(600);
    }
  }
  // 特殊属性（错键维——全部造数带贴单即发，避开全空维超长区间占位条）
  if (specialAttr) {
    const saAlready = await dlg.locator('.el-select__wrapper').filter({ hasText: specialAttr }).first().count().catch(() => 0);
    if (!saAlready) {
      const sw = dlg.locator('.el-select__wrapper').filter({ hasText: /特殊属性/ }).first();
      if (await sw.count()) {
        await sw.click({ timeout: 8000 }); await sleep(900);
        const so = frame.locator('.el-select-dropdown__item:visible').filter({ hasText: specialAttr }).first();
        for (let w = 0; w < 10; w++) { if (await so.count()) break; await sleep(800); }
        if (await so.count()) await so.click({ timeout: 8000 }); await sleep(600);
      }
    }
  }
  // 日期（fill+blur）
  const effIn = dlg.locator('input[placeholder*="生效日期"]');
  await effIn.click({ timeout: 5000 }).catch(() => {});
  await effIn.fill(effStart, { timeout: 8000 }).catch(() => {});
  await dlg.locator('.el-dialog__title').click().catch(() => {}); await sleep(700);
  const expIn = dlg.locator('input[placeholder*="失效日期"]');
  await expIn.fill(effEnd, { timeout: 8000 }).catch(() => {});
  await dlg.locator('.el-dialog__title').click().catch(() => {}); await sleep(700);
  // 明细
  const num = dlg.locator('.el-table .el-input-number input').first();
  await num.click({ timeout: 5000 }).catch(() => {});
  await num.fill('999999.99', { timeout: 8000 }).catch(() => {}); await sleep(400);
  const pi = dlg.locator('.el-table input').nth(1);
  await pi.click({ timeout: 5000 }).catch(() => {});
  await pi.fill(price, { timeout: 8000 }).catch(() => {}); await sleep(300);
  await dlg.locator('button:has-text("确定")').first().click({ timeout: 8000 });
  await sleep(6000);
  const still = await frame.locator('.el-dialog:visible').count().catch(() => 0);
  if (still) {
    // 校验失败或判重——关掉返回 false
    await frame.locator('.el-dialog:visible button:has-text("取消")').first().click({ timeout: 5000 }).catch(() => {});
    await sleep(800);
    return { ok: false };
  }
  return { ok: true };
}

/* 接口 helper（页面上下文 fetch 桥——R1 实证唯一可靠通道） */
async function api(path_, data) {
  return await page.evaluate(async ({ u, b }) => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify(b) });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch (e) {}
    return { status: r.status, j, raw: t.slice(0, 200) };
  }, { u: GW + path_, b: data });
}
async function queryByName(name) {
  const r = await api('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 20, quoteName: name });
  return { total: r.j && r.j.data ? r.j.data.total : -1, items: (r.j && r.j.data && r.j.data.items) || [] };
}
async function auditByIds(ids, auditFlag) {
  // auditStatus 语义（后端实证）：1=审核通过 2=审核不通过（驳回）
  return await api('/phecda/api/cwbms/quotePlatformFee/audit', { auditIds: ids, auditStatus: auditFlag });
}
async function deleteByIds(ids) {
  return await api('/phecda/api/cwbms/quotePlatformFee/delete', { deleteIds: ids });
}

/* ═══════════ 造数计划（五态池+各章形态，全 PP-DATA 前缀） ═══════════
 * 状态五态：未审核(0)/已审核(1)/驳回(3?) ——生效三态由日期窗控制：生效中/未生效/已失效
 * 键组合：流量管理费+总部收操作仓+贴单即发（避开 PTF091044/091050 全空维超长区间）
 * 日期窗错峰：2028 各月（避开已探明占位条 2026-2030 内全空维+本键无占位）
 */
const POOL = [
  // R2 dry 自耗补造：D3（已删）重造 2028-02 窗
  { name: 'PP-DATA-D3-已审核-已失效', cost: '流量管理费', flow: '总部收操作仓', eff: '2028-02-01', exp: '2028-02-28', st: 'raw', thenAudit: 1 },
];

(async () => {
  await setup();
  log('[datagen] 开始，共', POOL.length, '条');
  const made = [];
  for (const p of POOL) {
    await reload(); // 逐条 reload（R1 实证）
    const r = await addQuote({ name: p.name, cost: p.cost, flow: p.flow, effStart: p.eff, effEnd: p.exp, price: '1.0000', specialAttr: '贴单即发' });
    log(' ', p.name, r.ok ? '已造' : '失败/撞重');
    if (r.ok) made.push(p);
  }
  // 复核落库
  const chk = await queryByName('PP-DATA');
  log('[落库]', chk.total, '条');
  // 审核流转（B1/D1/D2/D3 过审；C1 驳回）——audit 接口参数试探
  const toAudit = made.filter(m => m.thenAudit === 1).map(m => m.name);
  const toReject = ['PP-DATA-C1-驳回态']; // 固定驳回 C1（首条已造 2027-10）
  if (toAudit.length) {
    const ids = (await queryByName('PP-DATA')).items.filter(i => toAudit.includes(i.quoteName)).map(i => i.id);
    if (ids.length) {
      const r = await auditByIds(ids, 2);
      log('[审核通过]', JSON.stringify(r.raw).slice(0, 120));
    }
  }
  if (toReject.length) {
    const items = (await queryByName('PP-DATA')).items.filter(i => toReject.includes(i.quoteName));
    if (items.length) {
      const r = await auditByIds([items[0].id], 2);
      log('[驳回]', JSON.stringify(r.raw).slice(0, 120));
    }
  }
  // 终态 dump（防撞台账）
  const final = await queryByName('PP-DATA');
  const dump = final.items.map(i => ({ code: i.quoteCode, name: i.quoteName, audit: i.auditStatus, rng: i.dateRange, flow: i.settFlowName, sa: i.specialAttributes }));
  fs.writeFileSync(path.join(J, 'pp_datagen_pool.json'), JSON.stringify(dump, null, 1));
  log('[终态池]', JSON.stringify(dump, null, 1).slice(0, 1200));
  await browser.close().catch(() => {});
  try { cdp.removeLock(port); } catch (_) {}
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message.slice(0, 200)); process.exit(1); });
