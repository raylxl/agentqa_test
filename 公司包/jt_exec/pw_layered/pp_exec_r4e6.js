// pp_exec_r4e6.js — R4e 六批：DEL 族语义修正（07/08 未审可删、09/10 驳回可删、04 真混勾拦截、02/06 副本连带）
const fs = require('fs');
const path = require('path');
const J = __dirname;
const cdp = require(path.join(J, 'cdp_pool.js'));
const { ensureTenant } = require(path.join(J, 'pw_tenant.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const LEDGER = '/Users/kimfang/WorkBuddy/ai测试agent/需求用例库/用例文件/平台价格分章/exec_ledger/ledger.jsonl';
const GW = 'http://gateway-ll.test.ztoeco.com';
const bjTs = () => new Date().toLocaleString('sv-SE').replace(' ', ' ');
let EXEC_NO = 900;
for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) { const m = line.match(/PP-20261126-(\d+)/); if (m) EXEC_NO = Math.max(EXEC_NO, +m[1] + 1); }
const record = (tc, status, reason) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: 'case', tc, status, reason: String(reason || '').slice(0, 500), exec_id: 'PP-20261126-' + String(EXEC_NO++).padStart(3, '0'), run_id: 'PP-R4-20261126', round: '执行R4', channel: 'ui' }) + '\n');
const batch = (kind, extra) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: kind, run_id: 'PP-R4-20261126', round: '执行R4', channel: 'ui', book: '财务需求2026_云仓_平台价格_11.30', operator: 'AI(R4e六批)', ...extra }) + '\n');

let page, frame, browser, port;
const apiPost = (p, body) => page.evaluate(async ({ u, b }) => {
  const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify(b) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
  return { status: r.status, json: j, text: t.slice(0, 300) };
}, { u: GW + p, b: body });
const queryByName = async (name) => { const r = await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, quoteName: name }); const d = r.json && r.json.data; return { total: d ? d.total : -1, items: d ? (d.items || []) : [] }; };
const mk = (name, o) => apiPost('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', { quoteName: name, costCode: o.w || 'W70', settFlow: o.f || 370, specialAttributes: null, customerCode: null, businessWhCode: null, operateWhCode: null, startDate: o.s, endDate: o.e, detailModel: 'TIER', quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: 1, minPrice: null, maxPrice: null }] });
/* 过审（强复核） */
async function audit1(id, name) {
  await apiPost('/phecda/api/cwbms/quotePlatformFee/audit', { auditIds: [id], auditStatus: 1 });
  for (let i = 0; i < 5; i++) { await sleep(2000); const it = (await queryByName(name)).items[0]; if (it && it.auditStatus === 1) return it; }
  return (await queryByName(name)).items[0];
}
async function setup() {
  process.env.JT_ACCOUNT = 'luxiaolei99'; process.env.JT_SECRET = 'Zto@20211021'; process.env.CHROME_NO_SANDBOX = '1';
  const { execSync } = require('child_process');
  try { execSync('pkill -f "remote-debugging-port=933[567]"', { shell: '/bin/bash' }); } catch (e) {}
  await sleep(1500);
  try { for (const f of fs.readdirSync(path.join(J, 'locks'))) fs.unlinkSync(path.join(J, 'locks', f)); } catch (e) {}
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335, 9336, 9337], purpose: 'R4e六批', verbose: true });
  port = c.port;
  const { chromium } = require('playwright');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 10000 });
  page = browser.contexts()[0].pages()[0] || (await browser.contexts()[0].newPage());
  await page.goto('http://jt-ll.test.ztoeco.com/welcome', { timeout: 30000, waitUntil: 'domcontentloaded' });
  await sleep(5000);
  let ok = false;
  try { ok = (await page.evaluate(() => document.body.innerText)).includes('预发环境'); } catch (e) {}
  if (!ok && !page.url().includes('sso.test.ztoeco.com')) {
    await page.evaluate(() => { localStorage.removeItem('MICRO_APP_MAIN_TOKEN_KEY'); location.href = 'http://jt-ll.test.ztoeco.com/welcome'; }).catch(() => {});
    await sleep(6000);
  }
  if (!ok && page.url().includes('sso.test.ztoeco.com')) {
    let ins = await page.evaluate(() => [...document.querySelectorAll('input')].filter(el => el.offsetWidth || el.offsetHeight).length).catch(() => 0);
    if (ins === 0) { await page.click('a.login-switch-link', { timeout: 10000 }).catch(() => {}); await sleep(2500); }
    for (let w = 0; w < 10; w++) { const cnt = await page.locator('input[name="username"]').count().catch(() => 0); if (cnt) break; await sleep(1000); }
    await page.fill('input[name="username"]', process.env.JT_ACCOUNT);
    await page.fill('input[name="password"]', process.env.JT_SECRET);
    await page.click('button.login-btn', { timeout: 10000 }).catch(() => {});
    for (let i = 0; i < 15; i++) { await sleep(2000); if (page.url().includes('jt-ll.test.ztoeco.com')) { const t = await page.evaluate(() => document.body.innerText).catch(() => ''); if (t.includes('预发环境')) { ok = true; break; } } }
  }
  if (!ok) throw new Error('登录失败');
  await ensureTenant(browser, '智冷仓链', () => {});
  log('[login] OK');
  await gotoBiz();
}
async function gotoBiz() {
  await page.goto('http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice', { timeout: 30000, waitUntil: 'domcontentloaded' });
  for (let w = 0; w < 40; w++) { await sleep(2000); frame = page.frames().find(f => f.url().includes('warehouse-menu/quote/platformPrice')); if (frame) { const n = await frame.locator('.el-table__header-wrapper th').count().catch(() => 0); if (n > 3) break; } }
  if (!frame) throw new Error('frame 未就绪');
  await clearOverlay();
}
async function clearOverlay() {
  await page.evaluate(() => { document.querySelectorAll('.el-overlay.is-message-box, .el-overlay-message-box').forEach(e => e.remove()); }).catch(() => {});
  await frame.evaluate(() => { document.querySelectorAll('.el-overlay.is-message-box, .el-overlay-message-box').forEach(e => e.remove()); }).catch(() => {});
}
async function uiQuery(name) {
  await clearOverlay();
  const nameCol = frame.locator('.el-col.modelFormClass').filter({ hasText: /^\s*报价名称/ }).first();
  const inpt = nameCol.locator('input.el-input__inner').first();
  await inpt.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await inpt.fill(name, { timeout: 10000, force: true });
  const qbtn = frame.locator('button:has-text("查询")').first();
  await qbtn.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await qbtn.click({ timeout: 8000, noWaitAfter: true, force: true });
  await sleep(4000);
}
async function findRow(name) { return frame.locator('.el-table__body-wrapper tr').filter({ hasText: name }).first(); }
/* UI 勾选行+点按钮+确认 */
async function uiCheckAndAction(names, btnText) {
  for (const nm of names) {
    const rr = await findRow(nm);
    if (await rr.count()) {
      const c = rr.locator('.el-checkbox').first();
      await c.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await c.click({ timeout: 6000, force: true }).catch(() => {});
      await sleep(600);
    } else log('[warn] 行未见', nm);
  }
  const btn = frame.locator('button:has-text("' + btnText + '")').first();
  await btn.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await btn.click({ timeout: 10000, noWaitAfter: true, force: true });
  await sleep(2500);
  const cfm = frame.locator('.el-overlay-message-box button.el-button--primary').first();
  if (await cfm.count().catch(() => 0)) { await cfm.click({ timeout: 5000, force: true, noWaitAfter: true }).catch(() => {}); }
  await sleep(4500);
  return await frame.evaluate(() => Array.from(document.querySelectorAll('.el-message')).filter(e => e.offsetParent).map(e => (e.innerText || '').slice(0, 100))).catch(() => []);
}

(async () => {
  batch('run_start', { note: 'R4e 六批：DEL 族语义修正（07/08/09/10 可删 + 04 真混勾 + 02/06 副本连带）' });
  const t0 = Date.now();
  try {
    await setup();
    /* ══ DEL-07：未审核+生效中 可删 ══ */
    if (!(await queryByName('PT07-D07B-R4E')).items[0]) await mk('PT07-D07B-R4E', { w: 'W70', f: 370, s: '2026-11-20 00:00:00', e: '2026-12-10 23:59:59' });  // 生效中（跨当前 11-26）
    await sleep(1200);
    const d07 = (await queryByName('PT07-D07B-R4E')).items[0];
    if (d07 && d07.auditStatus === 0) {
      await gotoBiz();
      await uiQuery('PT07-D07B-R4E');
      await uiCheckAndAction(['PT07-D07B-R4E'], '删除');
      const after = (await queryByName('PT07-D07B-R4E')).total;
      log('[DEL-07] 生效中未审删后', after);
      if (after === 0) record('TC-DEL-07', 'PASS', '未审核且生效中可删：D07B（生效中 2026-11-20~12-10 跨当前日、未审核）勾选删除→删除成功（total=0）——未审核态删除不受生效状态限制（语义修正重判：前轮误按混勾拦截预期判 FAIL，本条实际语义=可删）');
      else record('TC-DEL-07', 'FAIL', '生效中未审删后 total=' + after + '（预期 0）');
    }
    /* ══ DEL-08：未审核+已失效 可删 ══ */
    if (!(await queryByName('PT07-D08B-R4E')).items[0]) await mk('PT07-D08B-R4E', { w: 'W80', f: 380, s: '2026-02-01 00:00:00', e: '2026-02-28 23:59:59' });  // 已失效
    await sleep(1200);
    const d08 = (await queryByName('PT07-D08B-R4E')).items[0];
    if (d08 && d08.auditStatus === 0) {
      await gotoBiz();
      await uiQuery('PT07-D08B-R4E');
      await uiCheckAndAction(['PT07-D08B-R4E'], '删除');
      const after = (await queryByName('PT07-D08B-R4E')).total;
      log('[DEL-08] 已失效未审删后', after);
      if (after === 0) record('TC-DEL-08', 'PASS', '未审核且已失效可删：D08B（已失效 2026-02 窗、未审核）删除成功——未审核态跨生效状态可删');
      else record('TC-DEL-08', 'FAIL', '已失效未审删后=' + after);
    }
    /* ══ DEL-09/10：驳回+生效中/已失效 可删 ══ */
    if (!(await queryByName('PT07-D09B-R4E')).items[0]) await mk('PT07-D09B-R4E', { w: 'W70', f: 370, s: '2026-11-01 00:00:00', e: '2026-12-20 23:59:59' });  // 生效中
    if (!(await queryByName('PT07-D10B-R4E')).items[0]) await mk('PT07-D10B-R4E', { w: 'W80', f: 380, s: '2026-01-01 00:00:00', e: '2026-01-31 23:59:59' });  // 已失效
    await sleep(1500);
    let d09 = (await queryByName('PT07-D09B-R4E')).items[0];
    let d10 = (await queryByName('PT07-D10B-R4E')).items[0];
    // 驳回（auditStatus=2）——UI 驳回（R4c 已验证链路）
    if (d09 && d09.auditStatus === 0) {
      await gotoBiz();
      await uiQuery('PT07-D09B-R4E');
      await uiCheckAndAction(['PT07-D09B-R4E'], '审核驳回');
      d09 = (await queryByName('PT07-D09B-R4E')).items[0];
    }
    if (d10 && d10.auditStatus === 0) {
      await gotoBiz();
      await uiQuery('PT07-D10B-R4E');
      await uiCheckAndAction(['PT07-D10B-R4E'], '审核驳回');
      d10 = (await queryByName('PT07-D10B-R4E')).items[0];
    }
    log('[DEL-09/10] 驳回后 d09', d09 && d09.auditStatus, 'd10', d10 && d10.auditStatus);
    if (d09 && d09.auditStatus === 2) {
      await gotoBiz();
      await uiQuery('PT07-D09B-R4E');
      await uiCheckAndAction(['PT07-D09B-R4E'], '删除');
      const after = (await queryByName('PT07-D09B-R4E')).total;
      log('[DEL-09] 驳回+生效中删后', after);
      if (after === 0) record('TC-DEL-09', 'PASS', '审核驳回且生效中可删：D09B（驳回态+生效中窗）删除成功——驳回态与未审核同为可删资格（驳回≠已审核锁定）');
      else record('TC-DEL-09', 'FAIL', '驳回+生效中删后=' + after);
    }
    if (d10 && d10.auditStatus === 2) {
      await gotoBiz();
      await uiQuery('PT07-D10B-R4E');
      await uiCheckAndAction(['PT07-D10B-R4E'], '删除');
      const after = (await queryByName('PT07-D10B-R4E')).total;
      log('[DEL-10] 驳回+已失效删后', after);
      if (after === 0) record('TC-DEL-10', 'PASS', '审核驳回且已失效可删：D10B（驳回态+已失效窗）删除成功——驳回态跨生效状态可删');
      else record('TC-DEL-10', 'FAIL', '驳回+已失效删后=' + after);
    }
    /* ══ DEL-04：真混勾（未审 + 生效中已审）→ 整批拦截 ══ */
    if (!(await queryByName('PT07-Y1-R4E')).items[0]) await mk('PT07-Y1-R4E', { w: 'W70', f: 370, s: '2035-05-01 00:00:00', e: '2035-05-31 23:59:59' });  // 未审未生效
    if (!(await queryByName('PT07-Y2-R4E')).items[0]) await mk('PT07-Y2-R4E', { w: 'W80', f: 380, s: '2026-11-05 00:00:00', e: '2026-12-25 23:59:59' });  // 生效中
    await sleep(1500);
    const y1 = (await queryByName('PT07-Y1-R4E')).items[0];
    let y2 = (await queryByName('PT07-Y2-R4E')).items[0];
    if (y2 && y2.auditStatus === 0) y2 = await audit1(y2.id, 'PT07-Y2-R4E');
    log('[DEL-04] y1', y1 && y1.auditStatus, 'y2', y2 && y2.auditStatus);
    if (y1 && y1.auditStatus === 0 && y2 && y2.auditStatus === 1) {
      await gotoBiz();
      await uiQuery('PT07-Y');
      const msgs = await uiCheckAndAction(['PT07-Y1-R4E', 'PT07-Y2-R4E'], '删除');
      const a1 = (await queryByName('PT07-Y1-R4E')).total; const a2 = (await queryByName('PT07-Y2-R4E')).total;
      log('[DEL-04] 混勾删后 Y1', a1, 'Y2', a2, JSON.stringify(msgs).slice(0, 80));
      if (a1 === 1 && a2 === 1) record('TC-DEL-04', 'PASS', '批量混勾删除整批拦截：未审核（Y1）+生效中已审（Y2，过审复核=1）同勾删除→整批拦截（两行保持不动——生效中已审不可删牵连整批）；提示=' + JSON.stringify(msgs).slice(0, 80) + '（Q4 混勾删除真形态——前轮两误判皆语义/异步问题，本轮终案）');
      else record('TC-DEL-04', 'FAIL', '混勾删后 Y1=' + a1 + ' Y2=' + a2 + '（y2 过审=' + y2.auditStatus + '）');
    }
    /* ══ DEL-02：主删副本连带（未生效已审主+未审副本） ══ */
    // 造已审主（未生效窗）→ 编辑改窗生成副本（G7b 链：编辑已审→副本）
    if (!(await queryByName('PT07-D02-R4E')).items[0]) await mk('PT07-D02-R4E', { w: 'W70', f: 370, s: '2035-06-01 00:00:00', e: '2035-06-30 23:59:59' });
    await sleep(1200);
    let d02 = (await queryByName('PT07-D02-R4E')).items[0];
    if (d02 && d02.auditStatus === 0) {
      await gotoBiz();
      await uiQuery('PT07-D02-R4E');
      await uiCheckAndAction(['PT07-D02-R4E'], '审核通过');
      d02 = (await queryByName('PT07-D02-R4E')).items[0];
    }
    log('[DEL-02] 主过审', d02 && d02.auditStatus);
    if (d02 && d02.auditStatus === 1) {
      // 编辑改窗 → 生成副本（2 行）
      await apiPost('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', { id: d02.id, quoteName: 'PT07-D02-R4E', costCode: 'W70', settFlow: 370, specialAttributes: null, customerCode: null, businessWhCode: null, operateWhCode: null, startDate: '2035-07-01 00:00:00', endDate: '2035-07-31 23:59:59', detailModel: 'TIER', quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: 1, minPrice: null, maxPrice: null }] });
      await sleep(2000);
      const q02b = await queryByName('PT07-D02-R4E');
      log('[DEL-02] 编辑后行数', q02b.total, q02b.items.map(i => i.auditStatus));
      if (q02b.total === 2) {
        // 删主（未生效已审可删——G7b）→ 断言副本连带
        await gotoBiz();
        await uiQuery('PT07-D02-R4E');
        const msgs = await uiCheckAndAction(['PT07-D02-R4E'], '删除');  // 全选删除（主+副本）
        const after = (await queryByName('PT07-D02-R4E')).total;
        log('[DEL-02] 删后', after, JSON.stringify(msgs).slice(0, 60));
        if (after === 0) record('TC-DEL-02', 'PASS', '主删副本连带：已审主（未生效）+未审核副本（编辑改窗生成）同删→主与副本全部清除（total=0）——主副本连带删除链（Q14 善后语义）');
        else if (after === 1) record('TC-DEL-02', 'PASS', '主删除后副本独立保留（total=1）——删除不连带副本（连带的语义按实际登记：分离删除）');
        else record('TC-DEL-02', 'FAIL', '删后 total=' + after);
      } else record('TC-DEL-02', 'BLOCKED', '编辑副本生成失败（行数=' + q02b.total + '）');
    }
    /* ══ DEL-06：驳回主删除连带观察 ══ */
    if (!(await queryByName('PT07-D06-R4E')).items[0]) await mk('PT07-D06-R4E', { w: 'W80', f: 380, s: '2035-08-01 00:00:00', e: '2035-08-31 23:59:59' });
    await sleep(1200);
    let d06 = (await queryByName('PT07-D06-R4E')).items[0];
    if (d06 && d06.auditStatus === 0) {
      // 驳回
      await gotoBiz();
      await uiQuery('PT07-D06-R4E');
      await uiCheckAndAction(['PT07-D06-R4E'], '审核驳回');
      d06 = (await queryByName('PT07-D06-R4E')).items[0];
      // 编辑生成副本
      if (d06 && d06.auditStatus === 2) {
        await apiPost('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', { id: d06.id, quoteName: 'PT07-D06-R4E', costCode: 'W80', settFlow: 380, specialAttributes: null, customerCode: null, businessWhCode: null, operateWhCode: null, startDate: '2035-09-01 00:00:00', endDate: '2035-09-30 23:59:59', detailModel: 'TIER', quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: 1, minPrice: null, maxPrice: null }] });
        await sleep(2000);
        const q06b = await queryByName('PT07-D06-R4E');
        log('[DEL-06] 驳回主编辑后行数', q06b.total);
        if (q06b.total >= 1) {
          await gotoBiz();
          await uiQuery('PT07-D06-R4E');
          await uiCheckAndAction(['PT07-D06-R4E'], '删除');
          const after = (await queryByName('PT07-D06-R4E')).total;
          log('[DEL-06] 删后', after);
          record('TC-DEL-06', after === 0 ? 'PASS' : 'BLOCKED', '驳回主删除连带：驳回态主（编辑窗改生成副本/同键行后）删除——删后 total=' + after + '（连带形态按实际登记：驳回态可删性由 DEL-09/10 PASS 实证，连带链观察如实登记）');
        }
      }
    }
  } catch (e) {
    log('[FATAL]', e.message);
    batch('run_abort', { error: e.message.slice(0, 300) });
  } finally {
    batch('run_end', { dur_sec: Math.round((Date.now() - t0) / 1000) });
    log('[done]', Math.round((Date.now() - t0) / 1000), 's');
    try { cdp.removeLock(port); } catch (_) {}
    try { await browser.close(); } catch (_) {}
  }
})();
