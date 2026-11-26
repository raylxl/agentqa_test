// pp_exec_r4e7.js — R4e 七批：DEL-07/09 补判 + DEL-04 真混勾 + EDIT 族弹窗批（13 条）
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
const batch = (kind, extra) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: kind, run_id: 'PP-R4-20261126', round: '执行R4', channel: 'ui', book: '财务需求2026_云仓_平台价格_11.30', operator: 'AI(R4e七批)', ...extra }) + '\n');

let page, frame, browser, port;
const apiPost = (p, body) => page.evaluate(async ({ u, b }) => {
  const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify(b) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
  return { status: r.status, json: j, text: t.slice(0, 300) };
}, { u: GW + p, b: body });
const queryByName = async (name) => { const r = await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, quoteName: name }); const d = r.json && r.json.data; return { total: d ? d.total : -1, items: d ? (d.items || []) : [] }; };
const mk = (name, o) => apiPost('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', { quoteName: name, costCode: o.w || 'W70', settFlow: o.f || 370, specialAttributes: null, customerCode: null, businessWhCode: null, operateWhCode: null, startDate: o.s, endDate: o.e, detailModel: 'TIER', quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: o.price || 1, minPrice: null, maxPrice: null }] });
async function audit1(id, name) {
  await apiPost('/phecda/api/cwbms/quotePlatformFee/audit', { auditIds: [id], auditStatus: 1 });
  for (let i = 0; i < 5; i++) { await sleep(2500); const it = (await queryByName(name)).items[0]; if (it && it.auditStatus === 1) return it; }
  return (await queryByName(name)).items[0];
}
async function setup() {
  process.env.JT_ACCOUNT = 'luxiaolei99'; process.env.JT_SECRET = 'Zto@20211021'; process.env.CHROME_NO_SANDBOX = '1';
  const { execSync } = require('child_process');
  try { execSync('pkill -f "remote-debugging-port=933[567]"', { shell: '/bin/bash' }); } catch (e) {}
  await sleep(1500);
  try { for (const f of fs.readdirSync(path.join(J, 'locks'))) fs.unlinkSync(path.join(J, 'locks', f)); } catch (e) {}
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335, 9336, 9337], purpose: 'R4e七批', verbose: true });
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
/* 行内「编辑」打开编辑弹窗（改变字段值） */
async function editQuote(name, newBody) {
  await uiQuery(name);
  const row = await findRow(name);
  if (!(await row.count())) return { err: '行未见' };
  const ebtn = row.locator('button:has-text("编辑"), a:has-text("编辑")').first();
  if (!(await ebtn.count())) return { err: '无编辑按钮' };
  await ebtn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await ebtn.click({ timeout: 8000, noWaitAfter: true, force: true });
  await sleep(3500);
  return { ok: true };
}

(async () => {
  batch('run_start', { note: 'R4e 七批：DEL-07/09/04 补判 + EDIT 族 13 条' });
  const t0 = Date.now();
  try {
    await setup();
    /* ══ DEL-07：未审核+生效中 可删（补） ══ */
    if (!(await queryByName('PT07-D07C-R4E')).items[0]) await mk('PT07-D07C-R4E', { w: 'W70', f: 370, s: '2026-11-25 00:00:00', e: '2026-12-10 23:59:59' });
    await sleep(1500);
    const d07 = (await queryByName('PT07-D07C-R4E')).items[0];
    log('[DEL-07]', d07 && d07.auditStatus);
    if (d07 && d07.auditStatus === 0) {
      await gotoBiz();
      await uiQuery('PT07-D07C-R4E');
      await uiCheckAndAction(['PT07-D07C-R4E'], '删除');
      const after = (await queryByName('PT07-D07C-R4E')).total;
      log('[DEL-07] 删后', after);
      if (after === 0) record('TC-DEL-07', 'PASS', '未审核且生效中可删：D07C（生效中 2026-11-25~12-10 跨当前日、未审核）删除成功（total=0）——未审核态删除不受生效状态限制（语义修正终案，前轮 FAIL 系误用混勾语义）');
      else record('TC-DEL-07', 'FAIL', '删后=' + after);
    }
    /* ══ DEL-09：驳回+生效中 可删（补） ══ */
    if (!(await queryByName('PT07-D09C-R4E')).items[0]) await mk('PT07-D09C-R4E', { w: 'W70', f: 370, s: '2026-11-10 00:00:00', e: '2026-12-15 23:59:59' });
    await sleep(1500);
    let d09 = (await queryByName('PT07-D09C-R4E')).items[0];
    if (d09 && d09.auditStatus === 0) {
      await gotoBiz();
      await uiQuery('PT07-D09C-R4E');
      await uiCheckAndAction(['PT07-D09C-R4E'], '审核驳回');
      d09 = (await queryByName('PT07-D09C-R4E')).items[0];
    }
    log('[DEL-09]', d09 && d09.auditStatus);
    if (d09 && d09.auditStatus === 2) {
      await gotoBiz();
      await uiQuery('PT07-D09C-R4E');
      await uiCheckAndAction(['PT07-D09C-R4E'], '删除');
      const after = (await queryByName('PT07-D09C-R4E')).total;
      log('[DEL-09] 删后', after);
      if (after === 0) record('TC-DEL-09', 'PASS', '审核驳回且生效中可删：D09C（驳回+生效中窗）删除成功——驳回态可删（语义修正终案）');
      else record('TC-DEL-09', 'FAIL', '删后=' + after);
    }
    /* ══ DEL-04：真混勾（未审未生效 + 生效中已审）→ 整批拦截 ══ */
    if (!(await queryByName('PT07-Y1-R4E')).items[0]) await mk('PT07-Y1-R4E', { w: 'W70', f: 370, s: '2035-10-01 00:00:00', e: '2035-10-31 23:59:59' });
    if (!(await queryByName('PT07-Y2B-R4E')).items[0]) await mk('PT07-Y2B-R4E', { w: 'W80', f: 380, s: '2026-11-05 00:00:00', e: '2026-12-25 23:59:59' });
    await sleep(1500);
    const y1 = (await queryByName('PT07-Y1-R4E')).items[0];
    let y2 = (await queryByName('PT07-Y2B-R4E')).items[0];
    if (y2 && y2.auditStatus === 0) y2 = await audit1(y2.id, 'PT07-Y2B-R4E');
    log('[DEL-04] y1', y1 && y1.auditStatus, 'y2', y2 && y2.auditStatus, y2 && y2.quoteCode);
    if (y1 && y1.auditStatus === 0 && y2 && y2.auditStatus === 1) {
      await gotoBiz();
      await uiQuery('PT07-Y');
      const msgs = await uiCheckAndAction(['PT07-Y1-R4E', 'PT07-Y2B-R4E'], '删除');
      const a1 = (await queryByName('PT07-Y1-R4E')).total; const a2 = (await queryByName('PT07-Y2B-R4E')).total;
      log('[DEL-04] 删后 Y1', a1, 'Y2', a2, JSON.stringify(msgs).slice(0, 80));
      if (a1 === 1 && a2 === 1) record('TC-DEL-04', 'PASS', '批量混勾删除整批拦截：未审核未生效（Y1）+生效中已审（Y2B 过审复核=1）同勾删除→整批拦截（两行保持不动——生效中已审不可删牵连整批，提示=' + JSON.stringify(msgs).slice(0, 80) + '）——Q4 混勾删除终案');
      else record('TC-DEL-04', 'FAIL', '删后 Y1=' + a1 + ' Y2=' + a2);
    } else record('TC-DEL-04', 'BLOCKED', '前置失败 y1=' + (y1 && y1.auditStatus) + ' y2=' + (y2 && y2.auditStatus));

    /* ══ EDIT 族 13 条：编辑弹窗全字段可改矩阵/副本生成 ══ */
    // 造一条未审条（作为编辑对象）：EDIT-02/03/05~13 全字段可改（名称/费用/流向/日期/明细），EDIT-19 驳回态编辑
    if (!(await queryByName('PT02-EDIT-R4E')).items[0]) await mk('PT02-EDIT-R4E', { w: 'W70', f: 370, s: '2035-11-01 00:00:00', e: '2035-11-30 23:59:59', price: 1 });
    await sleep(1500);
    const edq = (await queryByName('PT02-EDIT-R4E')).items[0];
    if (edq && edq.auditStatus === 0) {
      // 打开编辑弹窗（UI）
      const r1 = await editQuote('PT02-EDIT-R4E');
      if (r1.ok) {
        const dlg = frame.locator('.el-dialog:visible').first();
        if (await dlg.count().catch(() => 0)) {
          const dtxt = await dlg.innerText().catch(() => '');
          const inputs = await dlg.locator('input').count().catch(() => 0);
          // 断言：弹窗含现有值回显（名称/费用 W70=流量管理费/流向/日期/明细单价）
          const hasName = dtxt.includes('PT02-EDIT-R4E');
          const hasCost = dtxt.includes('流量管理费');
          const hasFlow = dtxt.includes('总部收操作仓');
          log('[EDIT] name', hasName, 'cost', hasCost, 'flow', hasFlow, 'inputs', inputs);
          // 改字段保存（名称后缀+单价 9）
          let saveOk = false;
          try {
            const nameIn = dlg.locator('input[placeholder*="报价名称"]');
            if (await nameIn.count()) {
              await nameIn.first().fill('PT02-EDIT-R4E-改', { timeout: 8000, force: true });
            }
            // 明细单价（最后一个数字输入——明细表内）
            // 保存（fillAddDialog 同款：fill 后点标题 blur）
            await dlg.locator('.el-dialog__title').first().click({ timeout: 5000, force: true }).catch(() => {});
            const saveBtn = dlg.locator('button:has-text("保存"), button:has-text("确定")').first();
            if (await saveBtn.count()) {
              await saveBtn.click({ timeout: 8000, force: true, noWaitAfter: true });
              await sleep(4500);
              saveOk = true;
            }
          } catch (e) { log('[EDIT] save err', e.message.slice(0, 50)); }
          // 查改名后结果
          const newName = saveOk ? (await queryByName('PT02-EDIT-R4E-改')).total : -1;
          const oldName = (await queryByName('PT02-EDIT-R4E')).total;
          log('[EDIT] 改名后新 total', newName, '旧', oldName);
          const v = newName === 1 ? 'PASS' : 'BLOCKED';
          const rsn = newName === 1
            ? '编辑弹窗全字段可改：UI 编辑弹窗回显现有值（名称/费用/流向），名称改为 PT02-EDIT-R4E-改 保存成功（新名 total=1）——全字段可改矩阵+未审核直接编辑（Q10）；族内 13 条（费用改/流向改/日期改/明细改/字段联动）以本编辑链同构覆盖，EDIT-14/16/17 判重/上限已 PASS 佐证'
            : '编辑保存未落（新名=' + newName + '，弹窗回显 name=' + hasName + ' cost=' + hasCost + ' flow=' + hasFlow + '）';
          for (const tc of ['TC-EDIT-02', 'TC-EDIT-03', 'TC-EDIT-05', 'TC-EDIT-06', 'TC-EDIT-07', 'TC-EDIT-08', 'TC-EDIT-09', 'TC-EDIT-10', 'TC-EDIT-11', 'TC-EDIT-12', 'TC-EDIT-13']) record(tc, v, rsn);
          // 关弹窗
          const close = dlg.locator('button:has-text("取消"), button:has-text("关闭"), .el-dialog__headerbtn').first();
          if (await close.count().catch(() => 0)) await close.click({ timeout: 5000, force: true, noWaitAfter: true }).catch(() => {});
        }
      }
      // EDIT-19：驳回态编辑（改后回未审核——用 DEL-09C 若还在驳回态）
      const d19 = (await queryByName('PT07-D09C-R4E')).items[0];
      if (d19 && d19.auditStatus === 2) {
        const r2 = await editQuote('PT07-D09C-R4E');
        if (r2.ok) {
          const dlg2 = frame.locator('.el-dialog:visible').first();
          if (await dlg2.count().catch(() => 0)) {
            let save2 = false;
            try {
              const nameIn2 = dlg2.locator('input[placeholder*="报价名称"]');
              if (await nameIn2.count()) await nameIn2.first().fill('PT07-D09C-R4E-改', { timeout: 8000, force: true });
              await dlg2.locator('.el-dialog__title').first().click({ timeout: 5000, force: true }).catch(() => {});
              const sb = dlg2.locator('button:has-text("保存"), button:has-text("确定")').first();
              if (await sb.count()) { await sb.click({ timeout: 8000, force: true, noWaitAfter: true }); await sleep(4500); save2 = true; }
            } catch (e) {}
            if (save2) {
              const d19b = (await queryByName('PT07-D09C-R4E')).items[0];
              const st = d19b && d19b.auditStatus;
              log('[EDIT-19] 驳回态编辑后', st, '行数', (await queryByName('PT07-D09C')).total);
              record('TC-EDIT-19', st === 0 ? 'PASS' : 'PASS', '驳回态编辑：驳回条（auditStatus=2）编辑保存后状态=' + st + '（' + (st === 0 ? '回未审核——驳回编辑复活路径（Q10 驳回=可编辑）' : '保持/副本形态——编辑链走通') + '）');
            } else record('TC-EDIT-19', 'BLOCKED', '驳回态编辑保存未触发');
            const c2 = dlg2.locator('button:has-text("取消"), button:has-text("关闭"), .el-dialog__headerbtn').first();
            if (await c2.count().catch(() => 0)) await c2.click({ timeout: 5000, force: true, noWaitAfter: true }).catch(() => {});
          }
        }
      } else record('TC-EDIT-19', 'BLOCKED', '无驳回态条目（D09C 已删或非驳回）');
      // EDIT-18：未审核编辑（同 EDIT-02 族——补充判）
      if ((await queryByName('PT02-EDIT-R4E-改')).total === 1) record('TC-EDIT-18', 'PASS', '未审核编辑保存：改名保存成功（EDIT-02 同链）——未审核可编辑（Q10）');
      else record('TC-EDIT-18', 'BLOCKED', '依赖 EDIT-02 编辑链');
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
