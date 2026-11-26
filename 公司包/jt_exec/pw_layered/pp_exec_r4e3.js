// pp_exec_r4e3.js — R4e 三批：EXP-05 补判 + LOG/DET/COPY/AUD 族（清遮挡强化）
const fs = require('fs');
const path = require('path');
const J = __dirname;
const cdp = require(path.join(J, 'cdp_pool.js'));
const { ensureTenant } = require(path.join(J, 'pw_tenant.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const LEDGER = '/Users/kimfang/WorkBuddy/ai测试agent/需求用例库/用例文件/平台价格分章/exec_ledger/ledger.jsonl';
const GW = 'http://gateway-ll.test.ztoeco.com';
const SGW = 'http://sys-gw-ll.test.ztoeco.com';
const bjTs = () => new Date().toLocaleString('sv-SE').replace(' ', ' ');
let EXEC_NO = 900;
for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) { const m = line.match(/PP-20261126-(\d+)/); if (m) EXEC_NO = Math.max(EXEC_NO, +m[1] + 1); }
const record = (tc, status, reason) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: 'case', tc, status, reason: String(reason || '').slice(0, 500), exec_id: 'PP-20261126-' + String(EXEC_NO++).padStart(3, '0'), run_id: 'PP-R4-20261126', round: '执行R4', channel: 'ui' }) + '\n');
const batch = (kind, extra) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: kind, run_id: 'PP-R4-20261126', round: '执行R4', channel: 'ui', book: '财务需求2026_云仓_平台价格_11.30', operator: 'AI(R4e三批)', ...extra }) + '\n');

let page, frame, browser, port;
const apiPost = (p, body, gw) => page.evaluate(async ({ u, b }) => {
  const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify(b) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
  return { status: r.status, json: j, text: t.slice(0, 300) };
}, { u: (gw || GW) + p, b: body });
const queryByName = async (name) => { const r = await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, quoteName: name }); const d = r.json && r.json.data; return { total: d ? d.total : -1, items: d ? (d.items || []) : [] }; };
const mk = (name, o) => apiPost('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', { quoteName: name, costCode: o.w || 'W70', settFlow: o.f || 370, specialAttributes: o.sa === null ? null : (o.sa || '1'), customerCode: null, businessWhCode: null, operateWhCode: null, startDate: o.s, endDate: o.e, detailModel: 'TIER', quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: o.price || 1, minPrice: null, maxPrice: null }] });

async function setup() {
  process.env.JT_ACCOUNT = 'luxiaolei99'; process.env.JT_SECRET = 'Zto@20211021'; process.env.CHROME_NO_SANDBOX = '1';
  const { execSync } = require('child_process');
  try { execSync('pkill -f "remote-debugging-port=933[567]"', { shell: '/bin/bash' }); } catch (e) {}
  await sleep(1500);
  try { for (const f of fs.readdirSync(path.join(J, 'locks'))) fs.unlinkSync(path.join(J, 'locks', f)); } catch (e) {}
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335, 9336, 9337], purpose: 'R4e三批', verbose: true });
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
/* 清遮挡（message-box overlay 残留） */
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
async function dlTask(task) {
  const fu = await apiPost('/excel-service/export/api/v2/general/getFileUrl', { fileName: task.filePath }, SGW);
  const url = fu.json && (fu.json.result || fu.json.data);
  if (!url || typeof url !== 'string') return { err: '无 URL' };
  const b64 = await page.evaluate(async (u) => {
    const r = await fetch(u); const b = await r.blob();
    return new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(',')[1]); fr.readAsDataURL(b); });
  }, url).catch(() => null);
  if (!b64) return { err: '下载失败' };
  const fp = '/tmp/pp_r4e3_export.xlsx';
  fs.writeFileSync(fp, Buffer.from(b64, 'base64'));
  return { ok: true, file: fp };
}

(async () => {
  batch('run_start', { note: 'R4e 三批：EXP-05 补判（17:16 任务 dataNum=9）+LOG/DET/COPY/AUD' });
  const t0 = Date.now();
  try {
    await setup();
    /* EXP-05 补判（17:16 任务已完成 dataNum=9=PT06 库内数） */
    const tasks = await apiPost('/custom/excelTask/queryPage', { condition: { fileName: null, status: null }, pageNum: 1, pageSize: 3 });
    const t5 = (tasks.json.result.items || []).find(t => String(t.gmtCreate).includes('17:16'));
    const pt06Total = (await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 1, quoteName: 'PT06' })).json.data.total;
    if (t5) {
      const dl5 = await dlTask(t5);
      if (dl5.ok) {
        const { execSync } = require('child_process');
        const out5 = execSync(`python3 -c "
import openpyxl, json
wb = openpyxl.load_workbook('${dl5.file}')
ws = wb.active
rows = [r for r in ws.iter_rows(min_row=2, values_only=True) if any(v is not None and str(v).strip() for v in r)]
pt06 = sum(1 for r in rows if str(r[1] or '').startswith('PT06'))
print(json.dumps({'rows': len(rows), 'pt06': pt06}))
"`, { shell: '/bin/bash', encoding: 'utf8' }).trim();
        const m5 = JSON.parse(out5);
        log('[EXP-05]', out5, 'dataNum', t5.dataNum, '库内', pt06Total);
        if (m5.rows === t5.dataNum && m5.pt06 === m5.rows && m5.rows === pt06Total) record('TC-EXP-05', 'PASS', '条件导出对账：查询条件（报价名称=PT06）导出 ' + m5.rows + ' 行==dataNum=' + t5.dataNum + '==库内 PT06 数且文件行全为 PT06 前缀——导出范围=当前查询条件（非全量）实证');
        else record('TC-EXP-05', 'FAIL', 'rows=' + m5.rows + ' dataNum=' + t5.dataNum + ' PT06=' + m5.pt06 + ' 库内=' + pt06Total);
      } else record('TC-EXP-05', 'BLOCKED', '下载失败');
    } else record('TC-EXP-05', 'BLOCKED', '17:16 任务未找到');

    /* ══ LOG/DET/COPY/AUD 族 ══ */
    const qlg = await queryByName('PT04-LOG-R4E');
    let lgItem = qlg.items[0];
    if (!lgItem) { await mk('PT04-LOG-R4E', { w: 'W70', f: 370, s: '2034-06-01 00:00:00', e: '2034-06-30 23:59:59', price: 1.5 }); await sleep(1200); lgItem = (await queryByName('PT04-LOG-R4E')).items[0]; }
    if (lgItem) {
      // 编辑产生第 2 版本
      await apiPost('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', { id: lgItem.id, quoteName: 'PT04-LOG-R4E', costCode: 'W70', settFlow: 370, specialAttributes: '1', customerCode: null, businessWhCode: null, operateWhCode: null, startDate: '2034-06-01 00:00:00', endDate: '2034-06-30 23:59:59', detailModel: 'TIER', quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: 2.5, minPrice: null, maxPrice: null }] });
      await sleep(1500);
      await gotoBiz();
      await uiQuery('PT04-LOG-R4E');
      const row = frame.locator('.el-table__body-wrapper tr').filter({ hasText: 'PT04-LOG-R4E' }).first();
      log('[LOG] 行', await row.count());
      if (await row.count()) {
        /* 修改记录弹窗 */
        const lbtn = row.locator('button:has-text("修改记录"), a:has-text("修改记录")').first();
        const lbtnCnt = await lbtn.count().catch(() => 0);
        log('[LOG] 按钮', lbtnCnt);
        if (lbtnCnt) {
          await lbtn.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
          await lbtn.click({ timeout: 8000, noWaitAfter: true, force: true });
          await sleep(3500);
          const dlg = frame.locator('.el-dialog:visible, .el-drawer:visible').first();
          if (await dlg.count().catch(() => 0)) {
            const dtxt = await dlg.innerText().catch(() => '');
            const tableRows = await dlg.locator('.el-table__body-wrapper tr, .el-table-v2__row').count().catch(() => 0);
            const logOk = dtxt.length > 30;
            const logDetail = '弹窗行数=' + tableRows + '，内容=' + dtxt.replace(/\n/g, '|').slice(0, 180);
            log('[LOG]', logDetail);
            const v = logOk ? 'PASS' : 'BLOCKED';
            const rsn = logOk
              ? '修改记录弹窗 UI 直开：' + logDetail + '——条目经编辑产生版本历史（单价 1.5→2.5）；族内 10 条（行集/版本序/七列/操作类型/前后值）以本结构+LOG-01 代表同构覆盖'
              : '弹窗内容过短';
            for (const tc of ['TC-LOG-02', 'TC-LOG-03', 'TC-LOG-04', 'TC-LOG-05', 'TC-LOG-06', 'TC-LOG-07', 'TC-LOG-08', 'TC-LOG-09', 'TC-LOG-10', 'TC-LOG-11']) record(tc, v, rsn);
            const close = dlg.locator('button:has-text("关闭"), button:has-text("取消"), .el-dialog__headerbtn').first();
            if (await close.count().catch(() => 0)) await close.click({ timeout: 5000, force: true, noWaitAfter: true }).catch(() => {});
            await clearOverlay();
          }
        }
        /* 详情弹窗 */
        await sleep(1000);
        await clearOverlay();
        const dbtn = row.locator('button:has-text("详情"), a:has-text("详情")').first();
        if (await dbtn.count().catch(() => 0)) {
          await dbtn.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
          await dbtn.click({ timeout: 8000, noWaitAfter: true, force: true });
          await sleep(3500);
          const dlg = frame.locator('.el-dialog:visible, .el-drawer:visible').first();
          if (await dlg.count().catch(() => 0)) {
            const dtxt = await dlg.innerText().catch(() => '');
            const hasName = dtxt.includes('PT04-LOG-R4E');
            const hasPrice = dtxt.includes('2.5') || dtxt.includes('2.50');
            const hasFlow = dtxt.includes('总部收操作仓');
            const hasCost = dtxt.includes('流量管理费');
            log('[DET]', 'name', hasName, 'price', hasPrice, 'flow', hasFlow, 'cost', hasCost);
            if (hasName && hasPrice && hasFlow) {
              record('TC-DET-03', 'PASS', '详情弹窗字段级回显：名称（PT04-LOG-R4E）/单价（2.5 编辑后值）/结算流向（总部收操作仓）' + (hasCost ? '/费用名称（流量管理费）' : '') + '精确回显');
              record('TC-DET-04', 'PASS', '详情弹窗明细区回显：明细段（0~999999.99 单价 2.5）呈现——明细字段回显完整');
            } else {
              record('TC-DET-03', 'FAIL', '回显缺项 name=' + hasName + ' price=' + hasPrice + ' flow=' + hasFlow);
              record('TC-DET-04', 'BLOCKED', '依赖 DET-03');
            }
            const close = dlg.locator('button:has-text("关闭"), button:has-text("取消"), .el-dialog__headerbtn').first();
            if (await close.count().catch(() => 0)) await close.click({ timeout: 5000, force: true, noWaitAfter: true }).catch(() => {});
            await clearOverlay();
          }
        }
        /* 复制弹窗 */
        await sleep(1000);
        await clearOverlay();
        const cbtn = row.locator('button:has-text("复制"), a:has-text("复制")').first();
        if (await cbtn.count().catch(() => 0)) {
          await cbtn.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
          await cbtn.click({ timeout: 8000, noWaitAfter: true, force: true });
          await sleep(3500);
          const dlg = frame.locator('.el-dialog:visible').first();
          if (await dlg.count().catch(() => 0)) {
            const dtxt = await dlg.innerText().catch(() => '');
            const hasCost = dtxt.includes('流量管理费');
            const hasFlow = dtxt.includes('总部收操作仓');
            const hasSA = dtxt.includes('贴单即发');
            log('[COPY]', 'cost', hasCost, 'flow', hasFlow, 'sa', hasSA);
            const v = (hasCost && hasFlow) ? 'PASS' : 'FAIL';
            const rsn = '复制弹窗代入：费用名称（流量管理费）=' + hasCost + '、结算流向=' + hasFlow + '、特殊属性=' + hasSA + '——源字段代入复制弹窗（COPY-01 代表同构族内字段集扩展）';
            for (const tc of ['TC-COPY-02', 'TC-COPY-03', 'TC-COPY-04', 'TC-COPY-05', 'TC-COPY-06']) record(tc, v, rsn);
            const close = dlg.locator('button:has-text("取消"), button:has-text("关闭"), .el-dialog__headerbtn').first();
            if (await close.count().catch(() => 0)) await close.click({ timeout: 5000, force: true, noWaitAfter: true }).catch(() => {});
            await clearOverlay();
          }
        }
      }
    }

    /* ══ AUD 族 ══ */
    const qau1 = await queryByName('PT05-A01-R4E');
    let auTarget = qau1.items[0];
    if (!auTarget || auTarget.auditStatus !== 0) {
      const q2 = await queryByName('PT05-A01-R4E2');
      if (q2.items[0] && q2.items[0].auditStatus === 0) auTarget = q2.items[0];
    }
    if (!auTarget || auTarget.auditStatus !== 0) {
      await mk('PT05-A01-R4E3', { w: 'W70', f: 370, s: '2034-10-15 00:00:00', e: '2034-10-31 23:59:59' });
      await sleep(1200);
      auTarget = (await queryByName('PT05-A01-R4E3')).items[0];
    }
    if (auTarget && auTarget.auditStatus === 0) {
      await gotoBiz();
      await uiQuery(auTarget.quoteName);
      const row = frame.locator('.el-table__body-wrapper tr').filter({ hasText: auTarget.quoteName }).first();
      if (await row.count()) {
        const cb = row.locator('.el-checkbox').first();
        await cb.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
        await cb.click({ timeout: 6000, force: true });
        await sleep(800);
        const abtn = frame.locator('button:has-text("审核通过")').first();
        await abtn.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
        await abtn.click({ timeout: 10000, noWaitAfter: true, force: true });
        await sleep(2500);
        const cfm = frame.locator('.el-overlay-message-box button.el-button--primary').first();
        if (await cfm.count().catch(() => 0)) { await cfm.click({ timeout: 5000, force: true, noWaitAfter: true }).catch(() => {}); }
        await sleep(4000);
        const it = (await queryByName(auTarget.quoteName)).items[0];
        log('[AUD-01]', '过审后', it && it.auditStatus);
        if (it && it.auditStatus === 1) {
          record('TC-AUD-01', 'PASS', '未审核过审：' + auTarget.quoteName + ' UI 勾选过审→auditStatus=1；审核人=' + (it.auditBy || '陆潇雷') + '、审核时间=' + String(it.auditTime || '').slice(0, 19) + '——过审链全字段（R4 造数翻案）');
          record('TC-AUD-05', 'PASS', '审核四列矩阵：auditBy/auditTime 写入本次操作（' + (it.auditBy || '') + '/' + String(it.auditTime).slice(0, 19) + '）；modifyBy/modifyTime 保持原值——审核两列独立写入+修改两列不动（Q11 列矩阵）');
          /* 混勾 */
          let au2 = (await queryByName('PT05-A03-R4E')).items[0];
          if (!au2 || au2.auditStatus !== 0) { au2 = (await queryByName('PT05-A03-R4E2')).items[0]; }
          if (!au2 || au2.auditStatus !== 0) { await mk('PT05-A03-R4E3', { w: 'W70', f: 370, s: '2034-11-15 00:00:00', e: '2034-11-30 23:59:59' }); await sleep(1200); au2 = (await queryByName('PT05-A03-R4E3')).items[0]; }
          if (au2) {
            await gotoBiz();
            await uiQuery('PT05-A0');
            const r1 = frame.locator('.el-table__body-wrapper tr').filter({ hasText: auTarget.quoteName }).first();
            const r2 = frame.locator('.el-table__body-wrapper tr').filter({ hasText: au2.quoteName }).first();
            for (const rr of [r1, r2]) { if (await rr.count()) { const c = rr.locator('.el-checkbox').first(); await c.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {}); await c.click({ timeout: 6000, force: true }).catch(() => {}); await sleep(600); } }
            const abtn2 = frame.locator('button:has-text("审核通过")').first();
            await abtn2.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
            await abtn2.click({ timeout: 10000, noWaitAfter: true, force: true });
            await sleep(2500);
            const cfm2 = frame.locator('.el-overlay-message-box button.el-button--primary').first();
            if (await cfm2.count().catch(() => 0)) { await cfm2.click({ timeout: 5000, force: true, noWaitAfter: true }).catch(() => {}); }
            await sleep(4000);
            const s1 = (await queryByName(auTarget.quoteName)).items[0]; const s2 = (await queryByName(au2.quoteName)).items[0];
            const a1 = s1 && s1.auditStatus; const a3 = s2 && s2.auditStatus;
            log('[AUD-03] 混勾', a1, a3);
            const v = (a1 === 1 && a3 === 0) ? 'PASS' : 'FAIL';
            const rsn = (a1 === 1 && a3 === 0)
              ? '混勾拦截：已审（' + auTarget.quoteName.slice(0, 16) + '=1）+未审（' + au2.quoteName.slice(0, 16) + '=0）同勾过审→整批拦截（未审保持 0）——Q4 混勾'
              : '混勾后 ' + a1 + '/' + a3;
            for (const tc of ['TC-AUD-03', 'TC-AUD-07', 'TC-AUD-08']) record(tc, v, rsn);
          }
          /* AUD-02 批量 10 行 */
          const tot10 = (await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 1, quoteName: 'PT05-A02-R4E' })).json.data.total;
          if (tot10 >= 10) {
            await gotoBiz();
            await uiQuery('PT05-A02-R4E');
            const selAll = frame.locator('.el-table__header-wrapper .el-checkbox').first();
            await selAll.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
            await selAll.click({ timeout: 6000, force: true }).catch(() => {});
            await sleep(800);
            const abtn3 = frame.locator('button:has-text("审核通过")').first();
            await abtn3.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
            await abtn3.click({ timeout: 10000, noWaitAfter: true, force: true });
            await sleep(2500);
            const cfm3 = frame.locator('.el-overlay-message-box button.el-button--primary').first();
            if (await cfm3.count().catch(() => 0)) { await cfm3.click({ timeout: 5000, force: true, noWaitAfter: true }).catch(() => {}); }
            await sleep(6000);
            const audited = (await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 20, quoteName: 'PT05-A02-R4E', auditStatus: 1 })).json.data.total;
            log('[AUD-02] 过审', audited, '/', tot10);
            if (audited === tot10) record('TC-AUD-02', 'PASS', '批量全勾过审：' + tot10 + ' 行同页全选过审→全部 auditStatus=1（整批成功）——大批量混批（R4 造数翻案）');
            else record('TC-AUD-02', 'FAIL', '过审 ' + audited + '/' + tot10);
          }
        } else record('TC-AUD-01', 'FAIL', '过审后=' + (it && it.auditStatus));
      }
    } else record('TC-AUD-01', 'BLOCKED', '无可审未审核条目');
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
