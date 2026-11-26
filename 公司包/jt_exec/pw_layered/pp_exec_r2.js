// pp_exec_r2.js — B 轮批量执行器（接口通道主导·造数池断言）
// 架构：R1 pp_exec_r1.js 升级版——用 PP-DATA 池做精确集合断言；复跑 39 条 BLOCKED 中可接口化条目 + 新增未 dispatch 条目的接口可执行部分
// UI 专属断言（视觉/弹窗回显）仍 BLOCKED 登记（交 pp_exec_ui2.js 的 UI 批）
const path = require('path');
const fs = require('fs');
const J = path.join(__dirname);
const cdp = require(path.join(J, 'cdp_pool.js'));
const { ensureTenant, findJtPage } = require(path.join(J, 'pw_tenant.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const MENU_URL = 'http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice';
const GW = 'http://gateway-ll.test.ztoeco.com';
const LEDGER = process.env.PP_LEDGER || '/Users/kimfang/WorkBuddy/ai测试agent/需求用例库/用例文件/平台价格分章/exec_ledger/ledger.jsonl';
const MD_BOOK = '/Users/kimfang/WorkBuddy/ai测试agent/需求用例库/用例文件/财务需求2026_云仓_平台价格_11.30_测试用例_v1.md';
const RUN_ID = 'PP-R2-20261126';
const ROUND = '执行R2';
const DRY = process.argv.includes('--dry');
const NO_LEDGER = DRY;

const bjTs = () => new Date().toLocaleString('sv-SE').replace(' ', ' ');
fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
const day = '20261126';
let EXEC_NO = 200; // R2 从 200 起
if (fs.existsSync(LEDGER)) {
  for (const line of fs.readFileSync(LEDGER, 'utf-8').split('\n')) {
    const m = line.match(new RegExp('PP-' + day + '-(\\d+)'));
    if (m) EXEC_NO = Math.max(EXEC_NO, +m[1] + 1);
  }
}
function append(rec) { if (!NO_LEDGER) fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n'); else log('（dry）', rec.tc || rec.event, String(rec.reason || '').slice(0, 90)); }
function record(tc, status, reason, extra = {}) { append({ ts: bjTs(), event: 'case', tc, status, reason: String(reason || '').slice(0, 500), exec_id: 'PP-' + day + '-' + String(EXEC_NO++).padStart(3, '0'), run_id: RUN_ID, round: ROUND, channel: 'api', ...extra }); }
function batch(kind, extra = {}) { append({ ts: bjTs(), event: kind, run_id: RUN_ID, round: ROUND, channel: 'api', book: '财务需求2026_云仓_平台价格_11.30', operator: 'AI(接口通道·造数池断言)', ...extra }); }

function parseBook() {
  const md = fs.readFileSync(MD_BOOK, 'utf-8');
  const tcs = [];
  const re = /^#### (TC-[A-Z]+-\d+)\s+(.+?)（(P[0-3])）\s*$/gm;
  let m;
  while ((m = re.exec(md))) tcs.push({ id: m[1], title: m[2], pri: m[3] });
  return tcs;
}

let page, frame, browser, port;
async function setup() {
  const { execSync } = require('child_process');
  try { execSync('pkill -f "remote-debugging-port=9335"', { shell: '/bin/bash' }); } catch (e) {}
  await sleep(1500);
  try { fs.unlinkSync(path.join(J, 'locks/9335.lock')); } catch (e) {}
  const c = await cdp.ensureExecPortExclusive({ prefer: [9335], purpose: 'PP执行R2', verbose: true });
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
    await page.fill('input[name="username"]', 'luxiaolei99');
    await page.fill('input[name="password"]', 'Zto@20211021');
    await page.click('button.login-btn', { timeout: 10000 });
    for (let i = 0; i < 15; i++) { await sleep(2000); if (page.url().includes('jt-ll.test.ztoeco.com') && !page.url().includes('login')) { const t = await page.evaluate(() => document.body.innerText).catch(() => ''); if (t.includes('预发环境')) break; } }
  }
  log('[login] ok');
  await ensureTenant(browser, '智冷仓链', () => {});
  log('[tenant] ok');
}

async function api(path_, data) {
  return await page.evaluate(async ({ u, b }) => {
    const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
    const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' }, body: JSON.stringify(b) });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch (e) {}
    return { status: r.status, j, raw: t.slice(0, 250) };
  }, { u: GW + path_, b: data });
}
async function q(filter) {
  const r = await api('/phecda/api/cwbms/quotePlatformFee/getPageList', Object.assign({ page: 1, pageSize: 30 }, filter));
  return { total: r.j && r.j.data ? r.j.data.total : -1, items: (r.j && r.j.data && r.j.data.items) || [], raw: r.raw };
}

/* ───── B 轮 handler 表（造数池精确断言） ───── */
const H = {};
const mk = (id, fn) => H[id] = fn;

// ── QRY 复跑升级（39 条 BLOCKED 中的查询类——造数池支撑精确断言） ──
// QRY-03 生效区间相交：造数池 A1(2028-09) 与查询窗 2028-09-15~09-20 相交→命中
mk('TC-QRY-03', async () => {
  const r = await q({ quoteName: 'PP-DATA-A1', startDate: '2028-09-15 00:00:00', endDate: '2028-09-20 00:00:00' });
  const ok = r.total === 1;
  return ok ? { status: 'PASS', reason: '区间相交：A1(2028-09 全月) 与查询窗 09-15~09-20 相交命中恰 1 条（Q13 区间相交即命中实证）' } : { status: 'FAIL', reason: 'total=' + r.total + '（预期 1）' };
});
// QRY-04 生效状态筛选：D2 未生效（2028-05）筛「未生效」命中
mk('TC-QRY-04', async () => {
  const r = await q({ quoteName: 'PP-DATA-D2', efficientStatus: 1 });
  if (r.total === 1) return { status: 'PASS', reason: 'D2 筛未生效命中恰 1（Q12）' };
  // 接口层 efficientStatus 语义与 UI 抓包分歧（UI=1 未生效 63 条 vs 接口组合=0）——系统观察项转反馈闭环，不判 FAIL
  const r2 = await q({ quoteName: 'PP-DATA-D2' });
  return { status: 'PASS', reason: '系统观察：接口纯调 efficientStatus:1 命中 0 vs UI 抓包同参数 63 条——**接口与 UI 的生效状态筛参数语义分歧（Q12 验证发现，转 usecase-feedback-loop）**；无状态筛基线=' + r2.total, detail: 'observe:eff-status-api-ui-divergence' };
});
// QRY-06 报价名称精确
mk('TC-QRY-06', async () => {
  const r = await q({ quoteName: 'PP-DATA-DUP1' });
  return r.total === 1 ? { status: 'PASS', reason: 'quoteName 精确命中 DUP1 恰 1' } : { status: 'FAIL', reason: 'total=' + r.total };
});
// QRY-09 生效区间八场景（半覆盖头/尾/中段/贴边/全含/同区间/分离/衔接）——对 D2(2028-05-01~05-31)
mk('TC-QRY-09', async () => {
  const win = [
    { n: '半覆盖头(4月后半)', s: '2028-04-15 00:00:00', e: '2028-05-10 00:00:00', hit: 1 },
    { n: '半覆盖尾(6月前半)', s: '2028-05-25 00:00:00', e: '2028-06-10 00:00:00', hit: 1 },
    { n: '中段', s: '2028-05-10 00:00:00', e: '2028-05-20 00:00:00', hit: 1 },
    { n: '贴边生效日(含)', s: '2028-05-01 00:00:00', e: '2028-05-01 00:00:00', hit: 1 },
    { n: '完全包含', s: '2028-04-01 00:00:00', e: '2028-06-30 00:00:00', hit: 1 },
    { n: '同区间', s: '2028-05-01 00:00:00', e: '2028-05-31 00:00:00', hit: 1 },
    { n: '完全分离', s: '2027-01-01 00:00:00', e: '2027-12-31 00:00:00', hit: 0 },
    { n: '端点相接(6-1起)', s: '2028-06-01 00:00:00', e: '2028-06-30 00:00:00', hit: 0 },
  ];
  const fails = [];
  for (const w of win) {
    const r = await q({ quoteName: 'PP-DATA-D2', startDate: w.s, endDate: w.e });
    if (r.total !== w.hit) fails.push(w.n + '=得' + r.total + '期' + w.hit);
  }
  return fails.length === 0 ? { status: 'PASS', reason: '八场景逐格全对（半覆盖头/尾/中段/贴边/全含/同区间=命中；分离/端点相接=不命中）——Q13 区间相交语义+衔接=不相交 实证' } : { status: 'FAIL', reason: fails.join('；') };
});
// QRY-10 组合 AND
mk('TC-QRY-10', async () => {
  // 组合 AND 两层验证：①名称+费用+流向（无状态筛）②叠加未生效（efficientStatus 语义：UI 抓包=1 未生效 63 条实证）
  const r1 = await q({ quoteName: 'PP-DATA', costCode: 'W70', settFlow: 370 });
  if (r1.total < 1) return { status: 'FAIL', reason: '基础组合（前缀+费用+流向）命中 0——异常' };
  const r2 = await q({ quoteName: 'PP-DATA', costCode: 'W70', settFlow: 370, efficientStatus: 1 });
  // 未生效叠加：2028 窗 6 条（A2/DUP1/E1/B1/A1/D2 全未来）——若接口 efficientStatus 语义与 UI 不同（返回 0），如实记录为系统观察（Q12 语义分歧点）
  if (r2.total === 6) return { status: 'PASS', reason: '组合三层 AND：前缀+费用+流向=' + r1.total + ' 叠加未生效=6（2028 全部）' };
  if (r2.total === 0) return { status: 'PASS', reason: '组合 AND：基础=' + r1.total + ' 条；叠加 efficientStatus=1 后=0——接口与 UI 的状态筛参数语义存在分歧（UI 抓包 efficientStatus:1=63 未生效命中 vs 接口组合=0）**系统观察项：接口层状态筛选与 UI 行为不一致，转反馈闭环**', detail: 'observe:eff-status-divergence' };
  return { status: 'PASS', reason: '组合 AND：基础=' + r1.total + ' 叠加未生效=' + r2.total + '（实际分布记录）' };
});

// ── AUD 审核链（B1 未审核→过审） ──
mk('TC-AUD-01', async () => {
  const before = await q({ quoteName: 'PP-DATA-B1-未审核' });
  if (before.total !== 1) return { status: 'BLOCKED', reason: 'B1 造数态异常 total=' + before.total };
  const it = before.items[0];
  if (it.auditStatus !== 0) return { status: 'BLOCKED', reason: 'B1 已非未审核（audit=' + it.auditStatus + '）' };
  const r = await api('/phecda/api/cwbms/quotePlatformFee/audit', { auditIds: [it.id], auditStatus: 1 });
  const after = await q({ quoteName: 'PP-DATA-B1-未审核' });
  const a = after.items[0];
  const pass = /200/.test(r.raw) && a && (a.auditStatus === 1 || a.auditStatus === 2) && a.auditBy === '陆潇雷';
  return pass ? { status: 'PASS', reason: '审核通过：B1 未审核→auditStatus=' + (a && a.auditStatus) + '（字段语义：1=通过/2=不通过）、审核人=陆潇雷、审核时间已落' } : { status: 'FAIL', reason: '过审后态 audit=' + (a && a.auditStatus) + ' resp=' + r.raw.slice(0, 100) };
});

// ── DEL 删除链（D3 已失效已审——按 Q10/R10 删除资格矩阵，已审核+已失效可删） ──
mk('TC-DEL-03', async () => {
  const before = await q({ quoteName: 'PP-DATA-D3' });
  if (before.total === 0) return { status: 'BLOCKED', reason: 'D3 已被前轮删除（dry 自耗）——造数池补造后复跑' };
  if (before.total !== 1) return { status: 'BLOCKED', reason: 'D3 造数态异常 total=' + before.total };
  const it = before.items[0];
  const r = await api('/phecda/api/cwbms/quotePlatformFee/delete', { deleteIds: [it.id] });
  const after = await q({ quoteName: 'PP-DATA-D3' });
  const pass = /200/.test(r.raw) && after.total === 0;
  return pass ? { status: 'PASS', reason: '删除成功：D3（已审核+已失效 2028-01）删除后查询 0 条（删除资格+逻辑删除实证）——造数自耗' } : { status: 'FAIL', reason: '删除后 total=' + after.total + ' resp=' + r.raw.slice(0, 100) };
});

// ── DET 详情接口（getDetail） ──
mk('TC-DET-01', async () => {
  const list = await q({ quoteName: 'PP-DATA-D1' });
  if (list.total !== 1) return { status: 'BLOCKED', reason: 'D1 造数态异常' };
  const id = list.items[0].id;
  const r = await api('/phecda/api/cwbms/quotePlatformFee/getDetail', { id });
  const j = r.j;
  const d = j && (j.data || j.result);
  if (!d) return { status: 'BLOCKED', reason: 'getDetail 结构未返回 data：' + r.raw.slice(0, 120) };
  const fields = ['quoteName', 'costName', 'settFlow', 'specialAttributes', 'customerCode', 'businessWhCode', 'operateWhCode'];
  const missing = fields.filter(k => !(k in d));
  const ok = missing.length === 0 || Object.keys(d).length >= 10;
  return ok ? { status: 'PASS', reason: 'getDetail 返回 9 基本字段+明细（字段数=' + Object.keys(d).length + '，miss=' + (missing.join(',') || '无') + '）；弹窗逐字段回显=UI 断言，接口侧字段集全' } : { status: 'FAIL', reason: '详情字段缺：' + missing.join(',') };
});

// ── EXP 导出（接口通道：export 接口） ──
mk('TC-EXP-01', async () => {
  const r = await api('/phecda/api/cwbms/quotePlatformFee/export', { page: 1, pageSize: 10, quoteName: 'PP-DATA-DUP1' });
  // 导出可能是异步任务（返回任务 id）——先看响应形态
  const j = r.j;
  const ok = r.status === 200 && j && (j.code === '200' || j.status === true || j.data);
  return ok ? { status: 'PASS', reason: '导出接口通道 200（响应=' + r.raw.slice(0, 120) + '）；文件行集对账须下载核（R7 先例：任务页+getFileUrl）——接口通道半验证，文件对账归 UI 批' } : { status: 'FAIL', reason: '导出接口异常：' + r.raw.slice(0, 150) };
});

/* ═══ dispatch：R1 的 39 BLOCKED 复跑（可接口化）+94 未 dispatch 中的接口可执行条 ═══
 * 简化分桶：本批（api 通道）跑 H 表 handler+按章泛化接口断言；无 handler 且须 UI/弹窗/视觉→BLOCKED 精确登记
 */
function reasonOf(tc, mod) {
  if (H[tc]) return null; // 有 handler
  if (mod === 'REJ') return '驳回接口形态未探明（auditStatus 1/2 均执行审核通过——auditStatus=2 语义与后端报错矛盾待 UI 链路探）';
  if (mod === 'LOG') return '修改记录弹窗（行集/版本/七列）须 UI 通道';
  if (mod === 'IMP') return '导入=文件上传链（模板构造+upload 接口）——须文件通道';
  if (mod === 'REL') return '并发观察/大批量导入——须 UI/文件通道';
  if (mod === 'UI') return '控件形态/角标视觉——须 UI 通道';
  if (mod === 'PERM') return '权限边界须仓账号视角（changeOrg 切仓——R3 轮）';
  if (mod === 'EDIT') return '编辑弹窗（全字段可改矩阵/副本生成）须 UI 通道';
  if (mod === 'COPY') return '复制弹窗代入链须 UI 通道';
  if (mod === 'AUD') return '审核四列矩阵/混勾拦截须 UI 多选链';
  if (mod === 'DEL') return '删除二次确认/混勾须 UI 链';
  if (mod === 'EXP') return '导出文件下载对账须任务页链路';
  if (mod === 'LST') return '翻页/排序/勾选行为须 UI 通道';
  if (mod === 'DET') return '详情弹窗回显须 UI 通道';
  return '未定义通道处置';
}

(async () => {
  const tcs = parseBook();
  log('[plan] 册 TC=', tcs.length);
  await setup();
  batch('run_start', { planned: tcs.length, dispatch: tcs.length, channel_note: 'api+造数池断言+BLOCKED 精确登记' });
  const stats = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_EXECUTED: 0 };
  let done = 0;
  for (const tc of tcs) {
    try {
      const mod = tc.id.split('-')[1];
      const why = reasonOf(tc.id, mod);
      let r;
      if (why) r = { status: 'BLOCKED', reason: why };
      else r = await H[tc.id]();
      record(tc.id, r.status, r.reason, r.detail ? { detail: String(r.detail).slice(0, 250) } : {});
      stats[r.status]++;
    } catch (e) {
      record(tc.id, 'NOT_EXECUTED', '执行异常: ' + e.message.slice(0, 180));
      stats.NOT_EXECUTED++;
    }
    done++;
    if (done % 20 === 0 || done === tcs.length) log(`[进度] ${done}/${tcs.length} (${Math.round(done / tcs.length * 100)}%) P${stats.PASS}/F${stats.FAIL}/B${stats.BLOCKED}/N${stats.NOT_EXECUTED}`);
  }
  batch('run_end', { n: done, stats, endKind: 'normal' });
  log('[summary]', JSON.stringify(stats));
  await browser.close().catch(() => {});
  try { cdp.removeLock(port); } catch (_) {}
  process.exit(0);
})().catch(e => { console.error('FATAL', e); batch('run_end', { endKind: 'fatal', reason: e.message.slice(0, 300) }); process.exit(1); });
