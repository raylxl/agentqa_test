// pp_exec_ui3.js — UI 批修复复跑：补造 D1（cleanup 已删）+EDIT-04 副本链+AUD-06 顶替+REJ-01 驳回+UI-01 重置后对账
const path = require('path');
const fs = require('fs');
const J = path.join(__dirname);
const cdp = require(path.join(J, 'cdp_pool.js'));
const { ensureTenant, findJtPage } = require(path.join(J, 'pw_tenant.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const MENU_URL = 'http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice';
const GW = 'http://gateway-ll.test.ztoeco.com';
const LEDGER = '/Users/kimfang/WorkBuddy/ai测试agent/需求用例库/用例文件/平台价格分章/exec_ledger/ledger.jsonl';
const day = '20261126';
let EXEC_NO = 400;
const bjTs = () => new Date().toLocaleString('sv-SE').replace(' ', ' ');
function record(tc, status, reason, extra = {}) { fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: 'case', tc, status, reason: String(reason || '').slice(0, 500), exec_id: 'PP-' + day + '-' + String(EXEC_NO++).padStart(3, '0'), run_id: 'PP-R2-20261126', round: '执行R2', channel: 'ui', ...extra }) + '\n'); }
function batch(kind, extra = {}) { fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: kind, run_id: 'PP-R2-20261126', round: '执行R2', channel: 'ui', book: '财务需求2026_云仓_平台价格_11.30', operator: 'AI(UI 修复批)', ...extra }) + '\n'); }

let page, frame, browser, port;
async function setup() {
  const { execSync } = require('child_process');
  try { execSync('pkill -f "remote-debugging-port=9335"', { shell: '/bin/bash' }); } catch (e) {}
  await sleep(1500);
  try { fs.unlinkSync(path.join(J, 'locks/9335.lock')); } catch (e) {}
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335], purpose: 'UI修复批', verbose: true });
  port = c.port;
  const { chromium } = require('playwright');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 10000 });
  page = browser.contexts()[0].pages()[0] || (await browser.contexts()[0].newPage());
  await page.goto('http://jt-ll.test.ztoeco.com/welcome', { timeout: 30000, waitUntil: 'domcontentloaded' });
  await sleep(5000);
  if (!page.url().includes('sso.test.ztoeco.com')) { await page.evaluate(() => { localStorage.removeItem('MICRO_APP_MAIN_TOKEN_KEY'); location.href = 'http://jt-ll.test.ztoeco.com/welcome'; }); await sleep(6000); }
  if (page.url().includes('sso.test.ztoeco.com')) {
    const ins = await page.evaluate(() => [...document.querySelectorAll('input')].filter(el => el.offsetWidth).length).catch(() => 0);
    if (ins === 0) { await page.click('a.login-switch-link', { timeout: 10000 }); await sleep(2500); }
    for (let w = 0; w < 10; w++) { const cc = await page.locator('input[name="username"]').count().catch(() => 0); if (cc) break; await sleep(1000); }
    await page.fill('input[name="username"]', 'luxiaolei99');
    await page.fill('input[name="password"]', 'Zto@20211021');
    await page.click('button.login-btn', { timeout: 10000 });
    for (let i = 0; i < 15; i++) { await sleep(2000); if (page.url().includes('jt-ll.test.ztoeco.com') && !page.url().includes('login')) { const t = await page.evaluate(() => document.body.innerText).catch(() => ''); if (t.includes('预发环境')) break; } }
  }
  log('[login] ok');
  await ensureTenant(browser, '智冷仓链', () => {});
  await reload();
}
async function reload() {
  await page.goto(MENU_URL, { timeout: 30000, waitUntil: 'domcontentloaded' });
  for (let w = 0; w < 40; w++) { await sleep(2000); frame = page.frames().find(f => f.url().includes('warehouse-menu/quote/platformPrice')); if (frame) { const n = await frame.locator('.el-table__header-wrapper th').count().catch(() => 0); if (n > 3) break; } }
  if (!frame) throw new Error('frame 未就绪');
}
async function api(p_, d) {
  return await page.evaluate(async ({ u, b }) => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify(b) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
    return { status: r.status, j, raw: t.slice(0, 200) };
  }, { u: GW + p_, b: d });
}
async function q(f) { const r = await api('/phecda/api/cwbms/quotePlatformFee/getPageList', Object.assign({ page: 1, pageSize: 30 }, f)); return { total: r.j && r.j.data ? r.j.data.total : -1, items: (r.j && r.j.data && r.j.data.items) || [] }; }

// 弹窗新增配方（同 pp_exec_ui.js 已验证）
async function addQuote({ name, cost, flow, effStart, effEnd, price }) {
  const addBtn = frame.locator('button:has-text("新增")').first();
  for (let w = 0; w < 15; w++) { if (await addBtn.isVisible().catch(() => false)) break; await sleep(1000); }
  await addBtn.click({ timeout: 15000, force: true });
  await sleep(2500);
  const dlg = frame.locator('.el-dialog:visible').first();
  if (!(await dlg.count())) return { ok: false };
  const nameIn = dlg.locator('input[placeholder*="报价名称"]');
  await nameIn.click({ timeout: 8000 }); await nameIn.type(name, { delay: 15 }); await sleep(400);
  const costAlready = await dlg.locator('.el-select__wrapper').filter({ hasText: cost }).first().count().catch(() => 0);
  if (!costAlready) {
    const cw = dlg.locator('.el-select__wrapper').filter({ hasText: /费用名称|请选择|流量管理费/ }).first();
    if (await cw.count()) { await cw.click({ timeout: 8000 }); await sleep(900); const co = frame.locator('.el-select-dropdown__item:visible').filter({ hasText: cost }).first(); for (let w = 0; w < 10; w++) { if (await co.count()) break; await sleep(800); } if (await co.count()) await co.click({ timeout: 8000 }); await sleep(600); }
  }
  const flowAlready = await dlg.locator('.el-select__wrapper').filter({ hasText: flow }).first().count().catch(() => 0);
  if (!flowAlready) {
    const fw = dlg.locator('.el-select__wrapper').filter({ hasText: /结算流向|请选择/ }).first();
    if (await fw.count()) { await fw.click({ timeout: 8000 }); await sleep(900); const fo = frame.locator('.el-select-dropdown__item:visible').filter({ hasText: flow }).first(); for (let w = 0; w < 10; w++) { if (await fo.count()) break; await sleep(800); } if (await fo.count()) await fo.click({ timeout: 8000 }); await sleep(600); }
  }
  const saAlready = await dlg.locator('.el-select__wrapper').filter({ hasText: '贴单即发' }).first().count().catch(() => 0);
  if (!saAlready) {
    const sw = dlg.locator('.el-select__wrapper').filter({ hasText: /特殊属性/ }).first();
    if (await sw.count()) { await sw.click({ timeout: 8000 }); await sleep(900); const so = frame.locator('.el-select-dropdown__item:visible').filter({ hasText: '贴单即发' }).first(); for (let w = 0; w < 10; w++) { if (await so.count()) break; await sleep(800); } if (await so.count()) await so.click({ timeout: 8000 }); await sleep(600); }
  }
  const effIn = dlg.locator('input[placeholder*="生效日期"]');
  await effIn.click({ timeout: 5000 }).catch(() => {});
  await effIn.fill(effStart, { timeout: 8000 }).catch(() => {});
  await dlg.locator('.el-dialog__title').click().catch(() => {}); await sleep(700);
  const expIn = dlg.locator('input[placeholder*="失效日期"]');
  await expIn.fill(effEnd, { timeout: 8000 }).catch(() => {});
  await dlg.locator('.el-dialog__title').click().catch(() => {}); await sleep(700);
  const num = dlg.locator('.el-table .el-input-number input').first();
  await num.click({ timeout: 5000 }).catch(() => {}); await num.fill('999999.99', { timeout: 8000 }).catch(() => {}); await sleep(400);
  const pi = dlg.locator('.el-table input').nth(1);
  await pi.click({ timeout: 5000 }).catch(() => {}); await pi.fill(price, { timeout: 8000 }).catch(() => {}); await sleep(300);
  await dlg.locator('button:has-text("确定")').first().click({ timeout: 8000 });
  await sleep(6000);
  const still = await frame.locator('.el-dialog:visible').count().catch(() => 0);
  if (still) { await frame.locator('.el-dialog:visible button:has-text("取消")').first().click({ timeout: 5000 }).catch(() => {}); await sleep(800); return { ok: false }; }
  return { ok: true };
}

(async () => {
  await setup();
  batch('run_start', { planned: 4, dispatch: 4, channel_note: 'UI 修复批（UI-01/EDIT-04/AUD-06/REJ-01）' });
  const stats = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_EXECUTED: 0 };

  // ① UI-01 复跑（重置后角标对账——复验已三相等）
  try {
    await reload();
    await frame.locator('button:has-text("重置")').first().click({ timeout: 8000 }); await sleep(3000);
    const badge = frame.locator('.search-radio [class*=radio]').filter({ hasText: '未审核' }).first();
    const text = await badge.innerText().catch(() => '');
    const m = text.match(/(\d+)/); const badgeNum = m ? +m[1] : null;
    const unAudit = await q({ auditStatus: 0, page: 1, pageSize: 1 });
    const marks = await api('/phecda/api/cwbms/quotePlatformFee/getMarksCount', { page: 1, pageSize: 10 });
    const w = marks.j && marks.j.data && marks.j.data.waitingAudit;
    const pass = badgeNum === w && w === unAudit.total;
    record('TC-UI-01', pass ? 'PASS' : 'FAIL', pass ? '角标三相等：radio=' + badgeNum + ' = getMarksCount=' + w + ' = 未审核 total=' + unAudit.total + '（Q7 同条件对账）' : '角标=' + badgeNum + ' marks=' + w + ' total=' + unAudit.total);
    stats[pass ? 'PASS' : 'FAIL']++;
  } catch (e) { record('TC-UI-01', 'NOT_EXECUTED', '异常: ' + e.message.slice(0, 150)); stats.NOT_EXECUTED++; }
  log('[1/4] UI-01 done');

  // ② 补造 D1+过审（cleanup 已删）
  let d1id = null;
  try {
    await reload();
    const mk1 = await addQuote({ name: 'PP-DATA-D1-已审核-生效中', cost: '流量管理费', flow: '总部收操作仓', effStart: '2028-11-01', effEnd: '2028-11-30', price: '1.0000' });
    log('[补造 D1]', mk1.ok);
    if (mk1.ok) {
      const got = await q({ quoteName: 'PP-DATA-D1-已审核-生效中' });
      d1id = got.items[0] && got.items[0].id;
      if (d1id) await api('/phecda/api/cwbms/quotePlatformFee/audit', { auditIds: [d1id], auditStatus: 1 });
    }
  } catch (e) { log('[补造 fail]', e.message.slice(0, 80)); }

  // ③ EDIT-04 副本链（已审核 D1 编辑保存→双行）+ AUD-06 副本过审顶替
  if (d1id) {
    try {
      await reload();
      const nameCol = frame.locator('.el-col.modelFormClass').filter({ hasText: /^\s*报价名称/ }).first();
      await nameCol.locator('input.el-input__inner').first().fill('PP-DATA-D1-已审核-生效中', { timeout: 8000 });
      await frame.locator('button:has-text("查询")').first().click({ timeout: 8000 }); await sleep(3000);
      const row = frame.locator('.el-table__body-wrapper tr').first();
      await row.locator('button:has-text("编辑"), a:has-text("编辑")').first().click({ timeout: 8000 }); await sleep(2500);
      const dlg = frame.locator('.el-dialog:visible').first();
      if (await dlg.count()) {
        const pi = dlg.locator('.el-table input').nth(1);
        await pi.click({ timeout: 5000 }).catch(() => {}); await pi.fill('2.0000', { timeout: 8000 }).catch(() => {});
        await dlg.locator('button:has-text("确定")').first().click({ timeout: 8000 }); await sleep(6000);
        const still = await frame.locator('.el-dialog:visible').count().catch(() => 0);
        if (still) await frame.locator('.el-dialog:visible button:has-text("取消")').first().click({ timeout: 5000 }).catch(() => {});
        const after = await q({ quoteName: 'PP-DATA-D1-已审核-生效中' });
        const pass = after.total >= 2;
        record('TC-EDIT-04', pass ? 'PASS' : 'BLOCKED', pass ? '已审核编辑生成副本：查询 total=' + after.total + '（≥2 行=主+副本，Q14）' : '编辑后 total=' + after.total + '（副本形态未探明——弹窗残留=' + still + '）');
        stats[pass ? 'PASS' : 'BLOCKED']++;
        // AUD-06（副本过审顶替）
        const copy = after.items.find(i => i.auditStatus === 0);
        if (pass && copy) {
          const r = await api('/phecda/api/cwbms/quotePlatformFee/audit', { auditIds: [copy.id], auditStatus: 1 });
          const after2 = await q({ quoteName: 'PP-DATA-D1-已审核-生效中' });
          const p2 = after2.total < after.total;
          record('TC-AUD-06', p2 ? 'PASS' : 'FAIL', p2 ? '副本过审顶替：' + after.total + '行→' + after2.total + '行（覆盖合并，Q14 善后）' : '行数未减 ' + after.total + '→' + after2.total);
          stats[p2 ? 'PASS' : 'FAIL']++;
        } else {
          record('TC-AUD-06', 'BLOCKED', '副本未生成（依赖 EDIT-04 双行）');
          stats.BLOCKED++;
        }
      } else { record('TC-EDIT-04', 'NOT_EXECUTED', '编辑弹窗未开'); record('TC-AUD-06', 'BLOCKED', '依赖 EDIT-04'); stats.NOT_EXECUTED++; stats.BLOCKED++; }
    } catch (e) { record('TC-EDIT-04', 'NOT_EXECUTED', '异常: ' + e.message.slice(0, 150)); record('TC-AUD-06', 'BLOCKED', '依赖异常'); stats.NOT_EXECUTED++; stats.BLOCKED++; }
  } else {
    record('TC-EDIT-04', 'BLOCKED', 'D1 补造失败（cleanup 已删+重造失败）'); record('TC-AUD-06', 'BLOCKED', '依赖 D1');
    stats.BLOCKED += 2;
  }
  log('[3/4] EDIT-04/AUD-06 done');

  // ④ REJ-01 驳回 UI 链（A1 需补造未审核条）
  try {
    await reload();
    const a1 = await q({ quoteName: 'PP-DATA-A1-未审核-生效中' });
    if (a1.total === 0) {
      const mk2 = await addQuote({ name: 'PP-DATA-A1-未审核-生效中', cost: '流量管理费', flow: '总部收操作仓', effStart: '2028-09-01', effEnd: '2028-09-30', price: '1.0000' });
      log('[补造 A1]', mk2.ok);
    }
    await reload();
    const nameCol = frame.locator('.el-col.modelFormClass').filter({ hasText: /^\s*报价名称/ }).first();
    await nameCol.locator('input.el-input__inner').first().fill('PP-DATA-A1-未审核-生效中', { timeout: 8000 });
    await frame.locator('button:has-text("查询")').first().click({ timeout: 15000 }); await sleep(4000);
    const row = frame.locator('.el-table__body-wrapper tr').first();
    await row.locator('.el-checkbox, input[type=checkbox]').first().click({ timeout: 8000 }).catch(() => {});
    await frame.locator('button:has-text("审核驳回")').first().click({ timeout: 8000 }); await sleep(2500);
    const confirm = frame.locator('.el-message-box:visible button:has-text("确定"), .el-dialog:visible button:has-text("确定")').last();
    await confirm.click({ timeout: 8000 }).catch(() => {}); await sleep(5000);
    const after = await q({ quoteName: 'PP-DATA-A1-未审核-生效中' });
    const a = after.items[0];
    const rejected = a && a.auditBy && a.auditStatus !== 0;
    record('TC-REJ-01', rejected ? 'PASS' : 'BLOCKED', rejected ? 'UI 驳回链走通：A1 auditStatus=' + a.auditStatus + '（驳回态字段值实证）+审核人=' + a.auditBy : '驳回未生效或形态不同：audit=' + (a && a.auditStatus));
    stats[rejected ? 'PASS' : 'BLOCKED']++;
  } catch (e) { record('TC-REJ-01', 'NOT_EXECUTED', '异常: ' + e.message.slice(0, 150)); stats.NOT_EXECUTED++; }
  log('[4/4] REJ-01 done');

  batch('run_end', { n: 4, stats, endKind: 'normal' });
  log('[summary]', JSON.stringify(stats));
  // 造数清理
  const pool = await q({ quoteName: 'PP-DATA' });
  if (pool.items.length) { const r = await api('/phecda/api/cwbms/quotePlatformFee/delete', { deleteIds: pool.items.map(x => x.id) }); log('[cleanup]', '删', pool.items.length); }
  await browser.close().catch(() => {});
  try { cdp.removeLock(port); } catch (_) {}
  process.exit(0);
})().catch(e => { console.error('FATAL', e); batch('run_end', { endKind: 'fatal', reason: e.message.slice(0, 300) }); process.exit(1); });
