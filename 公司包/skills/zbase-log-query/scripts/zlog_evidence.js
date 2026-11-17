// zlog_evidence.js — 失败用例 ZBASE 日志取证封装（供执行引擎失败钩子 / 人工补证调用）
// 用法: node zlog_evidence.js <单号> [--apps app1,app2] [--days 1] [--outdir 目录] [--tag 用例号]
// 默认应用链（计费域）: ztocc-phecda-quote-wbms-mq,phecda-waccount-service
// 输出: stdout=汇总 JSON；<outdir>/zlog_<单号>.md=报告可 include 的 MD 片段（§20.10 失败卡片第七块）
// 降级: 单应用查询失败不中断（标 err 继续），登录态失效全部失败时输出 skip 标记——报告子块标"未取"不阻塞
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const args = process.argv.slice(2);
const kw = args[0];
if (!kw) { console.error("用法: node zlog_evidence.js <单号> [--apps a1,a2] [--days 1] [--outdir 目录] [--tag 用例号]"); process.exit(1); }
const opt = { apps: "ztocc-phecda-quote-wbms-mq,phecda-waccount-service", days: "1", outdir: ".", tag: "" };
for (let i = 1; i < args.length; i++) {
  if (args[i] === "--apps") opt.apps = args[++i];
  else if (args[i] === "--days") opt.days = args[++i];
  else if (args[i] === "--outdir") opt.outdir = args[++i];
  else if (args[i] === "--tag") opt.tag = args[++i];
}
const SCRIPT = __dirname + path.sep + "zlog_query.js";
const KEYWORDS = ["消费完成", "NO_QUOTE", "失败", "ERROR", "落库", "批次", "skip 无可结算", "无生效"];

function parseSample(sample, kw) {
  // zlog 结果区每条日志以 \t+时间戳 开头；按此切段
  const segs = String(sample).split(/\n\t/).map(s => s.replace(/\s+/g, " ").trim()).filter(s => /^\d{2}-\d{2} /.test(s) || s.length > 20);
  const errors = [];
  for (const s of segs) {
    if (/\bERROR\b/.test(s) && errors.length < 5 && !errors.includes(s.slice(0, 300))) errors.push(s.slice(0, 300));
  }
  // 关键行：含单号的段优先；不足再补业务关键词段（页面可能混排其它单号日志，单号过滤防噪音）
  const seen = new Set();
  const keylines = [];
  const push = s => { const k = s.slice(0, 80); if (!seen.has(k) && keylines.length < 8) { seen.add(k); keylines.push(s.slice(0, 300)); } };
  for (const s of segs) if (s.includes(kw)) push(s);
  for (const s of segs) if (KEYWORDS.some(k => s.includes(k))) push(s);
  return { errors, keylines };
}

(async () => {
  const stamp = new Date().toLocaleString("zh-CN", { hour12: false });
  const results = [];
  for (const app of opt.apps.split(",").map(s => s.trim()).filter(Boolean)) {
    try {
      const out = execFileSync("node", [SCRIPT, app, kw, opt.days], { env: { ...process.env, ZLOG_SAMPLE: "12000" }, encoding: "utf8", timeout: 90000 });
      const j = JSON.parse(out.slice(out.indexOf("{")));
      const p = parseSample(j.sample || "", kw);
      results.push({ app, total: j.total, timeBar: j.timeBar, ...p });
    } catch (e) { results.push({ app, err: String(e.message || e).slice(0, 120) }); }
  }
  // MD 片段
  const lines = [`**ZBASE 日志证据**（测试环境 · ${opt.days}天 · 查询 ${stamp}${opt.tag ? " · " + opt.tag : ""}）`];
  for (const r of results) {
    if (r.err) { lines.push(`- 应用 ${r.app}：❌ 未取（${r.err}）`); continue; }
    lines.push(`- 应用 \`${r.app}\` × 关键字 \`${kw}\`：${r.total} 命中`);
    for (const e of r.errors) lines.push(`  - ⚠️ ERROR：\`${e}\``);
    for (const k of r.keylines) lines.push(`  - \`${k}\``);
    if (!r.errors.length && !r.keylines.length) lines.push("  - （1.2万字符内无 ERROR/关键业务行，命中可能为模糊匹配噪音——建议换完整流水号复査）");
  }
  const md = lines.join("\n");
  const file = path.join(opt.outdir, `zlog_${String(kw).replace(/[^\w-]/g, "_")}.md`);
  fs.mkdirSync(opt.outdir, { recursive: true });
  fs.writeFileSync(file, md, "utf8");
  console.log(JSON.stringify({ kw, days: opt.days, apps: opt.apps, stamp, mdFile: file, results }, null, 1));
})().catch(e => { console.error(JSON.stringify({ kw, fatal: String(e.message || e).slice(0, 200) })); process.exit(1); });
