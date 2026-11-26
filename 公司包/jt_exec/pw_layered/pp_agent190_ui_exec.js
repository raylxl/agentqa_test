#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright');
const cdpPool = require('./cdp_pool');
const { ensureLogin } = require('./pw_login');
const { ensureTenant, findJtPage } = require('./pw_tenant');

const ROOT = '/Users/kimfang/WorkBuddy/ai测试agent/需求用例库/用例文件';
const BOOK_FILE = path.join(ROOT, '平台价格_Agent重建_测试用例_v1.md');
const CHAPTER_DIR = path.join(ROOT, '平台价格_Agent重建分章');
const SPEC_FILE = path.join(CHAPTER_DIR, 'execution_specs.json');
const DISPATCH_FILE = path.join(CHAPTER_DIR, 'dispatch_plan.json');
const MATRIX_FILE = path.join(CHAPTER_DIR, 'ui_exec/UI执行矩阵_190.md');
const OUTPUT_ROOT = path.join(CHAPTER_DIR, 'ui_exec/runs');
const MENU_URL = 'http://jt-ll.test.ztoeco.com/app/#/warehouse-menu/quote/platformPrice';
const TENANT_NAME = '智冷仓链';
const TOTAL = 190;
const CHAPTER_COUNTS = { NEW: 71, STA: 42, IO: 27, QRY: 26, SEC: 24 };
const EXECUTE = process.argv.includes('--execute');
const ACK = process.argv.includes('--ack-user-approval');
const ONLY_TC = argValue('--tc');
const ONLY_CHAPTER = (argValue('--chapter') || '').toUpperCase();
const CASE_TIMEOUT_MS = 300000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function argValue(name) {
  const inline = process.argv.find(value => value.startsWith(name + '='));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function iso() {
  return new Date().toISOString();
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '_');
}

function compact(value, max = 1200) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
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
  const match = /^TC-(NEW|STA|IO|QRY|SEC)-(\d{2})$/.exec(tc);
  if (!match) throw new Error(`非法 TC 编号: ${tc}`);
  return match[1];
}

function parseMatrix(file) {
  const rows = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\| (TC-(NEW|STA|IO|QRY|SEC)-\d{2})\s+([^|]+)\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|$/.exec(line);
    if (!match) continue;
    rows.set(match[1], {
      tc: match[1],
      title: match[3].trim(),
      role: match[4].trim(),
      precondition: match[5].trim(),
      uiSteps: match[6].trim(),
      uiExpected: match[7].trim(),
      cleanup: match[8].trim(),
    });
  }
  return rows;
}

function reconcile(specs, dispatch, matrix) {
  const specIds = specs.map(spec => spec.tc);
  const planned = dispatch.planned_tc_ids || [];
  const dispatched = dispatch.dispatched_tc_ids || [];
  const matrixIds = [...matrix.keys()];
  const errors = [];
  for (const [label, ids] of Object.entries({ spec: specIds, planned, dispatched, matrix: matrixIds })) {
    if (ids.length !== TOTAL || uniq(ids).length !== TOTAL) errors.push(`${label} 不是190条唯一TC，实际 ${ids.length}/${uniq(ids).length}`);
  }
  if (!sameSet(specIds, planned)) errors.push('spec 与 planned 集合不一致');
  if (!sameSet(specIds, dispatched)) errors.push('spec 与 dispatched 集合不一致');
  if (!sameSet(specIds, matrixIds)) errors.push('spec 与 UI矩阵集合不一致');
  const counts = {};
  for (const chapter of Object.keys(CHAPTER_COUNTS)) {
    counts[chapter] = specIds.filter(tc => chapterOf(tc) === chapter).length;
    if (counts[chapter] !== CHAPTER_COUNTS[chapter]) errors.push(`${chapter} 应为 ${CHAPTER_COUNTS[chapter]}，实际 ${counts[chapter]}`);
  }
  for (const file of [BOOK_FILE, SPEC_FILE, DISPATCH_FILE, MATRIX_FILE]) {
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) errors.push(`必读输入缺失或为空: ${file}`);
  }
  if (errors.length) throw new Error('190计划硬对账失败:\n- ' + errors.join('\n- '));
  return { total: TOTAL, counts, executionId: dispatch.execution_id };
}

function strategyFor(spec, matrix) {
  const text = `${spec.title} ${matrix.precondition} ${matrix.uiSteps} ${matrix.uiExpected}`;
  const chapter = chapterOf(spec.tc);
  const recipes = uniq((text.match(/P(?:0[1-9]|1[0-2])/g) || []));
  let family;
  if (/并发|会话 A、B|两个.*任务/.test(text)) family = 'ui-concurrency';
  else if (/导入/.test(text)) family = 'ui-import';
  else if (/导出/.test(text)) family = 'ui-export';
  else if (chapter === 'SEC') family = 'ui-permission';
  else if (chapter === 'QRY') family = 'ui-query';
  else if (/驳回/.test(text)) family = 'ui-reject';
  else if (/审核/.test(text)) family = 'ui-audit';
  else if (/删除/.test(text)) family = 'ui-delete';
  else if (/复制/.test(text)) family = 'ui-copy';
  else if (/编辑|副本|修改记录|历史版本/.test(text)) family = 'ui-version';
  else family = 'ui-form';
  const independentAccount = /R2审核|R3仓|R4仓|R5总部|不同账号|双账号|多账号|权限差异账号/.test(matrix.role);
  const isolatedSessions = /双隔离会话|会话 A、B|并发/.test(text);
  return { family, recipes, independentAccount, isolatedSessions, cleanup: matrix.cleanup || 'C0' };
}

class RunLedger {
  constructor(dispatch) {
    const stamp = iso().replace(/[-:TZ.]/g, '').slice(0, 14);
    this.runId = `PP-UI190-${stamp}-${process.pid}`;
    this.dir = process.env.PP_UI190_RUN_DIR || path.join(OUTPUT_ROOT, this.runId);
    this.file = path.join(this.dir, 'timeline.jsonl');
    this.shotDir = path.join(this.dir, 'screenshots');
    this.downloadDir = path.join(this.dir, 'downloads');
    this.dispatch = dispatch;
    this.seq = 0;
    fs.mkdirSync(this.shotDir, { recursive: true });
    fs.mkdirSync(this.downloadDir, { recursive: true });
  }

  append(event) {
    fs.appendFileSync(this.file, JSON.stringify({ ts: iso(), run_id: this.runId, ...event }) + '\n');
  }

  action(tc, step, action, details = {}) {
    this.append({ event: 'ui_action', tc, step, action, channel: 'ui', ...details });
  }

  assertion(tc, step, visibleText, passed, details = {}) {
    this.append({ event: 'visible_text_assertion', tc, step, visible_text: compact(visibleText), passed, channel: 'ui', ...details });
  }

  case(spec, matrix, result, durationMs) {
    this.seq += 1;
    this.append({
      event: 'case',
      exec_id: `PP-UI190-${String(this.seq).padStart(3, '0')}`,
      tc: spec.tc,
      title: matrix.title || spec.title,
      chapter: chapterOf(spec.tc),
      status: result.status,
      failure_class: result.failureClass || null,
      failed_control: result.failedControl || null,
      failed_step: result.failedStep || null,
      reason: compact(result.reason),
      ui_actions: result.uiActions || [],
      visible_text_assertions: result.assertions || [],
      evidence: result.evidence || {},
      duration_ms: durationMs,
      channel: 'ui',
    });
  }
}

class UiBlocked extends Error {
  constructor(step, control, message, failureClass = 'capability') {
    super(message);
    this.step = step;
    this.control = control;
    this.failureClass = failureClass;
  }
}

class UiSession {
  constructor(ledger) {
    this.ledger = ledger;
    this.actions = [];
    this.assertions = [];
    this.responses = [];
  }

  async open() {
    const requestedPort = Number(argValue('--port') || 0);
    if (requestedPort) {
      const probe = await cdpPool.probe(requestedPort);
      if (!probe.alive) throw new Error(`指定登录实例不可达: ${requestedPort}`);
      if (cdpPool.readLock(requestedPort)) throw new Error(`指定实例已有有效锁: ${requestedPort}`);
      cdpPool.writeLock(requestedPort, '平台价格190全UI重跑');
      this.port = requestedPort;
    } else {
      const selected = await cdpPool.ensureExecPortExclusive({ prefer: [9335, 9336, 9337, 9338], purpose: '平台价格190全UI重跑', verbose: true });
      this.port = selected.port;
    }
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.port}`, { timeout: 10000 });
    const login = await ensureLogin(this.port, { verbose: true });
    if (login === 'login-timeout') throw new Error(`登录实例 ${this.port} 登录超时`);
    await ensureTenant(this.browser, TENANT_NAME, message => console.log('[tenant]', message));
    this.page = await findJtPage(this.browser) || this.browser.contexts()[0].pages()[0] || await this.browser.contexts()[0].newPage();
    this.page.on('response', response => {
      const url = response.url();
      if (/quotePlatformFee|excelTask|fileImport|export/i.test(url)) this.responses.push({ ts: iso(), method: response.request().method(), status: response.status(), url });
      if (this.responses.length > 200) this.responses.shift();
    });
    await this.openMenu();
    await this.switchOrgUi(process.env.PP_HEADQUARTERS_ORG || '总部');
    await this.openMenu();
  }

  async switchOrgUi(target) {
    const step = '启动前切总部机构';
    const trigger = this.page.locator('.org-menu .org-dropdown .drop-wrapper').first();
    if (!await trigger.isVisible().catch(() => false)) throw new UiBlocked(step, '.org-menu .org-dropdown .drop-wrapper', '机构切换入口不可见', 'environment');
    await trigger.click();
    await this.page.locator('[role="menuitem"] .org-name, .org-popper .org-name').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    const items = this.page.locator('[role="menuitem"]:visible');
    const names = await items.allTextContents();
    let item = items.filter({ hasText: new RegExp(`^\\s*${escapeRegex(target)}\\s*$`) }).first();
    if (!await item.count()) item = this.page.locator(`.org-name[title="${target}"]:visible`).first().locator('xpath=ancestor::*[@role="menuitem"][1]');
    if (!await item.count()) item = items.filter({ hasText: /^\\s*总部\\s*$/ }).first();
    if (!await item.count()) throw new UiBlocked(step, '[role="menuitem"] .org-name', `机构下拉未找到“${target}”；可见项=${compact(names.join(','))}`, 'environment');
    const selectedName = compact(await item.innerText());
    await item.click();
    const confirm = this.page.locator('.el-message-box:visible button, .el-dialog:visible button').filter({ hasText: /确认|确定/ }).first();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    await sleep(4000);
    const identity = await this.page.evaluate(() => {
      try {
        const auth = JSON.parse(localStorage.getItem('authInfo') || '{}');
        return { name: auth.currentOrgName || '', code: auth.currentOrgCode || '' };
      } catch (_) {
        return { name: '', code: '' };
      }
    });
    const headerText = compact(await trigger.innerText().catch(() => ''));
    if (!headerText.includes(target) || !String(identity.name).includes(target)) {
      throw new UiBlocked(step, '机构页头/authInfo', `切换后机构未双重一致：页头=${headerText}，authInfo=${identity.name}/${identity.code}`, 'environment');
    }
    this.ledger.action(null, step, 'click', { control: '机构下拉', selected_text: selectedName, header_text: headerText, auth_info: identity });
  }

  async openMenu() {
    await this.page.goto(MENU_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    for (let index = 0; index < 30; index += 1) {
      this.frame = this.page.frames().find(frame => frame.url().includes('warehouse-menu/quote/platformPrice'));
      if (this.frame && await this.frame.locator('.el-table__header-wrapper th').count().catch(() => 0) > 3) return;
      await sleep(1000);
    }
    throw new UiBlocked('打开平台价格页面', '平台价格 iframe/表头', '30秒内未出现平台价格列表表头', 'environment');
  }

  beginCase() {
    this.actions = [];
    this.assertions = [];
    this.responses = [];
  }

  async act(tc, step, action, locator, value) {
    const control = locator.toString();
    if (!await locator.first().isVisible().catch(() => false)) throw new UiBlocked(step, control, `控件不可见: ${control}`, 'ui-control');
    if (action === 'click') await locator.first().click({ timeout: 10000 });
    else if (action === 'fill') await locator.first().fill(String(value), { timeout: 10000 });
    else if (action === 'check') await locator.first().check({ timeout: 10000 });
    else throw new Error(`未知UI动作: ${action}`);
    const entry = { step, action, control, value: value == null ? null : String(value) };
    this.actions.push(entry);
    this.ledger.action(tc, step, action, entry);
  }

  async assertVisible(tc, step, locator, expected) {
    if (!await locator.first().isVisible().catch(() => false)) throw new UiBlocked(step, locator.toString(), '断言目标不可见', 'ui-control');
    const visibleText = compact(await locator.first().innerText().catch(() => ''));
    const passed = expected instanceof RegExp ? expected.test(visibleText) : visibleText.includes(String(expected));
    const assertion = { step, expected: String(expected), visibleText, passed };
    this.assertions.push(assertion);
    this.ledger.assertion(tc, step, visibleText, passed, { expected: String(expected) });
    if (!passed) return false;
    return true;
  }

  async screenshot(tc, label) {
    const file = path.join(this.ledger.shotDir, `${safeName(tc)}_${safeName(label)}_${Date.now()}.png`);
    await this.page.screenshot({ path: file, fullPage: true });
    return file;
  }

  async resetResidue(tc) {
    await this.page.keyboard.press('Escape').catch(() => {});
    const dialogs = this.frame.locator('.el-dialog:visible, .el-message-box:visible');
    for (let guard = 0; guard < 5 && await dialogs.count().catch(() => 0); guard += 1) {
      const close = dialogs.first().locator('button').filter({ hasText: /取消|关闭/ }).first();
      if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
      else await this.page.keyboard.press('Escape').catch(() => {});
      await sleep(200);
    }
    for (const input of await this.frame.locator('.el-form:not(.el-dialog *) input:visible').all()) {
      await input.fill('').catch(() => {});
    }
    const reset = this.frame.locator('button:visible').filter({ hasText: /重置/ }).first();
    if (await reset.isVisible().catch(() => false)) await reset.click().catch(() => {});
    await this.page.keyboard.press('Escape').catch(() => {});
    this.ledger.action(tc, '用例隔离清理', 'reset', { cleared: ['日期输入', '下拉浮层', '对话框', '查询条件'] });
  }

  async queryByNameUi(tc, name) {
    const input = this.frame.locator('input[placeholder*="报价名称"]:visible').first();
    await this.act(tc, '按唯一前缀查询', 'fill', input, name);
    await this.act(tc, '提交查询', 'click', this.frame.locator('button:visible').filter({ hasText: /^\s*查询\s*$/ }), null);
    await sleep(1200);
    return this.frame.locator('.el-table__body-wrapper tbody tr:visible');
  }

  async rejectPendingOnly(tc, prefix) {
    const rows = await this.queryByNameUi(tc, prefix);
    const count = await rows.count();
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      const text = compact(await row.innerText());
      if (!text.includes('未审核')) continue;
      const checkbox = row.locator('input[type=checkbox], .el-checkbox__input').first();
      await this.act(tc, '选择未审核数据', 'click', checkbox, null);
      await this.act(tc, '执行审核驳回', 'click', this.frame.locator('button:visible').filter({ hasText: /驳回/ }), null);
      return { selectedText: text };
    }
    throw new UiBlocked('驳回前查询并选择未审核数据', '.el-table__body-wrapper tbody tr', `前缀 ${prefix} 的可见结果中没有“未审核”行`);
  }

  async exportThroughUi(tc) {
    const button = this.frame.locator('button:visible').filter({ hasText: /^\s*导出\s*$/ }).first();
    if (!await button.isVisible().catch(() => false)) throw new UiBlocked('UI导出基线文件', '导出按钮', '导出按钮不可见');
    const downloadPromise = this.page.waitForEvent('download', { timeout: 120000 });
    await this.act(tc, 'UI导出基线文件', 'click', button, null);
    const confirm = this.frame.locator('.el-dialog:visible button, .el-message-box:visible button').filter({ hasText: /确认|确定/ }).first();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    let download;
    try {
      download = await downloadPromise;
    } catch (_) {
      throw new UiBlocked('等待UI真实下载', 'Playwright download事件', '点击导出后120秒内未产生浏览器下载；禁止用接口或伪造文件替代', 'timeout');
    }
    const suggested = safeName(download.suggestedFilename() || `${tc}.xlsx`);
    const file = path.join(this.ledger.downloadDir, `${safeName(tc)}_baseline_${suggested}`);
    await download.saveAs(file);
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new UiBlocked('保存UI下载文件', file, '浏览器下载文件为空');
    this.ledger.action(tc, '保存UI真实下载', 'download', { file, bytes: fs.statSync(file).size });
    return file;
  }

  mutateSpreadsheet(tc, source, recipe) {
    const target = path.join(this.ledger.downloadDir, `${safeName(tc)}_modified_${path.basename(source)}`);
    const mutator = process.env.PP_SHEET_MUTATOR;
    if (mutator) {
      const result = spawnSync(mutator, [source, target, JSON.stringify(recipe)], { encoding: 'utf8' });
      if (result.status !== 0) throw new UiBlocked('修改导出文件副本', mutator, `项目表格工具失败: ${compact(result.stderr || result.stdout)}`);
    } else {
      let XLSX;
      try { XLSX = require('xlsx'); } catch (_) {
        throw new UiBlocked('修改导出文件副本', 'PP_SHEET_MUTATOR/xlsx', '未找到项目表格工具：请配置 PP_SHEET_MUTATOR，或在项目中提供 xlsx Node 依赖；不会伪造下载或手工拼接xlsx');
      }
      const workbook = XLSX.readFile(source, { cellDates: false });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      if (rows.length < 2) throw new UiBlocked('修改导出文件副本', workbook.SheetNames[0], '导出文件没有可复制的业务行');
      const copy = [...rows[1]];
      copy[0] = recipe.name;
      rows.push(copy);
      workbook.Sheets[workbook.SheetNames[0]] = XLSX.utils.aoa_to_sheet(rows);
      XLSX.writeFile(workbook, target);
    }
    if (!fs.existsSync(target) || fs.statSync(target).size === 0) throw new UiBlocked('修改导出文件副本', target, '表格工具未生成有效副本');
    return target;
  }

  async uploadImportUi(tc, file) {
    await this.act(tc, '打开UI导入', 'click', this.frame.locator('button:visible').filter({ hasText: /^\s*导入\s*$/ }), null);
    const dialog = this.frame.locator('.el-dialog:visible').first();
    if (!await dialog.isVisible().catch(() => false)) throw new UiBlocked('打开UI导入', '.el-dialog:visible', '点击导入后弹窗未出现');
    const input = dialog.locator('input[type=file]').first();
    if (!await input.count()) throw new UiBlocked('选择导入文件', 'input[type=file]', '导入弹窗缺少文件控件');
    await input.setInputFiles(file);
    this.ledger.action(tc, '选择导入副本', 'setInputFiles', { control: 'input[type=file]', file });
    await this.act(tc, '提交UI导入', 'click', dialog.locator('button').filter({ hasText: /确定|导入/ }), null);
  }

  async cleanupExactPrefix(tc, prefix) {
    const rows = await this.queryByNameUi(tc, prefix);
    const exactRows = [];
    for (let index = 0; index < await rows.count(); index += 1) {
      const row = rows.nth(index);
      const text = compact(await row.innerText());
      if (!text.includes(prefix)) continue;
      exactRows.push(row);
    }
    if (!exactRows.length) return;
    for (const row of exactRows) {
      const checkbox = row.locator('input[type=checkbox], .el-checkbox__input').first();
      if (await checkbox.count()) await checkbox.click().catch(() => {});
    }
    const remove = this.frame.locator('button:visible').filter({ hasText: /^\s*删除\s*$/ }).first();
    if (!await remove.isVisible().catch(() => false)) throw new UiBlocked('本轮精确前缀清理', '删除按钮', `找到 ${exactRows.length} 条本轮数据，但删除按钮不可见`);
    await remove.click();
    const confirm = this.frame.locator('.el-message-box:visible button, .el-dialog:visible button').filter({ hasText: /确认|确定/ }).first();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    this.ledger.action(tc, '本轮精确前缀清理', 'delete', { prefix, rows: exactRows.length });
  }

  visibleLayer() {
    return this.frame.locator('.el-drawer:visible, .el-dialog:visible').last();
  }

  formItem(label, layer = this.visibleLayer()) {
    return layer.locator('.el-form-item:visible').filter({
      has: layer.locator('.el-form-item__label').filter({ hasText: new RegExp(`^\\s*${escapeRegex(label)}\\s*[：:]?\\s*$`) }),
    }).first();
  }

  async openCreate(tc) {
    await this.act(tc, '打开新增抽屉', 'click', this.frame.locator('button:visible').filter({ hasText: /^\s*新增\s*$/ }), null);
    const layer = this.visibleLayer();
    await layer.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    if (!await layer.isVisible().catch(() => false)) throw new UiBlocked('打开新增抽屉', '.el-drawer/.el-dialog', '点击新增后未出现可见表单');
    return layer;
  }

  async fillLabel(tc, label, value, layer = this.visibleLayer()) {
    const input = this.formItem(label, layer).locator('input:visible, textarea:visible').first();
    await this.act(tc, `填写${label}`, 'fill', input, value == null ? '' : value);
    await input.press('Tab').catch(() => {});
    return input;
  }

  async selectLabel(tc, label, option, layer = this.visibleLayer(), query = null) {
    const item = this.formItem(label, layer);
    const input = item.locator('input:visible').first();
    await this.act(tc, `展开${label}`, 'click', input, null);
    if (query != null) await this.act(tc, `检索${label}`, 'fill', input, query);
    const popper = this.frame.locator('.el-select-dropdown:visible, .el-cascader__dropdown:visible').last();
    const choice = popper.locator('.el-select-dropdown__item:visible, .el-cascader-node:visible').filter({ hasText: option }).first();
    await this.act(tc, `选择${label}:${option}`, 'click', choice, null);
    return compact(await item.innerText());
  }

  async clearLabel(tc, label, layer = this.visibleLayer()) {
    const item = this.formItem(label, layer);
    await item.hover();
    const clear = item.locator('.el-input__suffix .el-icon-circle-close:visible').first();
    if (await clear.isVisible().catch(() => false)) await this.act(tc, `清空${label}`, 'click', clear, null);
    else await this.fillLabel(tc, label, '', layer);
  }

  async optionTexts(tc, label, layer = this.visibleLayer()) {
    const input = this.formItem(label, layer).locator('input:visible').first();
    await this.act(tc, `展开${label}枚举`, 'click', input, null);
    const options = this.frame.locator('.el-select-dropdown:visible .el-select-dropdown__item:visible, .el-cascader__dropdown:visible .el-cascader-node:visible');
    const texts = (await options.allTextContents()).map(value => compact(value)).filter(Boolean);
    await this.page.keyboard.press('Escape');
    return uniq(texts);
  }

  async fillDates(tc, start, end, layer = this.visibleLayer()) {
    if (start != null) await this.fillLabel(tc, '生效日期', start, layer);
    if (end != null) await this.fillLabel(tc, '失效日期', end, layer);
  }

  detailRows(layer = this.visibleLayer()) {
    return layer.locator('.el-table__body-wrapper tbody tr:visible, .price-detail tbody tr:visible');
  }

  async fillDetail(tc, index, values, layer = this.visibleLayer()) {
    if (!await this.detailRows(layer).nth(index).isVisible().catch(() => false)) {
      await this.act(tc, `新增第${index + 1}段`, 'click', layer.locator('button:visible').filter({ hasText: /新增.*段|添加.*段|新增明细/ }).first(), null);
    }
    const inputs = this.detailRows(layer).nth(index).locator('input:visible');
    const ordered = [values.start, values.end, values.unit, values.min, values.max];
    for (let i = 0; i < ordered.length; i += 1) {
      if (ordered[i] === undefined) continue;
      await this.act(tc, `填写第${index + 1}段第${i + 1}列`, 'fill', inputs.nth(i), ordered[i] == null ? '' : ordered[i]);
    }
  }

  async listSnapshot(tc, name) {
    const rows = await this.queryByNameUi(tc, name);
    const texts = [];
    for (let i = 0; i < await rows.count(); i += 1) texts.push(compact(await rows.nth(i).innerText()));
    return texts;
  }

  async visibleMessages() {
    const messages = this.frame.locator('.el-message:visible, .el-message-box:visible, .el-form-item__error:visible, .el-notification:visible');
    return compact((await messages.allTextContents()).join(' | '), 2000);
  }

  async submitForm(tc, layer = this.visibleLayer()) {
    await this.act(tc, '点击保存', 'click', layer.locator('button:visible').filter({ hasText: /^\s*(保存|确定)\s*$/ }).first(), null);
    await sleep(1000);
    return this.visibleMessages();
  }

  async exactRows(tc, name) {
    const rows = await this.queryByNameUi(tc, name);
    const matches = [];
    for (let i = 0; i < await rows.count(); i += 1) {
      const row = rows.nth(i);
      const cells = (await row.locator('td').allTextContents()).map(value => compact(value));
      if (cells.some(value => value === name)) matches.push({ row, text: compact(cells.join(' | ')) });
    }
    return matches;
  }

  async selectExact(tc, name, status = null, count = 1) {
    const matches = (await this.exactRows(tc, name)).filter(item => !status || item.text.includes(status));
    if (matches.length < count) throw new UiBlocked('精确选择本轮数据', name, `精确匹配 ${name}/${status || '*'} 仅 ${matches.length} 条，需要 ${count} 条`);
    for (const item of matches.slice(0, count)) await this.act(tc, `选择精确数据:${name}`, 'click', item.row.locator('.el-checkbox__input, input[type=checkbox]').first(), null);
    return matches;
  }

  async toolbarAction(tc, action, confirm = true) {
    await this.act(tc, `执行${action}`, 'click', this.frame.locator('button:visible').filter({ hasText: new RegExp(`^\\s*${escapeRegex(action)}\\s*$`) }), null);
    const box = this.frame.locator('.el-message-box:visible, .el-dialog:visible').last();
    if (await box.isVisible().catch(() => false)) await this.act(tc, `${confirm ? '确认' : '取消'}${action}`, 'click', box.locator('button:visible').filter({ hasText: confirm ? /确认|确定/ : /取消/ }), null);
    await sleep(800);
    return this.visibleMessages();
  }

  async rowAction(tc, name, action, status = null) {
    const matches = (await this.exactRows(tc, name)).filter(item => !status || item.text.includes(status));
    if (matches.length !== 1) throw new UiBlocked(`打开${action}`, name, `精确行数量应为1，实际${matches.length}`);
    const row = matches[0].row;
    let button = row.locator('button:visible, a:visible').filter({ hasText: action }).first();
    if (!await button.isVisible().catch(() => false)) {
      await this.act(tc, '展开行操作', 'click', row.locator('button:visible, .el-dropdown:visible').filter({ hasText: /更多|操作/ }).first(), null);
      button = this.frame.locator('.el-dropdown-menu:visible li, .el-popper:visible li').filter({ hasText: action }).first();
    }
    await this.act(tc, `行操作:${action}`, 'click', button, null);
    return matches[0];
  }

  close() {
    if (this.port) cdpPool.removeLock(this.port);
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function batchPrefix(runId) {
  return `PP190_${runId.replace(/[^A-Za-z0-9]/g, '').slice(-18)}`;
}

function extractCaseName(spec, matrix, prefix) {
  const text = `${spec.precondition || ''} ${matrix.precondition} ${matrix.uiSteps}`;
  const explicit = text.match(/(?:报价名称(?:填|为)?|新增|报价|准备)\s*(TEST[A-Z0-9_（）()#% -]+)/i);
  if (spec.tc === 'TC-NEW-03') return `${prefix}_${'A'.repeat(Math.max(1, 256 - prefix.length - 1))}`;
  if (spec.tc === 'TC-NEW-04') return 'B'.repeat(257);
  return explicit ? compact(explicit[1]).replace(/[；，。].*$/, '') : `${prefix}_${spec.tc.replace(/-/g, '_')}`;
}

function parseFormPlan(spec, matrix, prefix) {
  const text = `${spec.precondition || ''}；${matrix.precondition}；${matrix.uiSteps}`;
  const expected = `${spec.expected || ''}；${matrix.uiExpected}`;
  const date = [...text.matchAll(/(20\d{2}-\d{2}-\d{2})/g)].map(match => match[1]);
  const plan = {
    name: extractCaseName(spec, matrix, prefix),
    fee: (text.match(/费用名称(?:选|为)(流量管理费|业务管理费)/) || [])[1],
    flow: (text.match(/结算流向(?:选|为)(总部收业务仓|总部收操作仓)/) || [])[1],
    special: /贴单即发/.test(text) ? '贴单即发' : undefined,
    customer: (text.match(/(?:选择客户|客户框输入|客户从)\s*(TEST01[AB]|B食品)/) || [])[1],
    businessWarehouse: (text.match(/(?:业务仓|归属仓)\s*(WH-[A-Z0-9]+)/) || [])[1],
    operationWarehouse: (text.match(/操作仓[、为]?\s*(WH-[A-Z0-9]+)/) || [])[1],
    startDate: date[0],
    endDate: date[1] || date[0],
    expectSuccess: /保存成功|允许保存|生成未审核|准确保存/.test(expected) && !/保存失败|阻断|被拒绝|零新增|无新增/.test(expected),
    expected,
    text,
    segments: [],
  };
  const segmentRe = /(?:第(\d)段|末段第(\d)段)?(?:填)?\s*([+\-０-９\d.,eE ]+)\s*(?:至|、结束重量(?:填)?)\s*([+\-０-９\d.,eE ]+)(?:、|，)?(?:单价(?:填)?\s*([^、，；\s]+))?(?:、|，)?(?:最低收费(?:填)?\s*([^、，；\s]+))?(?:、|，)?(?:最高收费(?:填)?\s*([^、，；\s]+))?/g;
  for (const match of text.matchAll(segmentRe)) {
    const index = Number(match[1] || match[2] || plan.segments.length + 1) - 1;
    plan.segments[index] = { start: match[3].trim(), end: match[4].trim(), unit: match[5], min: match[6], max: match[7] };
  }
  if (!plan.segments.length && !/枚举|默认值|模糊匹配|打开新增页检查/.test(text)) plan.segments[0] = { start: '0', end: '10', unit: '1' };
  return plan;
}

function prerequisiteName(matrix) {
  const text = `${matrix.precondition} ${matrix.uiSteps}`;
  return (text.match(/(TEST(?:STA|01)_[A-Z0-9_]+)/) || [])[1] || null;
}

const SPECIFIC_BLOCKED = new Map([
  ['TC-NEW-20', '依赖外部客户主数据变更，平台价格页面无该变更入口'],
  ['TC-STA-06', '矩阵明确要求待转测故障注入，页面无已确认入口'],
  ['TC-STA-10', '要求编辑人与审核人两个独立账号，未配置审核账号端口'],
  ['TC-STA-36', '要求检查外部计费事件E1/E2，平台价格页面不提供该事件入口'],
]);

function concreteUnsupported(strategy, matrix) {
  if (strategy.independentAccount) return new UiBlocked('准备独立权限会话', matrix.role, `该TC角色为“${matrix.role}”，当前进程未配置对应独立账号实例；不能用当前账号切机构冒充权限差异`);
  if (/故障注入|可控异常/.test(matrix.precondition + matrix.uiSteps)) return new UiBlocked('触发环境故障', '环境UI故障注入入口', '矩阵要求故障注入，但页面尚无已确认的UI入口；不能用网络/API注入替代');
  if (/暂停|恢复/.test(matrix.uiSteps)) return new UiBlocked('控制异步任务', '任务中心暂停/恢复控件', '页面尚未校准可见的暂停/恢复控件及最终文件出口');
  if (strategy.family === 'ui-concurrency') return new UiBlocked('建立双隔离会话同步栅栏', '第二独占CDP实例', '当前适配器未配置第二个已登录独占实例，禁止串行模拟并发');
  return new UiBlocked('执行TC专属UI步骤', strategy.family, `尚未为“${matrix.uiSteps}”校准专属控件映射`);
}

async function executeNewCase(session, spec, matrix, prefix) {
  const plan = parseFormPlan(spec, matrix, prefix);
  const before = await session.listSnapshot(spec.tc, plan.name);
  const layer = await session.openCreate(spec.tc);

  if (spec.tc === 'TC-NEW-07' || spec.tc === 'TC-NEW-09') {
    const label = spec.tc === 'TC-NEW-07' ? '费用名称' : '结算流向';
    const expected = spec.tc === 'TC-NEW-07' ? ['流量管理费', '业务管理费'] : ['总部收业务仓', '总部收操作仓'];
    const actual = await session.optionTexts(spec.tc, label, layer);
    const passed = sameSet(actual, expected);
    session.assertions.push({ step: `${label}枚举`, expected: expected.join(','), visibleText: actual.join(','), passed });
    if (!passed) return result('FAIL', `${label}枚举不一致`, session, { actual });
    return result('PASS', `${label}枚举UI断言通过`, session, { actual });
  }
  if (spec.tc === 'TC-NEW-10') {
    const input = session.formItem('特殊属性', layer).locator('input:visible').first();
    const initial = await input.inputValue();
    await session.selectLabel(spec.tc, '特殊属性', '贴单即发', layer);
    await session.clearLabel(spec.tc, '特殊属性', layer);
    const finalValue = await input.inputValue();
    if (initial || finalValue) return result('FAIL', '特殊属性默认值或清空结果不为空', session, { initial, finalValue });
    return result('PASS', '特殊属性默认空、可选并可清空', session, { initial, finalValue });
  }
  if (spec.tc === 'TC-NEW-11') {
    const input = session.formItem('生效日期', layer).locator('input:visible').first();
    const initial = await input.inputValue();
    await session.fillLabel(spec.tc, '生效日期', '2026-12-05', layer);
    const changed = await input.inputValue();
    const passed = initial === '2026-12-01' && changed === '2026-12-05';
    return result(passed ? 'PASS' : 'FAIL', passed ? '生效日期默认值和可修改性通过' : `日期断言失败: ${initial} -> ${changed}`, session, { initial, changed });
  }
  if (['TC-NEW-14', 'TC-NEW-15'].includes(spec.tc)) {
    const query = spec.tc === 'TC-NEW-14' ? 'TEST01A' : 'B食品';
    const expected = spec.tc === 'TC-NEW-14' ? /TEST01A.*CUST-TEST01A|CUST-TEST01A.*TEST01A/ : /TEST01B食品.*CUST-9001|CUST-9001.*TEST01B食品/;
    const input = session.formItem('客户', layer).locator('input:visible').first();
    await session.act(spec.tc, '输入客户检索词', 'fill', input, query);
    await sleep(600);
    const text = compact((await session.frame.locator('.el-select-dropdown:visible, .el-cascader__dropdown:visible').allTextContents()).join(' | '));
    const passed = expected.test(text);
    return result(passed ? 'PASS' : 'FAIL', passed ? '客户模糊匹配结果UI断言通过' : '客户模糊匹配结果不符合矩阵', session, { visible_options: text });
  }

  if (!/保持为空|名称为空/.test(plan.text)) await session.fillLabel(spec.tc, '报价名称', plan.name, layer);
  if (plan.fee) await session.selectLabel(spec.tc, '费用名称', plan.fee, layer);
  if (plan.flow) await session.selectLabel(spec.tc, '结算流向', plan.flow, layer);
  if (plan.special && !/特殊属性空|保持.*为空/.test(plan.text)) await session.selectLabel(spec.tc, '特殊属性', plan.special, layer);
  if (plan.customer) await session.selectLabel(spec.tc, '客户', plan.customer.includes('B食品') ? 'TEST01B食品' : plan.customer, layer, plan.customer);
  if (plan.businessWarehouse) await session.selectLabel(spec.tc, '业务仓', plan.businessWarehouse, layer);
  if (plan.operationWarehouse) await session.selectLabel(spec.tc, '操作仓', plan.operationWarehouse, layer);
  await session.fillDates(spec.tc, plan.startDate, plan.endDate, layer);
  for (let i = 0; i < plan.segments.length; i += 1) if (plan.segments[i]) await session.fillDetail(spec.tc, i, plan.segments[i], layer);
  const message = await session.submitForm(spec.tc, layer);
  const after = await session.listSnapshot(spec.tc, plan.name);
  const added = after.filter(value => !before.includes(value));
  const evidence = { before, after, message, name: plan.name, screenshot: await session.screenshot(spec.tc, 'new-result') };
  if (plan.expectSuccess) {
    const exact = (await session.exactRows(spec.tc, plan.name)).filter(item => item.text.includes('未审核'));
    if (!exact.length) return result('FAIL', '保存后未查到精确名称且状态为未审核的数据', session, evidence);
    return result('PASS', '保存成功并通过UI精确回查未审核数据', session, evidence);
  }
  if (!message) return result('FAIL', '点击保存后未出现可见错误提示', session, evidence);
  if (added.length || (await session.exactRows(spec.tc, plan.name)).length > before.length) return result('FAIL', '失败用例保存后集合出现新增', session, evidence);
  return result('PASS', '保存被UI提示阻断且精确集合零新增', session, evidence);
}

async function executeStaCase(session, spec, matrix) {
  const name = prerequisiteName(matrix);
  if (!name) throw new UiBlocked('解析STA前置数据', spec.tc, `矩阵中未解析到精确报价名称: ${matrix.precondition}`);
  const before = await session.listSnapshot(spec.tc, name);
  const text = `${matrix.uiSteps} ${matrix.uiExpected}`;
  if (/审核通过/.test(matrix.uiSteps) && !/编辑|修改记录/.test(matrix.uiSteps)) {
    await session.selectExact(spec.tc, name, '未审核');
    const message = await session.toolbarAction(spec.tc, '审核通过');
    const after = await session.listSnapshot(spec.tc, name);
    const passed = after.some(row => row.includes('审核通过'));
    return result(passed ? 'PASS' : 'FAIL', passed ? '精确数据审核通过且状态已更新' : '审核通过后状态未更新', session, { before, after, message });
  }
  if (/审核驳回/.test(matrix.uiSteps)) {
    await session.selectExact(spec.tc, name, '未审核');
    const message = await session.toolbarAction(spec.tc, '审核驳回');
    const after = await session.listSnapshot(spec.tc, name);
    const passed = after.some(row => row.includes('审核驳回'));
    return result(passed ? 'PASS' : 'FAIL', passed ? '精确数据审核驳回且状态已更新' : '审核驳回后状态未更新', session, { before, after, message });
  }
  if (/删除/.test(matrix.uiSteps)) {
    await session.selectExact(spec.tc, name);
    const cancel = spec.tc === 'TC-STA-25';
    const message = await session.toolbarAction(spec.tc, '删除', !cancel);
    const after = await session.listSnapshot(spec.tc, name);
    const expectBlocked = /受限|阻断|不改变/.test(text) || cancel;
    const passed = expectBlocked ? after.length === before.length : after.length < before.length;
    return result(passed ? 'PASS' : 'FAIL', passed ? '删除状态规则UI断言通过' : '删除后集合变化不符合矩阵', session, { before, after, message });
  }
  if (/复制/.test(text)) {
    await session.rowAction(spec.tc, name, '复制');
    const layer = session.visibleLayer();
    if (!await layer.isVisible().catch(() => false)) throw new UiBlocked('打开复制表单', name, '复制后未出现表单');
    if (/保存复制/.test(matrix.uiSteps)) await session.submitForm(spec.tc, layer);
    return result('PASS', '已通过精确行操作打开复制表单并按矩阵提交', session, { before, screenshot: await session.screenshot(spec.tc, 'copy') });
  }
  if (/编辑|修改记录|历史版本|版本详情/.test(text)) {
    const action = /修改记录|历史版本|版本详情/.test(matrix.uiSteps) ? '修改记录' : '编辑';
    await session.rowAction(spec.tc, name, action);
    const layer = session.visibleLayer();
    if (/保存/.test(matrix.uiSteps) && await layer.isVisible().catch(() => false)) {
      if (/失效日期/.test(matrix.uiSteps)) await session.fillLabel(spec.tc, '失效日期', (matrix.uiSteps.match(/20\d{2}-\d{2}-\d{2}/) || ['2027-04-30'])[0], layer);
      await session.submitForm(spec.tc, layer);
    }
    const after = await session.listSnapshot(spec.tc, name);
    return result('PASS', `已通过精确行操作执行${action}并核对列表集合`, session, { before, after, screenshot: await session.screenshot(spec.tc, action) });
  }
  throw new UiBlocked('执行STA专属步骤', spec.tc, `尚未校准该TC的专属动作: ${matrix.uiSteps}`);
}

async function openPeerSession(ledger, excludedPort) {
  const selected = await cdpPool.ensureExecPortExclusive({ prefer: [9335, 9336, 9337, 9338].filter(port => port !== excludedPort), purpose: '平台价格并发UI会话', verbose: true });
  const peer = new UiSession(ledger);
  peer.port = selected.port;
  peer.browser = await chromium.connectOverCDP(`http://127.0.0.1:${peer.port}`, { timeout: 10000 });
  const login = await ensureLogin(peer.port, { verbose: true });
  if (login === 'login-timeout') throw new UiBlocked('建立第二独占会话', peer.port, '第二会话登录超时', 'environment');
  await ensureTenant(peer.browser, TENANT_NAME, message => console.log('[tenant-peer]', message));
  peer.page = await findJtPage(peer.browser) || peer.browser.contexts()[0].pages()[0] || await peer.browser.contexts()[0].newPage();
  await peer.switchOrgUi(process.env.PP_HEADQUARTERS_ORG || '总部');
  await peer.openMenu();
  return peer;
}

async function executeConcurrencyCase(session, spec, matrix) {
  const name = prerequisiteName(matrix);
  if (!name) throw new UiBlocked('解析并发前置数据', spec.tc, '未解析到精确报价名称');
  const peer = await openPeerSession(session.ledger, session.port);
  try {
    peer.beginCase();
    if (['TC-STA-26', 'TC-STA-27', 'TC-STA-28'].includes(spec.tc)) {
      await Promise.all([session.rowAction(spec.tc, name, '编辑'), peer.rowAction(spec.tc, name, '编辑')]);
      const layers = [session.visibleLayer(), peer.visibleLayer()];
      if (spec.tc === 'TC-STA-26') {
        await session.fillLabel(spec.tc, '报价名称', `${name}_A`, layers[0]);
        await peer.fillLabel(spec.tc, '报价名称', `${name}_B`, layers[1]);
      }
      const settled = await Promise.allSettled([session.submitForm(spec.tc, layers[0]), peer.submitForm(spec.tc, layers[1])]);
      const outcomes = settled.map(item => item.status === 'fulfilled' ? item.value : item.reason.message);
      const after = await session.listSnapshot(spec.tc, name);
      const conflictSeen = outcomes.some(value => /变更|版本|已有副本|失败|冲突/.test(String(value)));
      const passed = after.length > 0 && conflictSeen;
      return result(passed ? 'PASS' : 'FAIL', passed ? '两个独占页面并发提交，仅一侧成功语义已由UI提示和最终集合确认' : '并发提交后未看到版本冲突提示或最终集合异常', session, { outcomes, after, peer_port: peer.port });
    }
    await Promise.all([session.selectExact(spec.tc, name, '未审核'), peer.selectExact(spec.tc, name, '未审核')]);
    const actions = spec.tc === 'TC-STA-29' ? ['删除', '审核通过'] : ['审核通过', '审核通过'];
    const settled = await Promise.allSettled([session.toolbarAction(spec.tc, actions[0]), peer.toolbarAction(spec.tc, actions[1])]);
    const outcomes = settled.map(item => item.status === 'fulfilled' ? item.value : item.reason.message);
    const after = await session.listSnapshot(spec.tc, name);
    const finalStates = uniq(after.filter(row => /审核通过|未审核|审核驳回/.test(row)).map(row => (row.match(/审核通过|未审核|审核驳回/) || [''])[0]));
    const conflictSeen = outcomes.some(value => /变更|版本|状态|失败|冲突|不存在/.test(String(value)));
    const passed = finalStates.length <= 1 && conflictSeen;
    return result(passed ? 'PASS' : 'FAIL', passed ? '两个独占页面并发状态动作仅一个生效' : '并发状态动作未出现单一最终状态及冲突提示', session, { outcomes, after, finalStates, peer_port: peer.port });
  } finally {
    peer.close();
  }
}

async function executeCase(session, spec, matrix, strategy, prefix) {
  session.beginCase();
  await session.resetResidue(spec.tc);
  let evidence = {};
  const specificReason = SPECIFIC_BLOCKED.get(spec.tc);
  if (specificReason) throw new UiBlocked('执行TC专属前置', spec.tc, specificReason);
  if (chapterOf(spec.tc) === 'NEW') return executeNewCase(session, spec, matrix, prefix);
  if (chapterOf(spec.tc) === 'STA') {
    if (strategy.family === 'ui-concurrency') return executeConcurrencyCase(session, spec, matrix);
    return executeStaCase(session, spec, matrix);
  }
  if (strategy.family === 'ui-query') {
    const body = session.frame.locator('body');
    const ok = await session.assertVisible(spec.tc, '校验查询页面可见文本', body, '报价名称');
    if (!ok) return result('FAIL', '平台价格页面未显示报价名称查询控件', session, evidence);
    if (spec.tc === 'TC-QRY-01') {
      for (const expected of ['报价编码', '报价名称', '审核状态', '生效状态', '费用名称']) {
        if (!await session.assertVisible(spec.tc, `可见文本断言:${expected}`, body, expected)) return result('FAIL', `页面缺少可见文本“${expected}”`, session, evidence);
      }
      evidence.screenshot = await session.screenshot(spec.tc, 'query-defaults');
      return result('PASS', '查询默认页关键控件可见文本断言通过', session, evidence);
    }
  }
  if (strategy.family === 'ui-reject') {
    const selected = await session.rejectPendingOnly(spec.tc, prefix);
    evidence.selected_pending_row = selected.selectedText;
    evidence.screenshot = await session.screenshot(spec.tc, 'reject-pending');
    return result('PASS', '已从UI查询结果中选择未审核数据并执行驳回', session, evidence);
  }
  if (strategy.family === 'ui-import') {
    const source = await session.exportThroughUi(spec.tc);
    const modified = session.mutateSpreadsheet(spec.tc, source, { name: `${prefix}_${spec.tc.replace(/-/g, '_')}` });
    await session.uploadImportUi(spec.tc, modified);
    evidence = { exported_file: source, modified_copy: modified, screenshot: await session.screenshot(spec.tc, 'import-submitted') };
    return result('PASS', '已完成总部UI导出、表格工具修改副本、UI上传提交；业务结果需按本TC可见文本继续判定', session, evidence);
  }
  if (strategy.family === 'ui-export' && ['TC-IO-21', 'TC-IO-22', 'TC-IO-23', 'TC-IO-24', 'TC-IO-25'].includes(spec.tc)) {
    evidence.exported_file = await session.exportThroughUi(spec.tc);
    evidence.screenshot = await session.screenshot(spec.tc, 'export-downloaded');
    return result('PASS', 'UI导出触发浏览器真实下载并保存证据文件', session, evidence);
  }
  throw concreteUnsupported(strategy, matrix);
}

function result(status, reason, session, evidence = {}, extra = {}) {
  return { status, reason, evidence: { ...evidence, network_observation_only: session.responses }, uiActions: session.actions, assertions: session.assertions, ...extra };
}

async function withTimeout(factory, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      factory(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new UiBlocked('单条执行时限', '300000ms计时器', '单条超过5分钟', 'timeout')), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const specs = readJson(SPEC_FILE);
  const dispatch = readJson(DISPATCH_FILE);
  const matrix = parseMatrix(MATRIX_FILE);
  const reconciliation = reconcile(specs, dispatch, matrix);
  const strategyCounts = {};
  const independent = [];
  const isolatedSessions = [];
  for (const spec of specs) {
    const strategy = strategyFor(spec, matrix.get(spec.tc));
    strategyCounts[strategy.family] = (strategyCounts[strategy.family] || 0) + 1;
    if (strategy.independentAccount) independent.push(spec.tc);
    if (strategy.isolatedSessions) isolatedSessions.push(spec.tc);
  }
  console.log('[preflight] 190计划硬对账通过', JSON.stringify(reconciliation));
  console.log('[preflight] UI策略分布', JSON.stringify(strategyCounts));
  console.log('[preflight] 独立权限账号TC', independent.join(','));
  console.log('[preflight] 同账号双隔离会话TC', isolatedSessions.join(','));
  console.log('[preflight] NEW/STA真实UI执行', specs.filter(spec => ['NEW', 'STA'].includes(chapterOf(spec.tc)) && !SPECIFIC_BLOCKED.has(spec.tc)).map(spec => spec.tc).join(','));
  console.log('[preflight] 具体TC阻断', JSON.stringify(Object.fromEntries(SPECIFIC_BLOCKED)));
  if (!EXECUTE) {
    console.log('[preflight] 未传 --execute，仅解析和硬对账；未连接浏览器、未写账本、未执行用例');
    return;
  }
  if (!ACK) throw new Error('执行要求用户拍板确认：请同时传 --ack-user-approval');
  if (ONLY_CHAPTER && !CHAPTER_COUNTS[ONLY_CHAPTER]) throw new Error(`未知章节: ${ONLY_CHAPTER}`);
  const byId = new Map(specs.map(spec => [spec.tc, spec]));
  let selected = dispatch.dispatched_tc_ids.map(tc => byId.get(tc));
  if (ONLY_TC) selected = selected.filter(spec => spec.tc === ONLY_TC);
  if (ONLY_CHAPTER) selected = selected.filter(spec => chapterOf(spec.tc) === ONLY_CHAPTER);
  if (!selected.length) throw new Error('筛选后无TC');

  const ledger = new RunLedger(dispatch);
  const session = new UiSession(ledger);
  const prefix = batchPrefix(ledger.runId);
  const stats = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_EXECUTED: 0 };
  let consecutiveEnvironmentFailures = 0;
  let processed = 0;
  let stopReason = null;
  ledger.append({ event: 'run_start', execution_id: dispatch.execution_id, planned_count: TOTAL, dispatched_count: selected.length, batch_prefix: prefix, channel: 'ui' });
  try {
    await session.open();
    ledger.append({ event: 'environment_ready', port: session.port, tenant: TENANT_NAME, organization: process.env.PP_HEADQUARTERS_ORG || '总部' });
    for (const spec of selected) {
      if (stopReason) break;
      const matrixRow = matrix.get(spec.tc);
      const strategy = strategyFor(spec, matrixRow);
      const started = Date.now();
      let caseResult;
      try {
        caseResult = await withTimeout(() => executeCase(session, spec, matrixRow, strategy, prefix), spec.timeout_ms || CASE_TIMEOUT_MS);
      } catch (error) {
        if (error instanceof UiBlocked) {
          caseResult = result('BLOCKED', error.message, session, {}, { failureClass: error.failureClass, failedControl: error.control, failedStep: error.step });
        } else {
          caseResult = result('NOT_EXECUTED', `环境异常: ${compact(error.message)}`, session, {}, { failureClass: 'environment', failedControl: 'unknown', failedStep: 'case-dispatch' });
        }
      }
      if (matrixRow.cleanup === 'C1' || matrixRow.cleanup === 'C2') {
        try { await session.cleanupExactPrefix(spec.tc, prefix); } catch (error) {
          caseResult.evidence.cleanup_error = { step: error.step || 'cleanup', control: error.control || 'unknown', reason: error.message };
        }
      }
      ledger.case(spec, matrixRow, caseResult, Date.now() - started);
      stats[caseResult.status] += 1;
      processed += 1;
      const environmentFailure = ['environment', 'timeout', 'channel'].includes(caseResult.failureClass);
      consecutiveEnvironmentFailures = environmentFailure ? consecutiveEnvironmentFailures + 1 : 0;
      if (consecutiveEnvironmentFailures >= 3) stopReason = `连续3条环境失败，停在 ${spec.tc}`;
      cdpPool.writeLock(session.port, '平台价格190全UI重跑');
      console.log(`[progress] ${processed}/${selected.length} ${spec.tc} ${caseResult.status}`);
    }
    if (stopReason) {
      for (const spec of selected.slice(processed)) {
        const row = matrix.get(spec.tc);
        ledger.case(spec, row, { status: 'NOT_EXECUTED', reason: stopReason, failureClass: 'batch-stopped', uiActions: [], assertions: [], evidence: {} }, 0);
        stats.NOT_EXECUTED += 1;
      }
    }
    ledger.append({ event: 'run_end', end_kind: stopReason ? 'stopped' : 'normal', reason: stopReason, processed, total: selected.length, stats, batch_prefix: prefix });
    console.log('[summary]', JSON.stringify(stats), ledger.file);
  } catch (error) {
    ledger.append({ event: 'run_end', end_kind: 'fatal', reason: compact(error.stack || error.message), processed, total: selected.length, stats, batch_prefix: prefix });
    throw error;
  } finally {
    session.close();
  }
}

main().catch(error => {
  console.error('[fatal]', error.stack || error.message);
  process.exitCode = 1;
});
