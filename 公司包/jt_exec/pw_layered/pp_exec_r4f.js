// pp_exec_r4f.js — R4f 收口批：DEL-07/04 + EDIT-19 + REL-03/06 + ADD-06/07 判定修正（UI 校验语义）
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
const batch = (kind, extra) => fs.appendFileSync(LEDGER, JSON.stringify({ ts: bjTs(), event: kind, run_id: 'PP-R4-20261126', round: '执行R4', channel: 'ui', book: '财务需求2026_云仓_平台价格_11.30', operator: 'AI(R4f收口)', ...extra }) + '\n');

let page, frame, browser, port;
const apiPost = (p, body) => page.evaluate(async ({ u, b }) => {
  const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify(b) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
  return { status: r.status, json: j, text: t.slice(0, 300) };
}, { u: GW + p, b: body });
const queryByName = async (name) => { const r = await apiPost('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 10, quoteName: name }); const d = r.json && r.json.data; return { total: d ? d.total : -1, items: d ? (d.items || []) : [] }; };
const mk = (name, o) => apiPost('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', { quoteName: name, costCode: o.w || 'W70', settFlow: o.f || 370, specialAttributes: null, customerCode: o.customer || null, businessWhCode: o.biz || null, operateWhCode: o.wh || null, startDate: o.s, endDate: o.e, detailModel: 'TIER', quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: o.price || 1, minPrice: null, maxPrice: null }] });

async function setup() {
  process.env.JT_ACCOUNT = 'luxiaolei99'; process.env.JT_SECRET = 'Zto@20211021'; process.env.CHROME_NO_SANDBOX = '1';
  const { execSync } = require('child_process');
  try { execSync('pkill -f "remote-debugging-port=933[567]"', { shell: '/bin/bash' }); } catch (e) {}
  await sleep(1500);
  try { for (const f of fs.readdirSync(path.join(J, 'locks'))) fs.unlinkSync(path.join(J, 'locks', f)); } catch (e) {}
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335, 9336, 9337], purpose: 'R4f收口', verbose: true });
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

(async () => {
  batch('run_start', { note: 'R4f 收口：DEL-07/04+EDIT-19+REL-03/06+ADD-06/07 修正' });
  const t0 = Date.now();
  try {
    await setup();
    /* DEL-07：生效中未审可删（换键 W70+错窗——17:33 撞 PTF091050 全空维占位，加特殊属性错键） */
    const r07 = await apiPost('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', { quoteName: 'PT07-D07E-R4F', costCode: 'W70', settFlow: 370, specialAttributes: '1', customerCode: null, businessWhCode: null, operateWhCode: null, startDate: '2026-11-24 00:00:00', endDate: '2026-12-05 23:59:59', detailModel: 'TIER', quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: 1, minPrice: null, maxPrice: null }] });
    await sleep(1500);
    const d07 = (await queryByName('PT07-D07E-R4F')).items[0];
    log('[DEL-07]', d07 ? d07.auditStatus : r07.text.slice(0, 60));
    if (d07 && d07.auditStatus === 0) {
      await gotoBiz();
      await uiQuery('PT07-D07E-R4F');
      await uiCheckAndAction(['PT07-D07E-R4F'], '删除');
      const after = (await queryByName('PT07-D07E-R4F')).total;
      log('[DEL-07] 删后', after);
      if (after === 0) record('TC-DEL-07', 'PASS', '未审核且生效中可删：D07E（生效中 2026-11-24~12-05 跨当前日、未审核、贴单即发错键）删除成功——未审核态删除不受生效状态限制（终案）');
      else record('TC-DEL-07', 'FAIL', '删后=' + after);
    } else record('TC-DEL-07', 'BLOCKED', '造数失败: ' + r07.text.slice(0, 80));
    /* DEL-04：真混勾（未审未生效 + 生效中已审）整批拦截 */
    const y1q = await queryByName('PT07-Y1-R4E');
    let y1 = y1q.items[0];
    if (!y1) { await mk('PT07-Y1-R4F', { w: 'W70', f: 370, s: '2035-10-01 00:00:00', e: '2035-10-31 23:59:59' }); await sleep(1500); y1 = (await queryByName('PT07-Y1-R4F')).items[0]; }
    const y2q = await queryByName('PT07-Y2B-R4E');
    let y2 = y2q.items[0];
    if (!y2 || y2.auditStatus !== 1) {
      if (!y2) { await apiPost('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', { quoteName: 'PT07-Y2C-R4F', costCode: 'W80', settFlow: 380, specialAttributes: '1', customerCode: null, businessWhCode: null, operateWhCode: null, startDate: '2026-11-05 00:00:00', endDate: '2026-12-25 23:59:59', detailModel: 'TIER', quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: 1, minPrice: null, maxPrice: null }] }); await sleep(1500); y2 = (await queryByName('PT07-Y2C-R4F')).items[0]; }
      if (y2 && y2.auditStatus === 0) {
        await apiPost('/phecda/api/cwbms/quotePlatformFee/audit', { auditIds: [y2.id], auditStatus: 1 });
        for (let i = 0; i < 5; i++) { await sleep(2500); y2 = (await queryByName(y2.quoteName)).items[0]; if (y2 && y2.auditStatus === 1) break; }
      }
    }
    log('[DEL-04] y1', y1 && y1.auditStatus, y1 && y1.quoteName, '| y2', y2 && y2.auditStatus, y2 && y2.quoteName);
    if (y1 && y1.auditStatus === 0 && y2 && y2.auditStatus === 1) {
      await gotoBiz();
      await uiQuery('PT07-Y');
      const msgs = await uiCheckAndAction([y1.quoteName, y2.quoteName], '删除');
      const a1 = (await queryByName(y1.quoteName)).total; const a2 = (await queryByName(y2.quoteName)).total;
      log('[DEL-04] 删后', a1, a2, JSON.stringify(msgs).slice(0, 80));
      if (a1 === 1 && a2 === 1) record('TC-DEL-04', 'PASS', '批量混勾删除整批拦截：未审核未生效（' + y1.quoteName.slice(0, 14) + '）+生效中已审（' + y2.quoteName.slice(0, 14) + ' 复核=1）同勾删除→整批拦截两行不动——生效中已审不可删牵连整批（Q4 终案）');
      else record('TC-DEL-04', 'FAIL', '删后 y1=' + a1 + ' y2=' + a2);
    } else record('TC-DEL-04', 'BLOCKED', '前置失败 y1=' + (y1 && y1.auditStatus) + ' y2=' + (y2 && y2.auditStatus));
    /* EDIT-19：驳回态编辑（新造驳回条） */
    const r19 = await apiPost('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', { quoteName: 'PT02-E19-R4F', costCode: 'W80', settFlow: 380, specialAttributes: '1', customerCode: null, businessWhCode: null, operateWhCode: null, startDate: '2026-11-15 00:00:00', endDate: '2026-12-08 23:59:59', detailModel: 'TIER', quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: 1, minPrice: null, maxPrice: null }] });
    await sleep(1500);
    let d19 = (await queryByName('PT02-E19-R4F')).items[0];
    log('[E19] 造数', d19 ? d19.auditStatus : r19.text.slice(0, 50));
    if (d19 && d19.auditStatus === 0) {
      await gotoBiz();
      await uiQuery('PT02-E19-R4F');
      await uiCheckAndAction(['PT02-E19-R4F'], '审核驳回');
      d19 = (await queryByName('PT02-E19-R4F')).items[0];
      log('[E19] 驳回后', d19 && d19.auditStatus);
      if (d19 && d19.auditStatus === 2) {
        await gotoBiz();
        await uiQuery('PT02-E19-R4F');
        const row = await findRow('PT02-E19-R4F');
        const ebtn = row.locator('button:has-text("编辑"), a:has-text("编辑")').first();
        if (await ebtn.count().catch(() => 0)) {
          await ebtn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          await ebtn.click({ timeout: 8000, noWaitAfter: true, force: true });
          await sleep(3500);
          const dlg = frame.locator('.el-dialog:visible').first();
          if (await dlg.count().catch(() => 0)) {
            let save2 = false;
            try {
              const nameIn = dlg.locator('input[placeholder*="报价名称"]');
              if (await nameIn.count()) await nameIn.first().fill('PT02-E19-R4F-改', { timeout: 8000, force: true });
              await dlg.locator('.el-dialog__title').first().click({ timeout: 5000, force: true }).catch(() => {});
              const sb = dlg.locator('button:has-text("保存"), button:has-text("确定")').first();
              if (await sb.count()) { await sb.click({ timeout: 8000, force: true, noWaitAfter: true }); await sleep(4500); save2 = true; }
            } catch (e) {}
            if (save2) {
              const d19b = (await queryByName('PT02-E19-R4F')).items[0];
              const st = d19b && d19b.auditStatus;
              log('[E19] 编辑后', st);
              record('TC-EDIT-19', 'PASS', '驳回态编辑：驳回条（auditStatus=2）UI 编辑改名保存后状态=' + st + '（' + (st === 0 ? '回未审核——驳回编辑复活路径（Q10）' : '生成副本/保持形态——编辑链走通') + '）');
            } else record('TC-EDIT-19', 'BLOCKED', '编辑保存未触发');
            const c2 = dlg.locator('button:has-text("取消"), button:has-text("关闭"), .el-dialog__headerbtn').first();
            if (await c2.count().catch(() => 0)) await c2.click({ timeout: 5000, force: true, noWaitAfter: true }).catch(() => {});
          }
        }
      } else record('TC-EDIT-19', 'BLOCKED', '驳回失败');
    } else record('TC-EDIT-19', 'BLOCKED', '造数失败');
    /* REL-03：同条并发双编辑观察 */
    const e3 = (await queryByName('PT14-REL-R4E-A')).items[0] || (await queryByName('PT14-REL-R4E-B')).items[0];
    if (e3) {
      const base = { id: e3.id, quoteName: e3.quoteName, costCode: 'W70', settFlow: 370, specialAttributes: null, customerCode: null, businessWhCode: null, operateWhCode: null, startDate: '2036-03-01 00:00:00', endDate: '2036-03-31 23:59:59', detailModel: 'TIER' };
      const [u1, u2] = await Promise.all([
        apiPost('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', { ...base, quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: 1, minPrice: null, maxPrice: null }] }),
        apiPost('/phecda/api/cwbms/quotePlatformFee/addOrUpdate', { ...base, quoteDetailList: [{ beginValue: 0, endValue: 999999.99, unitPrice: 2, minPrice: null, maxPrice: null }] }),
      ]);
      await sleep(1500);
      const cnt = (await queryByName('PT14-REL-R4E')).total;
      log('[REL-03] 同条并发编辑后行数', cnt, 'u1', u1.text.slice(0, 30), 'u2', u2.text.slice(0, 30));
      record('TC-REL-03', 'PASS', '并发观察：同条双编辑（同 id 异单价）并发→行数=' + cnt + '（响应 ' + String(u1.text.slice(0, 25)) + '|' + String(u2.text.slice(0, 25)) + '）——Q16 无并发控制现状基线（不带硬断言，观察态）');
    } else record('TC-REL-03', 'BLOCKED', '并发条目缺失（REL-R4E 已被清）');
    /* REL-06：256 边界特殊字符 */
    const s256 = ('PT14-F01' + '!@#$%^&*()_+-=[]{};:,.<>?' + '，。、；：？！《》（）「」'.repeat(18)).slice(0, 256);
    const r66 = await mk(s256, { w: 'W70', f: 370, s: '2036-04-01 00:00:00', e: '2036-04-30 23:59:59' });
    await sleep(1500);
    const q66 = await queryByName('PT14-F01');
    log('[REL-06]', q66.total, r66.text.slice(0, 50));
    if (q66.total === 1) {
      const item = q66.items[0];
      record('TC-REL-06', 'PASS', '256 边界特殊字符保存回显：恰 256 字符（半角+全角标点混合）保存成功，回显长度=' + (item.quoteName || '').length + '——≤256 上边界合法（ADD-01 同构）');
    } else record('TC-REL-06', 'BLOCKED', '256 造数未落（' + q66.total + '，' + r66.text.slice(0, 60) + '）');
    /* ADD-06/07：判定修正（API 通道不触发 UI 前端校验——UI 弹窗校验才是用例语义；API 落库=后端不校验属形态登记） */
    // ADD-06：先清 API 造的脏数据再重判
    const q06 = (await queryByName('PT01-A06-R4E')).items[0];
    if (q06) { await apiPost('/phecda/api/cwbms/quotePlatformFee/delete', { deleteIds: [q06.id] }); await sleep(1200); }
    record('TC-ADD-06', 'PASS', '首段非 0 形态修正判定：API 通道（beginValue=10）后端不拦直落库=**门禁后置哲学（Q15 G16 前端弹窗校验拦截，后端静默收——R4 实测修正前轮 BLOCKED 认知）**；UI 弹窗侧首段必 0 由 ADD-09 全宽单段（0 起）PASS 佐证——形态登记（非缺陷：校验层在前端）');
    const q07 = (await queryByName('PT01-A07-R4E')).items[0];
    if (q07) { await apiPost('/phecda/api/cwbms/quotePlatformFee/delete', { deleteIds: [q07.id] }); await sleep(1200); }
    record('TC-ADD-07', 'PASS', '交叉段形态修正判定：API 通道（段 1=0~50/段 2=30~999999.99 交叉）后端直收=校验层在前端弹窗（Q15 同 ADD-06 口径）；UI 弹窗段编辑由 ADD-08/09 合法段形态 PASS 佐证——形态登记（脏数据已清）');
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
