#!/usr/bin/env node
/**
 * lanhu_reconcile.js — 采集文档 × 蓝湖原页 独立对账器（质检角色）
 *
 * 职责：对已采集的需求文档，独立重新导航到蓝湖对应菜单（与采集器共用 robustClickMenu——G64 同构铁律），
 *       深滚至高度稳定后取全部可见文本节点，逐节点核对是否存在于文档中；输出覆盖率与缺失清单。
 * 判据：节点级覆盖（live 文本节点归一化后须为文档子串）；非零退出=有缺失（对账红）。
 *
 * 用法：
 *   node lanhu_reconcile.js <端口> --doc "<文档绝对路径>" --menu "<树内菜单名>" [--min-chars 6]
 *   （一次一菜单；批量由技能层循环调用）
 * 输出：JSON { menu, doc, liveNodes, covered, missing: [{chars, preview}], coverage }
 */
const fs = require('fs');
const {
  connectBrowser, getLanhuPages, enterPrototype, robustClickMenu,
  scrollToBottom, findContentFrame, Logger,
} = require('./browser_utils');
const { resolveLanhuUrl } = require('./config_loader');

const norm = (s) => String(s || '').replace(/\s+/g, '');

(async () => {
  const A = {};
  process.argv.slice(2).forEach((s, i, arr) => { if (s.startsWith('--')) A[s.slice(2)] = arr[i + 1]; });
  const port = process.argv[2];
  const docPath = A.doc, menu = A.menu, minChars = parseInt(A['min-chars'] || '6', 10);
  if (!docPath || !menu) { console.error('need --doc --menu'); process.exit(2); }

  const logger = new Logger('lanhu_reconcile');
  const browser = await connectBrowser(logger);
  let pages = await getLanhuPages(browser);
  let page = pages[0];
  let opened = null;
  if (!page) {
    const ctx = browser.contexts()[0] || await browser.newContext();
    page = await ctx.newPage();
    opened = page;
    const url = resolveLanhuUrl();
    if (!url) { console.error('无蓝湖地址'); process.exit(2); }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => logger.warn('goto: ' + e.message));
    await page.waitForTimeout(3500);
    await enterPrototype(page, logger);
  }

  await robustClickMenu(page, menu, logger);
  // R1 内容侧校验（active 树态滞后不可靠——G64）：以 frame 内容首文本含菜单关键词或 frameUrl 变化为准
  const frame = await findContentFrame(page, logger);
  if (!frame) { console.error('NO_FRAME'); process.exit(2); }
  await scrollToBottom(frame, logger);

  const live = await frame.evaluate(() => {
    const out = [];
    document.querySelectorAll('[id$="_text"]').forEach(el => {
      const t = (el.innerText || '').trim();
      if (!t) return;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) out.push(t);
    });
    return out;
  });

  if (opened) { try { await opened.close(); } catch (e) {} }
  await browser.close();

  const docNorm = norm(fs.readFileSync(docPath, 'utf-8'));
  const targets = live.filter(t => norm(t).length >= minChars);
  const missing = [];
  let covered = 0;
  for (const t of targets) {
    if (docNorm.includes(norm(t))) covered++;
    else missing.push({ chars: norm(t).length, preview: t.replace(/\s+/g, ' ').slice(0, 80) });
  }
  missing.sort((a, b) => b.chars - a.chars);

  // ── G67：反向检查（doc→live）——文档里不得有蓝湖没有的内容（管道注释/幻觉/串页文本）──
  // 判据：正文行（跳过元信息头/表格行/图引/标题/空行）归一化后，须"整体或其任一 live 节片子串"能溯源到 live。
  const liveNorms = live.map(t => norm(t)).filter(t => t.length >= minChars);
  const liveAll = liveNorms.join('||');
  const liveAllFull = live.map(t => norm(t)).filter(Boolean).join('||'); // G67b：溯源用全量节点（含 3~5 字短列头，否则短列头拼行永判多余）
  const docLines = fs.readFileSync(docPath, 'utf-8').split('\n');
  const extras = [];
  for (const raw of docLines) {
    const l = raw.trim();
    if (!l || /^[#>|!]/.test(l)) continue;            // 标题/引用元信息/图引/表格行
    if (l.startsWith('|')) continue;
    const nl = norm(l);
    if (nl.length < minChars) continue;
    if (liveAllFull.includes(nl)) continue;            // 整行溯源命中
    // 分段溯源（G67b）：提取器会把同行多节点 join 成一行且短列头（<minChars）不进 liveNorms——
    // 行按空白切段，≥半数（且≥2字符的）段能在 liveAllFull 找到即视为有据；管道注释的独有短语段不会命中
    const segs = l.split(/\s+/).map(x => norm(x)).filter(x => x.length >= 2);
    if (segs.length) {
      const hit = segs.filter(sg => liveAllFull.includes(sg)).length;
      if (hit * 2 >= segs.length) continue;
    }
    extras.push(l.slice(0, 80));                        // 整行/分段均无据 → 多余项
  }

  const result = {
    menu, doc: docPath, liveNodes: live.length, targets: targets.length,
    covered, missingCount: missing.length,
    coverage: targets.length ? +(covered / targets.length).toFixed(4) : null,
    missingTop: missing.slice(0, 15),
    extraCount: extras.length, extraTop: extras.slice(0, 15),
  };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = (missing.length > 0 || extras.length > 0) ? 1 : 0; // 缺失或多余任一红=非零退出
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
