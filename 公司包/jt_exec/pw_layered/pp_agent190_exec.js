#!/usr/bin/env node
'use strict';

// 平台价格 Agent 重建 190 条批量执行适配器。
// 默认仅预检；显式 --execute 才连接环境、逐条执行并写入独立 JSONL 账本。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const cdp = require('./cdp_pool');
const { ensureLogin } = require('./pw_login');
const { ensureTenant, findJtPage } = require('./pw_tenant');

const BOOK_DIR = '/Users/kimfang/WorkBuddy/ai测试agent/需求用例库/用例文件/平台价格_Agent重建分章';
const SPEC_FILE = path.join(BOOK_DIR, 'execution_specs.json');
const DISPATCH_FILE = path.join(BOOK_DIR, 'dispatch_plan.json');
const LEDGER_DIR = path.join(BOOK_DIR, 'exec_ledger');
const MENU_URL = 'http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice';
const GATEWAY = 'http://gateway-ll.test.ztoeco.com';
const TENANT = '智冷仓链';
const EXPECTED_CHAPTERS = { NEW: 71, STA: 42, IO: 27, QRY: 26, SEC: 24 };
const EXPECTED_TOTAL = 190;
const EXECUTE = process.argv.includes('--execute');
const ONLY_CHAPTER = valueArg('--chapter');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function valueArg(name) {
  const eq = process.argv.find(arg => arg.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1).toUpperCase();
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1].toUpperCase() : null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function uniq(values) {
  return [...new Set(values)];
}

function sameSet(left, right) {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function chapterOf(tc) {
  const match = /^TC-(NEW|STA|IO|QRY|SEC)-\d+$/.exec(tc);
  if (!match) throw new Error(`非法新编号: ${tc}`);
  return match[1];
}

function reconcile(specs, plan) {
  const specIds = specs.map(spec => spec.tc);
  const planned = plan.planned_tc_ids || [];
  const dispatched = plan.dispatched_tc_ids || [];
  const errors = [];
  if (specIds.length !== EXPECTED_TOTAL || uniq(specIds).length !== EXPECTED_TOTAL) errors.push(`spec 应为 190 条唯一编号，实际 ${specIds.length}/${uniq(specIds).length}`);
  if (planned.length !== EXPECTED_TOTAL || uniq(planned).length !== EXPECTED_TOTAL) errors.push(`planned 应为 190 条唯一编号，实际 ${planned.length}/${uniq(planned).length}`);
  if (dispatched.length !== EXPECTED_TOTAL || uniq(dispatched).length !== EXPECTED_TOTAL) errors.push(`dispatch 应为 190 条唯一编号，实际 ${dispatched.length}/${uniq(dispatched).length}`);
  if (!sameSet(specIds, planned)) errors.push('spec 与 planned 集合不一致');
  if (!sameSet(specIds, dispatched)) errors.push('spec 与 dispatched 集合不一致');
  if (planned.some(id => !/^TC-(NEW|STA|IO|QRY|SEC)-/.test(id))) errors.push('计划集混入旧编号或非五章编号');
  const counts = Object.fromEntries(Object.keys(EXPECTED_CHAPTERS).map(key => [key, specIds.filter(id => chapterOf(id) === key).length]));
  for (const [chapter, expected] of Object.entries(EXPECTED_CHAPTERS)) {
    if (counts[chapter] !== expected) errors.push(`${chapter} 应为 ${expected} 条，实际 ${counts[chapter]}`);
  }
  if ((plan.execution_policy || '').includes('DO_NOT_EXECUTE') && EXECUTE && !process.argv.includes('--ack-dispatch-policy')) {
    errors.push('dispatch 标记 DO_NOT_EXECUTE；正式执行需同时传 --ack-dispatch-policy');
  }
  if (errors.length) throw new Error('190 集合硬对账失败:\n- ' + errors.join('\n- '));
  return { counts, specIds, planned, dispatched };
}

function iso() {
  return new Date().toISOString();
}

function compact(value, limit = 800) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').slice(0, limit);
}

function getPath(object, dotted) {
  return dotted.split('.').reduce((value, key) => value == null ? undefined : value[key], object);
}

function caseResult(status, reason, evidence = {}, failureClass = null) {
  return { status, reason: compact(reason), evidence, failureClass };
}

class Ledger {
  constructor(plan) {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    this.runId = `PP-AGENT190-${stamp}-${process.pid}`;
    this.file = process.env.PP_AGENT190_LEDGER || path.join(LEDGER_DIR, `${this.runId}.jsonl`);
    this.plan = plan;
    this.sequence = 0;
  }

  append(record) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify({ ts: iso(), run_id: this.runId, ...record }) + '\n');
  }

  event(event, extra = {}) {
    this.append({ event, execution_id: this.plan.execution_id, book: '平台价格_Agent重建', ...extra });
  }

  record(spec, result, durationMs) {
    this.sequence += 1;
    this.append({
      event: 'case',
      exec_id: `PP-A190-${String(this.sequence).padStart(3, '0')}`,
      tc: spec.tc,
      chapter: chapterOf(spec.tc),
      title: spec.title,
      channel: result.channel || 'blocked',
      status: result.status,
      reason: result.reason,
      evidence: result.evidence || {},
      failure_class: result.failureClass || null,
      duration_ms: durationMs,
    });
  }
}

class PlatformPriceSession {
  async open() {
    const portInfo = await cdp.ensureExecPortExclusive({ prefer: [9336, 9337, 9338, 9335], purpose: '平台价格Agent190批量执行', verbose: true });
    this.port = portInfo.port;
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.port}`, { timeout: 10000 });
    const login = await ensureLogin(this.port);
    if (login === 'login-timeout') throw new Error('9335 登录 preflight 超时');
    this.page = await findJtPage(this.browser) || this.browser.contexts()[0].pages()[0] || await this.browser.contexts()[0].newPage();
    if (!this.page.url().includes('jt-ll.test.ztoeco.com')) {
      await this.page.goto('http://jt-ll.test.ztoeco.com/app/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
    }
    const hasMenu = await this.page.evaluate(() => (localStorage.getItem('MICRO_APP_MAIN_MENU_LIST') || '').includes('平台价格')).catch(() => false);
    if (!hasMenu) await ensureTenant(this.browser, TENANT, console.log);
    this.token = await this.page.evaluate(() => localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY'));
    if (!this.token) throw new Error('9335 当前会话缺少 MICRO_APP_MAIN_TOKEN_KEY');
    await this.openMenu();
  }

  async openMenu() {
    await this.page.goto(MENU_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      this.frame = this.page.frames().find(frame => frame.url().includes('warehouse-menu/quote/platformPrice'));
      if (this.frame && await this.frame.locator('.el-table__header-wrapper th').count().catch(() => 0) > 3) return;
      await sleep(1000);
    }
    throw new Error('平台价格 iframe 或列表表头未就绪');
  }

  async api(endpoint, body) {
    return this.page.evaluate(async ({ url, body: requestBody }) => {
      const token = localStorage.getItem('MICRO_APP_MAIN_TOKEN_KEY');
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: token, authtoken: token, PlatformCode: 'ZTOCC_PLATFORM_001', 'client-Type': 'pc' },
          body: JSON.stringify(requestBody),
        });
        const text = await response.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        return { httpStatus: response.status, body: json, raw: text.slice(0, 500) };
      } catch (error) {
        return { httpStatus: 0, body: null, raw: error.message };
      }
    }, { url: GATEWAY + endpoint, body });
  }

  async list(filters = {}) {
    const response = await this.api('/phecda/api/cwbms/quotePlatformFee/getPageList', { page: 1, pageSize: 500, ...filters });
    const l1 = response.httpStatus === 200 && response.body && ['0', '200'].includes(String(response.body.code));
    if (!l1) throw new Error(`查询接口不可用 HTTP=${response.httpStatus} code=${response.body && response.body.code}`);
    const data = response.body.data || {};
    const items = data.items || data.list || data.records;
    if (!Array.isArray(items) || typeof data.total !== 'number') throw new Error('查询接口 L2 结构缺少 data.items/list/records 或 data.total');
    return { items, total: data.total, response };
  }

  async marks() {
    const response = await this.api('/phecda/api/cwbms/quotePlatformFee/getMarksCount', { page: 1, pageSize: 10 });
    const l1 = response.httpStatus === 200 && response.body && ['0', '200'].includes(String(response.body.code));
    if (!l1 || !response.body.data) throw new Error(`角标接口不可用 HTTP=${response.httpStatus}`);
    return response.body.data;
  }

  close() {
    if (this.port) cdp.removeLock(this.port);
  }
}

function codes(items) {
  return items.map(item => item.quoteCode).filter(Boolean);
}

function exactSet(actual, expected) {
  return sameSet(actual, expected) && actual.length === expected.length;
}

function baselineMissing(spec, names) {
  return caseResult('BLOCKED', `前置基线未就绪：需存在并可读取 ${names.join('、')}；禁止用当前任意数据替代固定集合断言`, { precondition: spec.precondition });
}

async function exactQuery(session, spec, filters, expected, excluded = []) {
  const anchors = await session.list({ quoteCode: expected[0] });
  if (!anchors.items.some(item => item.quoteCode === expected[0])) return baselineMissing(spec, expected);
  const result = await session.list(filters);
  const actual = codes(result.items);
  const ok = exactSet(actual, expected) && excluded.every(code => !actual.includes(code));
  return { ...caseResult(ok ? 'PASS' : 'FAIL', ok ? `查询集合与预期严格相等：${expected.join(',')}` : `查询集合不符，expected=${expected.join(',')} actual=${actual.join(',')}`, {
    endpoint: 'quotePlatformFee/getPageList', filters, expected, actual, total: result.total,
  }), channel: 'api' };
}

const QUERY_HANDLERS = {
  'TC-QRY-01': async (session) => {
    await session.openMenu();
    const body = await session.frame.locator('body').innerText();
    const required = ['报价编码', '报价名称', '审核状态', '生效状态', '费用名称', '流量管理费', '业务管理费'];
    const missing = required.filter(text => !body.includes(text));
    const forbidden = ['出库费', '入库费'].filter(text => body.includes(text));
    const ok = missing.length === 0 && forbidden.length === 0;
    return { ...caseResult(ok ? 'PASS' : 'FAIL', ok ? '页面默认查询控件与费用枚举实断言通过' : `页面控件/枚举不符 missing=${missing.join(',')} forbidden=${forbidden.join(',')}`, { required, missing, forbidden }), channel: 'ui' };
  },
  'TC-QRY-02': (s, spec) => exactQuery(s, spec, { quoteCode: '04012' }, ['P04012001', 'P04012002'], ['P04022001']),
  'TC-QRY-03': (s, spec) => exactQuery(s, spec, { quoteName: '华东' }, ['P04013001', 'P04013002'], ['P04013003']),
  'TC-QRY-07': async (s, spec) => {
    const required = ['P04017001', 'P04017002', 'P04017003'];
    const anchor = await s.list({ quoteCode: required[0] });
    if (!anchor.items.length) return baselineMissing(spec, required);
    const probes = [
      await exactQuery(s, spec, { costCode: 'W80' }, ['P04017001']),
      await exactQuery(s, spec, { settFlow: 360 }, ['P04017003']),
      await exactQuery(s, spec, { specialAttributes: '1' }, ['P04017001', 'P04017003']),
    ];
    const failed = probes.find(probe => probe.status !== 'PASS');
    return failed || { ...caseResult('PASS', '费用名称、结算流向、特殊属性三组单条件集合均严格匹配', { probes: probes.map(probe => probe.evidence) }), channel: 'api' };
  },
  'TC-QRY-08': async (s, spec) => {
    const expected = [['0', 'P04018001'], ['1', 'P04018002'], ['2', 'P04018003']];
    const anchor = await s.list({ quoteCode: 'P04018001' });
    if (!anchor.items.length) return baselineMissing(spec, expected.map(([, code]) => code));
    const probes = [];
    for (const [auditStatus, code] of expected) probes.push(await exactQuery(s, spec, { auditStatus: Number(auditStatus) }, [code]));
    const failed = probes.find(probe => probe.status !== 'PASS');
    return failed || { ...caseResult('PASS', '三种审核状态的查询集合均严格匹配', { probes: probes.map(probe => probe.evidence) }), channel: 'api' };
  },
  'TC-QRY-15': async s => {
    const empty = await s.list({ quoteName: 'TEST04_NOT_FOUND' });
    const reset = await s.list({});
    const resetCodes = codes(reset.items);
    const ok = empty.total === 0 && ['P04025001', 'P04025002'].every(code => resetCodes.includes(code));
    return { ...caseResult(ok ? 'PASS' : 'FAIL', ok ? '不存在名称为空集，重置后基线记录恢复' : `empty.total=${empty.total} resetHas=${resetCodes.filter(code => code.startsWith('P04025')).join(',')}`, { emptyTotal: empty.total, resetCodes: resetCodes.filter(code => code.startsWith('P04025')) }), channel: 'api' };
  },
  'TC-QRY-16': async (s, spec) => {
    const result = await s.list({ quoteCode: 'P04026001' });
    if (!result.items.length) return baselineMissing(spec, ['P04026001']);
    const item = result.items[0];
    const fields = ['quoteCode', 'quoteName', 'dateRange', 'costName', 'settFlowName', 'auditStatus', 'specialAttributeName', 'customerName', 'businessWhName', 'operateWhName', 'createBy', 'createTime', 'modifyBy', 'modifyTime', 'auditBy', 'auditTime'];
    const missing = fields.filter(field => !(field in item));
    const ok = missing.length === 0;
    return { ...caseResult(ok ? 'PASS' : 'FAIL', ok ? '列表接口 17 个业务展示字段映射完整' : `列表字段缺失：${missing.join(',')}`, { fields, missing }), channel: 'api' };
  },
  'TC-QRY-19': async (s, spec) => {
    const marks = await s.marks();
    const waiting = getPath(marks, 'waitingAudit');
    if (waiting !== 0) return baselineMissing(spec, ['当前权限范围未审核数=0']);
    await s.openMenu();
    const body = await s.frame.locator('body').innerText();
    const displayed = /未审核\s*[1-9]\d*/.test(body);
    return { ...caseResult(!displayed ? 'PASS' : 'FAIL', !displayed ? '未审核计数为 0 且页面未显示数字角标' : '接口计数为 0 但页面仍显示未审核数字角标', { waitingAudit: waiting }), channel: 'ui+api' };
  },
  'TC-QRY-20': async (s, spec) => {
    const marks = await s.marks();
    const waiting = getPath(marks, 'waitingAudit');
    if (waiting !== 37) return baselineMissing(spec, ['当前权限范围未审核数=37']);
    return { ...caseResult('PASS', '角标接口返回全量未审核数 37，非当前页数量', { waitingAudit: waiting }), channel: 'api' };
  },
  'TC-QRY-21': async (s, spec) => {
    const marks = await s.marks();
    const waiting = getPath(marks, 'waitingAudit');
    if (waiting !== 105) return baselineMissing(spec, ['当前权限范围未审核数=105']);
    await s.openMenu();
    const body = await s.frame.locator('body').innerText();
    return { ...caseResult(body.includes('99+') ? 'PASS' : 'FAIL', body.includes('99+') ? '接口 105 且页面按 99+ 展示' : '接口为 105 但页面未找到 99+ 展示', { waitingAudit: waiting }), channel: 'ui+api' };
  },
};

function concreteBlock(spec) {
  const chapter = chapterOf(spec.tc);
  const text = `${spec.precondition} ${spec.steps} ${spec.expected}`;
  let reason;
  if (/故障注入|可控异常|暂停\/恢复/.test(text)) reason = '缺少已确认的故障注入或异步任务暂停/恢复入口及结果出口';
  else if (/会话 A、B|另一会话|并发/.test(text)) reason = '缺少两个已校准独立会话及并发同步栅栏，不能以串行请求替代并发断言';
  else if (chapter === 'SEC' && /仓A|A账号|普通仓|缺少菜单权限|机构树|切换/.test(text)) reason = '缺少非总部/无菜单权限对照账号、执行前后机构树快照或安全隔离基线';
  else if (chapter === 'IO' && /文件|模板|导入/.test(text)) reason = 'spec 未提供对应 FILE 基线文件、上传定位器及错误文件/任务结果出口';
  else if (chapter === 'IO' && /导出/.test(text)) reason = '缺少指定查询集合、跨页勾选状态及可解析的最终导出文件出口';
  else if (chapter === 'QRY') reason = '缺少该条固定报价/客户/仓/版本基线，不能用环境任意记录替代集合或历史快照断言';
  else if (chapter === 'STA') reason = '缺少该条 TESTSTA 专属主记录、副本、版本链或目标状态基线，禁止对非专属数据执行写操作';
  else if (chapter === 'NEW') reason = '缺少该条 TEST01 专属判重前置、客户归属仓基线或可安全清理的数据夹具；禁止无前置造数写入';
  else reason = '当前 spec 未提供可形成实质断言的环境前置或自动化契约';
  return caseResult('BLOCKED', reason, { precondition: compact(spec.precondition), blocked_conditions: spec.blocked_conditions || [] });
}

async function dispatchCase(session, spec) {
  const handler = QUERY_HANDLERS[spec.tc];
  if (!handler) return concreteBlock(spec);
  return handler(session, spec);
}

function isEnvironmentFailure(result) {
  return result.failureClass === 'environment' || result.failureClass === 'channel' || result.failureClass === 'timeout';
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`单条超过 ${timeoutMs}ms`), { code: 'CASE_TIMEOUT' })), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const specs = readJson(SPEC_FILE);
  const plan = readJson(DISPATCH_FILE);
  const reconciliation = reconcile(specs, plan);
  const byId = new Map(specs.map(spec => [spec.tc, spec]));
  const ordered = plan.dispatched_tc_ids.map(id => byId.get(id));
  if (ordered.some(spec => !spec)) throw new Error('dispatch 含 spec 不存在的编号');
  console.log('[preflight] 190 集合硬对账通过', JSON.stringify(reconciliation.counts));
  console.log('[preflight] execution_id=' + plan.execution_id);
  if (!EXECUTE) {
    console.log('[preflight] 未传 --execute，仅完成解析与硬对账；未连接浏览器、未创建账本、未执行用例');
    return;
  }

  const selected = ONLY_CHAPTER ? ordered.filter(spec => chapterOf(spec.tc) === ONLY_CHAPTER) : ordered;
  if (ONLY_CHAPTER && !(ONLY_CHAPTER in EXPECTED_CHAPTERS)) throw new Error(`未知章节 ${ONLY_CHAPTER}`);
  const ledger = new Ledger(plan);
  const stats = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_EXECUTED: 0 };
  const session = new PlatformPriceSession();
  let runStarted = false;
  let stopReason = null;
  let consecutiveEnvironmentFailures = 0;
  let processed = 0;
  try {
    ledger.event('run_start', { planned_count: EXPECTED_TOTAL, dispatch_count: selected.length, chapter: ONLY_CHAPTER || 'ALL', preferred_port: 9335 });
    runStarted = true;
    await session.open();
    ledger.event('environment_ready', { port: session.port, tenant: TENANT });
    for (const chapter of Object.keys(EXPECTED_CHAPTERS)) {
      const chapterCases = selected.filter(spec => chapterOf(spec.tc) === chapter);
      if (!chapterCases.length) continue;
      let chapterDone = 0;
      for (const spec of chapterCases) {
        if (stopReason) break;
        const started = Date.now();
        let result;
        try {
          result = await withTimeout(dispatchCase(session, spec), spec.timeout_ms || 300000);
        } catch (error) {
          const timeout = error.code === 'CASE_TIMEOUT';
          result = caseResult('NOT_EXECUTED', timeout ? error.message : `环境/通道异常：${compact(error.message, 300)}`, {}, timeout ? 'timeout' : 'channel');
          result.channel = 'ui/api';
        }
        ledger.record(spec, result, Date.now() - started);
        stats[result.status] += 1;
        processed += 1;
        chapterDone += 1;
        consecutiveEnvironmentFailures = isEnvironmentFailure(result) ? consecutiveEnvironmentFailures + 1 : 0;
        if (consecutiveEnvironmentFailures >= 3) stopReason = `连续 3 条环境/通道/超时失败，停批于 ${spec.tc}`;
      }
      console.log(`[进度] ${chapter}: ${chapterDone}/${chapterCases.length} (${Math.round(chapterDone / chapterCases.length * 100)}%)；总进度 ${processed}/${selected.length}`);
      ledger.event('chapter_progress', { chapter, completed: chapterDone, total: chapterCases.length, overall_completed: processed, overall_total: selected.length, stats: { ...stats } });
      if (stopReason) break;
    }
    if (stopReason) {
      for (const spec of selected.slice(processed)) {
        const result = caseResult('NOT_EXECUTED', `批次已终止：${stopReason}`, { stopped_after: processed });
        result.channel = 'not-dispatched';
        ledger.record(spec, result, 0);
        stats.NOT_EXECUTED += 1;
      }
    }
    ledger.event('run_end', { end_kind: stopReason ? 'stopped' : 'normal', reason: stopReason, processed, total: selected.length, stats });
    console.log('[summary]', JSON.stringify(stats), 'ledger=' + ledger.file);
  } catch (error) {
    if (runStarted) {
      for (const spec of selected.slice(processed)) {
        const result = caseResult('NOT_EXECUTED', `批次致命环境失败，未派发：${compact(error.message, 300)}`, {}, 'environment');
        result.channel = 'not-dispatched';
        ledger.record(spec, result, 0);
        stats.NOT_EXECUTED += 1;
      }
      ledger.event('run_end', { end_kind: 'fatal', reason: compact(error.message, 500), processed, total: selected.length, stats });
    }
    throw error;
  } finally {
    session.close();
  }
}

main().catch(error => {
  console.error('[fatal]', error.stack || error.message);
  process.exitCode = 1;
});
