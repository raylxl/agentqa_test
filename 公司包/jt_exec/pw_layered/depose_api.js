/**
 * 流量沉淀工具（七元组 → 接口 spec 草稿 + 基准确认呈报 MD）—— 接口用例标准 §7.2 采集管道的沉淀步
 *
 * 输入：pw_runner UI 通道采集的 apicap/<execId>.jsonl（条目含 ctx.tc=spec绑定）或 netcap_daemon 会话文件（无 tc=整会话一组）
 * 输出（全部落 api_specs/_pending/，候选基准禁直入执行池——标准 §7.2.5）：
 *   ① <组>_<n>.api.spec.js 草稿：makeApiSpec 结构，draft:true（runSteps 直接阻塞）；
 *      变量化脚手架=${唯一.fN}（时间戳/长数字/TEST_名）与 ${=唯一.fN}（数值态保留），替换台账写在文件头
 *   ② _review_<ts>.md 呈报：候选断言逐条（步骤/层/路径/首录值/确认方式建议=回溯BL或拍板）→ 交 feedback-loop 五段式呈报拍板
 *
 * 用法：node depose_api.js --src apicap/AX-20261115-001.jsonl [--tc TC-P2-ADD28] [--out api_specs/_pending]
 * 定位：机械转换器；语义精修（变量归类四选一/exports 链/断言口径）由 AI 在草稿上续作，本工具不擅自定稿。
 */
const fs = require('fs');
const path = require('path');

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : def; }
const SRC = arg('src', '');
const OUT = path.resolve(__dirname, arg('out', path.join(__dirname, 'api_specs', '_pending')));
const TC_FILTER = arg('tc', '');

if (!SRC) { console.error('用法: node depose_api.js --src apicap/<file|dir>.jsonl [--tc TC-XX]'); process.exit(2); }

/* ── 载入 ── */
function loadFiles(src) {
  const st = fs.statSync(src);
  if (st.isDirectory()) return fs.readdirSync(src).filter(f => f.endsWith('.jsonl')).map(f => path.join(src, f));
  return [src];
}
const entries = [];
for (const f of loadFiles(SRC)) {
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch (_) { continue; }
    if (j.meta || j._done) continue;
    entries.push(j);
  }
}

/* ── §7.2.3 终判过滤（daemon 已滤静态/埋点，这里补终判） ── */
function isBusiness(e) {
  if (e.respStatus === undefined) return false;                       // 未完成请求
  if (e.respBody === '[binary]' || e.respBodyErr) return false;       // 二进制流不收
  if (/version\.json|favicon/i.test(e.url)) return false;             // 版本探测/图标不收
  const jsonish = /json/i.test(e.mime || '') || /^\s*[{[]/.test(e.respBody || '');
  // 默认只收 phecda 业务域；uas/merak=会话/权限基建（token 引导自有链路，重放无断言价值）——--include-infra 可放开
  const infra = process.argv.includes('--include-infra') ? '(phecda|uas|merak)' : 'phecda';
  const bizUrl = new RegExp('gateway-[^/]*\\.test\\.ztoeco\\.com/' + infra).test(e.url);
  return jsonish && bizUrl;
}
// 轮询/心跳排除（2026-11-15 修：原"同URL≥5次全排除"误杀步骤驱动的正当查询）：
// 频率判定=出现≥5次且相邻间隔中位数<2.5s 才算中间态（加载脉冲/心跳）；步骤驱动的查询间隔大，保留
const pollUrl = new Set();
{
  const byUrl = {};
  for (const e of entries) { const k = e.method + ' ' + e.url.split('?')[0]; (byUrl[k] = byUrl[k] || []).push(e.t); }
  for (const [k, ts] of Object.entries(byUrl)) {
    if (ts.length < 5) continue;
    const gaps = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    if (median < 2500) pollUrl.add(k);
  }
}
// 重试/并发去重：同 m+u+body 2 秒内只留首条（§7.2.4 调用序列还原）
const seen = new Map();
const biz = [];
for (const e of entries) {
  if (!isBusiness(e)) continue;
  if (pollUrl.has(e.method + ' ' + e.url.split('?')[0])) continue;
  const k = e.method + ' ' + e.url + ' ' + (e.reqBody || '');
  const last = seen.get(k);
  if (last && e.t - last < 2000) continue;
  seen.set(k, e.t);
  biz.push(e);
}

/* ── 分组：有 ctx.tc 按 UI 用例分组（pw_runner 采集），否则整会话一组（netcap_daemon） ── */
const groups = new Map();
for (const e of biz) {
  const g = (e.ctx && e.ctx.tc) || '(会话未绑定)';
  if (TC_FILTER && g !== TC_FILTER) continue;
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(e);
}

/* ── 变量化替换 + 候选断言 ── */
function paramize(text, subst, vars, kind) {
  // 长数字串/数值长id/TEST_前缀名 → ${唯一.fN} / ${=唯一.fN}（数值态）
  return text
    .replace(/"(\d{12,})"/g, (m, v) => { const k = addVar(vars, subst, v, kind); return '"${唯一.' + k + '}"'; })
    .replace(/(:\s*)(\d{10,})(\s*[},])/g, (m, a, v, b) => { const k = addVar(vars, subst, v, kind, true); return a + '${=唯一.' + k + '}' + b; })
    .replace(/"(TEST_[A-Za-z0-9_]+|LMN\d{6,}|LCN\d{6,}|WD\d{8,})"/g, (m, v) => { const k = addVar(vars, subst, v, kind); return '"${唯一.' + k + '}"'; });
}
function addVar(vars, subst, val, kind, numeric) {
  let k = Object.keys(vars).find(f => vars[f] === val);
  if (!k) { k = 'f' + (Object.keys(vars).length + 1); vars[k] = val; subst.push({ field: k, kind, numeric: !!numeric, 首录值: String(val).slice(0, 60) }); }
  return k;
}
function leafAsserts(node, prefix, out, depth) {
  if (depth > 3 || out.length >= 12) return;
  if (Array.isArray(node)) { leafAsserts(node[0], prefix + '.0', out, depth + 1); return; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const p = prefix + '.' + k;
      if (v && typeof v === 'object') { leafAsserts(v, p, out, depth + 1); continue; }
      // 信封字段（顶层 status/code/success/message/statusCode）归 L1，不做 L3 值候选
      if (prefix === 'body' && /^(status|code|success|message|msg|statusCode)$/i.test(k)) continue;
      if (/amount|fee|price|money|total|count|num|qty|status|state/i.test(k)) {
        // 路径保持点号全形态（data.list.0.fee）——getPath 按点取，数组下标即键，禁 [0] 语法
        out.push({ path: p.replace(/^body\./, ''), expect: v, mode: typeof v === 'number' ? 'numeric' : 'eq' });
      }
    }
  }
}
function structFields(node, prefix, out, depth) {
  if (depth > 2 || out.length >= 6) return;
  const rel = prefix === 'body' ? '' : prefix.replace(/^body\./, '') + '.';
  if (Array.isArray(node)) { structFields(node[0], prefix + '.0', out, depth + 1); return; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const kind = Array.isArray(v) ? 'array' : (v === null ? 'null' : typeof v);
      out.push([rel + k, kind]);
      if (v && typeof v === 'object') structFields(v, prefix + '.' + k, out, depth + 1);
    }
  }
}

/* ── 生成草稿 + 呈报 ── */
fs.mkdirSync(OUT, { recursive: true });
const now = new Date();
const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
const reviewRows = [];
let draftN = 0;

for (const [g, list] of groups) {
  const safe = g.toLowerCase().replace(/[^a-z0-9-]+/g, '_');
  const vars = {}; const subst = [];
  const steps = [];
  list.forEach((e, i) => {
    let url = e.url.replace(/^https?:\/\/[^/]+/, ''); // 域名环境注入：ctx.baseURL 承载
    url = url.replace(/([?&][\w-]+=)(\d{10,})/g, (m, a, v) => a + '${唯一.' + addVar(vars, subst, v, 'url参数') + '}');
    let bodyText = paramize(e.reqBody || '', subst, vars, '请求体');
    let rbody = null;
    try { rbody = JSON.parse(e.respBody || ''); } catch (_) {}
    const asserts = [{ layer: 'L1' }];
    const l2 = []; if (rbody) structFields(rbody, 'body', l2, 0);
    if (l2.length) asserts.push({ layer: 'L2', fields: l2 });
    const l3 = []; if (rbody) leafAsserts(rbody, 'body', l3, 0);
    for (const a of l3) { a.note = '候选基准·待拍板'; asserts.push({ layer: 'L3', ...a }); }
    steps.push({ name: `s${i + 1}`, method: e.method, url, mime: e.mime, bodyRaw: bodyText, asserts, respStatus: e.respStatus, t: e.t });
  });

  draftN++;
  const id = `API-DRAFT-${String(draftN).padStart(3, '0')}`;
  const file = path.join(OUT, `${safe}_${String(draftN).padStart(2, '0')}.api.spec.js`);
  const varLines = Object.keys(vars).map(k => `      ${k}: uniq('TEST_API_'), // 首录值: ${String(vars[k]).slice(0, 50)}`).join('\n');
  // url/body 用 JSON.stringify 出普通字符串字面量——占位符 ${唯一.x}/${=唯一.x} 必须是纯文本（runSteps 运行期解析），
  // 禁反引号模板字面量（${...} 会被 JS 当表达式在 require 期炸掉）
  const stepCode = steps.map(s => `    {
      name: '${s.name}', method: '${s.method}', url: ${JSON.stringify(s.url)},
      body: ${JSON.stringify(s.bodyRaw || '')},
      asserts: [
${s.asserts.map(a => '        ' + JSON.stringify(a) + ',').join('\n')}
      ],
    },`).join('\n');

  const tpl = `/**
 * ${id} · 接口草稿（draft=true 候选基准禁直入执行池——标准 §7.2.5）
 * 血缘：{ 源UI用例: '${g}', 菜单: '待补', 租户: '待补', 采集执行ID: '${path.basename(SRC).replace('.jsonl', '')}', 采集时间: '${new Date(list[0].t).toISOString()}' }
 * 采集来源：${SRC}（${list.length} 条业务请求）
 *
 * ⚠ 沉淀待办（AI 续作，本文件为机械转换稿）：
 *   ① 变量归类四选一（固定值/唯一生成/上游产出/环境注入——标准 §5）：
${subst.map(s => ` *      ${s.numeric ? '${=唯一.' + s.field + '}' : '${唯一.' + s.field + '}'} ← 首录 ${s.首录值}（${s.kind}）`).join('\n') || ' *      （无替换）'}
 *   ② 基准确认：L3「候选基准·待拍板」逐条回溯断言基线库 BL-xx 或呈报拍板，确认后才可去 draft；
 *   ③ exports 链内传递：跨步骤依赖（上游响应字段→下游入参）按标准 §2 显式映射补 exports；
 *   ④ 转正：正式编号 API-{域}-{序号} + 入总用例库接口用例/，迁出 _pending/。
 */
const { makeApiSpec, runSteps, uniq } = (() => { try { return require('../lib/api_channel'); } catch (_) { return require('../../lib/api_channel'); } })(); // _pending/ 与转正位两处通用

const META = {
  id: '${id}', title: '${g} 接口沉淀草稿', tenant: '待补', draft: true, // 基准确认拍板后置 false 并迁出 _pending
};

module.exports = makeApiSpec(META, async ({ ctx, log, vars }) => runSteps({
  draft: META.draft,
  steps: [
${stepCode}
  ],
  vars: Object.assign({
    唯一: {
${varLines || '      // （无）'}
    },
  }, vars),
  ctx, log,
}));
`;
  fs.writeFileSync(file, tpl);
  for (const s of steps) {
    for (const a of s.asserts) {
      if (a.layer === 'L3') reviewRows.push(`| ${id} | ${s.name} ${s.method} ${s.url.split('?')[0].slice(0, 60)} | L3 | ${a.path} | ${JSON.stringify(a.expect).slice(0, 60)} | 回溯BL或拍板 |`);
    }
  }
  console.log(`草稿 → ${file}（${steps.length} 步）`);
}

if (!draftN) { console.log('无符合 §7.2.3 收录条件的请求（源=' + SRC + '）'); process.exit(0); }

const review = path.join(OUT, `_review_${stamp}.md`);
fs.writeFileSync(review, `# 接口沉淀 · 候选基准确认呈报（${stamp}）

> 来源：${SRC}｜草稿 ${draftN} 份（api_specs/_pending/）｜纪律：首录值≠正确值（标准 §7.2.5），确认不了的标待拍板不得进执行池
> 呈报走 feedback-loop 五段式；本表为逐条拍板材料

| 草稿 | 步骤/接口 | 层 | 路径 | 首录值 | 确认方式 |
|---|---|---|---|---|---|
${reviewRows.join('\n') || '（本批无 L3 候选断言）'}
`);
console.log(`呈报 → ${review}（候选断言 ${reviewRows.length} 条）`);
console.log(`汇总：业务请求 ${biz.length}/${entries.length}，草稿 ${draftN} 份，组 ${[...groups.keys()].join(' / ')}`);
