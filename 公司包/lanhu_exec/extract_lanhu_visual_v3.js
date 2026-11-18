#!/usr/bin/env node
/**
 * extract_lanhu_visual_v3.js - 蓝湖 axure 内容 frame「截图 + 元素清单」合一
 *
 * 关键修正（相对 v2 的聚类法）：
 *   v2 用 img+小字聚类当 UI 区域种子 → 漏掉 input/select 构成的查询条件行 → 截图不全。
 *   本版 UI 区域改用「带边框的大容器」(border w>300 && h>100)，见 assemble_visual_md_v2.py。
 *   本脚本只负责：① 中和 transform + 展开滚动容器 + 撑高 iframe 到全文档；
 *                ② 对 iframe 元素 1:1 整图截图 → _frame_full.png；
 *                ③ dump 元素清单 _diag.json（imgs/leaves/borders/inputs/bigbg）；
 *                ④【v3.1 新增】leaf 增加 deco(删除线)/color/gray → 删除线/置灰机器可识别（A）；
 *                ⑤【v3.1 新增】按小节分块 clip 截图到 sections/ + _manifest.json（C，全局）；
 *                ⑥【v3.1 新增】每次采集自动归档到 collect_cache/<menu>/<ts>/；
 *                ⑦【v3.1 新增】--cache 增量重采：与旧缓存比对小节 sig，只重截 CHANGED 小节。
 *                ⑧【v3.2 新增】无蓝湖页签时自动新开并跳到「财务需求2026」项目（登录态走 Edge profile cookie）；
 *                   并改为「先点菜单导航、再找内容 frame」，兼容从项目总览页起步（无需人工开页签/点击）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  connectBrowser, getLanhuPages, withRetry, waitForStableContent,
  findContentFrame, findLanhuMenuItem, Logger,
} = require('./browser_utils');

// 蓝湖入口 = 访客邀请链接（无需登录即可查看需求内容）。
// 【2026-10-13 更新】旧地址为带 pid 的 web/#/item/... 项目链接，需会话、自动化一直卡「请重新登录」；
//   用户提供的访客邀请链接为公开分享入口，访客直接可看，后续所有蓝湖采集统一用此地址。
//   脚本自动新开页签跳此 URL；同一项目下点不同菜单即可采集不同需求（不锁定具体页，由下方点击菜单做 SPA 内导航）。
// 地址四层解析：--url 参数 → LANHU_URL env → 本机 lanhu_config.json（config_loader），不再硬编码 sid
const { resolveLanhuUrl, missingUrlHelp } = require('./config_loader');

function parseArgs() {
  const args = process.argv.slice(2);
  const o = { menu: '', outdir: path.join(__dirname, 'out', 'visual_out'), cache: '' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--menu') o.menu = args[++i];
    else if (args[i] === '--outdir') o.outdir = args[++i];
    else if (args[i] === '--cache') o.cache = args[++i];
  }
  return o;
}

/**
 * 稳健点击蓝湖左侧树菜单。
 * 蓝湖侧栏是自定义虚拟列表：默认 overflow:visible 且没有原生滚动容器，菜单项被绝对定位在
 * 视口外（top 可达 2400+），Playwright 的自动滚动/force 点击、scrollTop、wheel、文档滚动
 * 全部失效。实测对策：强制 .prototype-sidebar 为 overflow:auto 后 scrollTop 才生效，
 * 把目标项滚入可视区后再用普通 click（真实鼠标事件）触发 SPA 导航。
 */
async function robustClickMenu(page, menuName, logger) {
  const handle = await page.evaluateHandle((nm) => {
    const els = Array.from(document.querySelectorAll('.tree-item-wrapper, .tree-name'));
    return els.find(e => (e.textContent || '').trim() === nm) ||
           els.find(e => (e.textContent || '').includes(nm)) || null;
  }, menuName);
  const el = handle && handle.asElement();
  if (!el) throw new Error(`未找到菜单元素: ${menuName}`);

  for (let k = 0; k < 40; k++) {
    const box = await el.boundingBox();
    if (box && box.y >= 70 && box.y <= 680 && box.height > 0) break;
    // 把目标项中心滚到 ~y400
    await page.evaluate((nm) => {
      const s = document.querySelector('.prototype-sidebar');
      if (!s) return;
      const els = Array.from(document.querySelectorAll('.tree-item-wrapper, .tree-name'));
      const e = els.find(x => (x.textContent || '').trim() === nm) ||
               els.find(x => (x.textContent || '').includes(nm));
      if (!e) return;
      const r = e.getBoundingClientRect();
      s.scrollTop += (r.top + r.height / 2) - 400;
    }, menuName).catch(() => {});
    await new Promise(r => setTimeout(r, 120));
  }
  const box = await el.boundingBox();
  if (!box) throw new Error(`菜单元素无包围盒: ${menuName}`);
  logger.info(`点击菜单: ${menuName} @(${Math.round(box.x)},${Math.round(box.y)})`);
  await el.click({ timeout: 9000 });
}

// ---------- v3.1 新增：小节检测 / 截图 / 缓存 / 增量 ----------

function slugify(s) {
  return (s || '').replace(/[\\/:*?"<>|\n\r\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 24) || 'sec';
}

function isHeading(l) {
  const t = (l.text || '').trim();
  if (!t) return false;
  if (/^[\s]*[一二三四五六七八九十百零\d]+[、.．:]/.test(t)) return true; // 一、 1. 10．
  if (/^\(\d+\)/.test(t)) return true;                                  // (1) (2)
  if (/^\d+[）)]\s/.test(t)) return true;                               // 1） 2)
  if (l.fs >= 17) return true;                                          // 与 assemble 的 ## 阈值一致
  return false;
}

/**
 * 从 diag 计算小节列表：每个小节含标题、slug、y/x 范围、内容签名 sig（用于增量比对）。
 */
function computeSections(diag) {
  const leaves = diag.leaves.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const heads = [];
  leaves.forEach(l => { if (isHeading(l)) heads.push({ y: l.y, title: (l.text || '').trim().slice(0, 40) }); });
  if (heads.length === 0) heads.push({ y: 0, title: '全文' });

  const docH = diag.docH, docW = diag.docW;
  const secs = [];
  for (let k = 0; k < heads.length; k++) {
    const h = heads[k];
    const y0 = h.y;
    const y1 = (k + 1 < heads.length) ? heads[k + 1].y : docH;
    const band = leaves.filter(l => l.y >= y0 && l.y < y1);
    let x0 = 0, x1 = docW;
    if (band.length) {
      x0 = Math.max(0, Math.min.apply(null, band.map(l => l.x)) - 10);
      x1 = Math.min(docW, Math.max.apply(null, band.map(l => l.x + l.w)) + 10);
    }
    const sigSrc = band.map(l => `${l.text}|${l.deco || ''}|${l.color || ''}`).join('\n');
    const sig = crypto.createHash('md5').update(sigSrc).digest('hex').slice(0, 12);
    const slug = slugify(h.title) + '_' + String(k).padStart(3, '0');
    secs.push({
      title: h.title, slug,
      y0: Math.round(y0), y1: Math.round(y1),
      x0: Math.round(x0), x1: Math.round(x1),
      sig, file: `section_${String(k).padStart(3, '0')}_${slug}.png`,
      changed: true,
    });
  }
  return secs;
}

function writeLeavesText(diagPath, outPath) {
  const d = JSON.parse(fs.readFileSync(diagPath, 'utf8'));
  const ls = d.leaves.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = ls.map(l => `${l.y}|${l.x}|${l.tag}|${l.deco || ''}|${l.color || ''}|${l.text}`);
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function archiveCache(outDir, menu, logger) {
  const safe = (menu || 'menu').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const cacheDir = path.resolve(__dirname, 'out', 'collect_cache', safe, ts);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.copyFileSync(path.join(outDir, '_diag.json'), path.join(cacheDir, '_diag.json'));
  if (fs.existsSync(path.join(outDir, '_frame_full.png')))
    fs.copyFileSync(path.join(outDir, '_frame_full.png'), path.join(cacheDir, '_frame_full.png'));
  const secSrc = path.join(outDir, 'sections');
  if (fs.existsSync(secSrc)) copyDir(secSrc, path.join(cacheDir, 'sections'));
  writeLeavesText(path.join(outDir, '_diag.json'), path.join(cacheDir, 'leaves_text.txt'));
  logger.info(`已归档缓存: ${cacheDir}`);
  return cacheDir;
}

async function main() {
  const opt = parseArgs();
  const logger = new Logger('lanhu_visual_v3');
  if (!opt.menu) { logger.error('必须指定 --menu'); process.exit(1); }
  const browser = await connectBrowser(logger);

  // 访客邀请链接入口：优先复用已是邀请链接的页签；若当前蓝湖页签是 quickShare/登录拦截等非邀请态，
  // 则直接 goto 邀请链接（访客可见，无需登录），避免「复用登录拦截页→找不到菜单」或「用户状态冲突请重新登录」。
  let pages = await getLanhuPages(browser);
  let page = null;
  const invitePages = pages.filter(p => (p.url() || '').includes('link/#/invite'));
  const enterInvite = async () => {
    const ctx = await browser.newContext();            // 无痕 context，隔离默认 context 的冲突 cookie
    const pg = await ctx.newPage();
    await pg.goto(resolveLanhuUrl() || (console.error(missingUrlHelp()), process.exit(1)), { waitUntil: 'domcontentloaded', timeout: 30000 })
      .catch(e => logger.warn('邀请链接跳转异常(继续): ' + e.message));
    await pg.waitForTimeout(3500);
    const entered = await pg.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a, [class*="btn"], [class*="enter"]'));
      const b = btns.find(x => { const t = (x.textContent || '').trim(); return t === '进入' || t === '查看' || t.includes('查看原型') || t.includes('进入查看'); });
      if (b) { b.click(); return true; }
      return false;
    }).catch(() => false);
    if (entered) logger.info('已点击邀请页「进入/查看」按钮');
    await pg.waitForTimeout(3500);
    return pg;
  };
  // 就绪判据只看内容帧是否加载（axure iframe 是否存在），不以顶层页"请重新登录"横幅为准
  // （R11：顶部登录横幅是覆盖层，不阻断 iframe DOM 读取，据此误判"必须登录"属假阳性）
  const isReady = async (pg) => pg.evaluate(() =>
    document.querySelectorAll('iframe[src*="axure-file"]').length > 0).catch(() => false);

  if (invitePages.length && await isReady(invitePages[0])) {
    page = invitePages[0];
    logger.info('复用邀请链接页签(正常): ' + page.url().slice(0, 80));
  } else {
    if (invitePages.length) logger.warn('邀请链接页签未就绪，改开新无痕 context');
    else if (pages.length) logger.warn('现有蓝湖页非邀请链接，开新无痕 context 进访客态');
    else logger.info('无蓝湖页签，开新无痕 context 进访客态');
    page = await enterInvite();
  }
  if (!(await isReady(page))) {
    logger.error('蓝湖页面未就绪（内容帧 axure iframe 未加载），无法采集。请先确保蓝湖原型已正常渲染后重试。');
    process.exit(1);
  }
  await page.waitForTimeout(1500); // 等待左侧菜单树渲染
  // 导航阶段临时样式：仅放开侧栏原生滚动（截图阶段另有全量中和样式），流程结束统一移除。
  const navStyle = await page.addStyleTag({ content: '.prototype-sidebar{overflow-y:auto!important;overflow:auto!important}' });

  // v3.2：先点菜单导航到目标需求，再找内容 frame（兼容「从项目总览页起始」的场景）
  const sigOk = async () => {
    const t = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
    return t.includes('汇总账单') || t.includes(opt.menu) || t.includes('配送价格') || t.includes('通用计费');
  };
  try {
    // 蓝湖 SPA：Playwright 的 force click 在菜单项落在视口外时会失效（"outside of the viewport"）。
    // 改为「JS 滚动入视口（含祖先滚动容器校正）+ 真实鼠标坐标点击」。
    await robustClickMenu(page, opt.menu, logger);
    await waitForStableContent(page, { interval: 500, maxWait: 20000, stableCount: 2 });
  } catch (e) {
    logger.warn('菜单点击未成功: ' + e.message);
    if (!(await sigOk())) { logger.error('无法确认已在目标菜单'); process.exit(1); }
    logger.info('当前frame已是目标菜单内容，跳过点击继续');
  }

  const frame = await findContentFrame(page, logger);
  if (!frame) { logger.error('未找到内容frame'); process.exit(1); }

  await frame.evaluate(() => window.scrollTo(0, 0));
  await new Promise(r => setTimeout(r, 500));
  const dim = await frame.evaluate(() => ({
    docW: document.documentElement.scrollWidth, docH: document.documentElement.scrollHeight,
  }));

  const sizing = await page.evaluate(({ w, h }) => {
    let el = null;
    document.querySelectorAll('iframe').forEach(f => { if (!el && (f.src || '').includes('axure-file')) el = f; });
    if (!el) return { found: false };
    const dw = Math.max(document.documentElement.scrollWidth, w);
    const dh = Math.max(document.documentElement.scrollHeight, h);
    return { found: true, docW: dw, docH: dh };
  }, { w: dim.docW, h: dim.docH });
  if (!sizing.found) { logger.error('未找到 axure iframe'); process.exit(1); }
  logger.info(`全文档: ${sizing.docW}x${sizing.docH}`);
  // 注入临时样式：中和祖先 transform / 撑开滚动容器 / 撑大 axure iframe 到全文档尺寸。
  // 用注入 <style> 而非改元素 inline style → 截图后整段移除，页面零残留，杜绝「错位」。
  const shotStyle = await page.addStyleTag({ content:
    `* { transform: none !important; transform-origin: 0 0 !important; overflow: visible !important; max-height: none !important; }` +
    `iframe[src*="axure-file"] { width: ${sizing.docW}px !important; height: ${sizing.docH}px !important; }` });
  await new Promise(r => setTimeout(r, 800));
  await frame.evaluate(() => {
    document.querySelectorAll('*').forEach(el => {
      const s = getComputedStyle(el);
      if (s.overflowY === 'scroll' || s.overflowY === 'auto') el.scrollTop = 0;
      if (s.overflowX === 'scroll' || s.overflowX === 'auto') el.scrollLeft = 0;
    });
    window.scrollTo(0, 0);
  });
  await new Promise(r => setTimeout(r, 400));

  // 整图截图（保留作 R8 大图裁剪与兜底）
  const outDir = path.resolve(opt.outdir);
  fs.mkdirSync(outDir, { recursive: true });
  const handle = await page.$('iframe[src*="axure-file"]');
  if (!handle) { logger.error('未找到 iframe 元素句柄'); process.exit(1); }
  const pngPath = path.join(outDir, '_frame_full.png');
  await handle.screenshot({ path: pngPath, clip: { x: 0, y: 0, width: sizing.docW, height: sizing.docH } });
  logger.info(`iframe 整图: ${pngPath} (${fs.statSync(pngPath).size} bytes)`);

  // 元素清单（含 v3.1 新增 deco/color/gray）
  const inv = await frame.evaluate(() => {
    const norm = s => (s || '').replace(/\u00a0/g, ' ').trim();
    const rectOf = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
    const out = { imgs: [], leaves: [], borders: [], inputs: [], bigbg: [] };
    document.querySelectorAll('img').forEach(el => {
      const r = rectOf(el); if (r.w < 4 || r.h < 4) return;
      out.imgs.push({ ...r, src: (el.currentSrc || el.src || '').slice(0, 80) });
    });
    document.querySelectorAll('input,select,textarea').forEach(el => {
      const r = rectOf(el); if (r.w < 4 || r.h < 4) return;
      out.inputs.push({ ...r, tag: el.tagName.toLowerCase() });
    });
    document.querySelectorAll('*').forEach(el => {
      const tag = el.tagName;
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META'].includes(tag)) return;
      const r = rectOf(el); if (r.w <= 0 || r.h <= 0) return;
      const cs = getComputedStyle(el);
      const bw = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(v => parseFloat(v) || 0);
      if (bw.some(v => v > 0) && cs.borderTopStyle !== 'none') {
        out.borders.push({ ...r, tag: tag.toLowerCase(), id: (el.id || '').slice(0, 24), bw: Math.max(...bw), style: cs.borderTopStyle });
      }
      const bg = cs.backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)') {
        out.bigbg.push({ ...r, tag: tag.toLowerCase(), id: (el.id || '').slice(0, 24), bg });
      }
      if (el.childElementCount !== 0) return;
      const t = norm(el.innerText || ''); if (!t) return;
      const fsz = parseFloat(cs.fontSize) || 0;
      const fw = parseInt(cs.fontWeight, 10) || 400;
      // v3.1：删除线 + 颜色 + 置灰判定
      const decoRaw = (cs.textDecorationLine || cs.textDecoration || '').toLowerCase();
      const deco = decoRaw.includes('line-through') ? 'line-through' : '';
      const color = cs.color || '';
      let gray = false;
      const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(color);
      if (m) { const rr = +m[1], gg = +m[2], bb = +m[3]; if (Math.abs(rr - gg) < 18 && Math.abs(gg - bb) < 18 && Math.abs(rr - bb) < 18) gray = true; }
      out.leaves.push({ ...r, text: t.slice(0, 600), fs: Math.round(fsz * 10) / 10, fw, id: (el.id || '').slice(0, 24), tag: tag.toLowerCase(), deco, color, gray });
    });
    return out;
  });
  const diagOut = { docW: sizing.docW, docH: sizing.docH, menu: opt.menu, ...inv };
  fs.writeFileSync(path.join(outDir, '_diag.json'), JSON.stringify(diagOut), 'utf8');
  logger.info(`imgs=${inv.imgs.length} leaves=${inv.leaves.length} borders=${inv.borders.length} inputs=${inv.inputs.length}`);

  // v3.1：小节分块截图（全局，不只配送价格）
  const secDir = path.join(outDir, 'sections');
  fs.mkdirSync(secDir, { recursive: true });
  const secs = computeSections(diagOut);

  // v3.1：增量重采 -- 与旧缓存比对，只重截 CHANGED 小节
  if (opt.cache && fs.existsSync(opt.cache)) {
    const oldDiag = JSON.parse(fs.readFileSync(path.join(opt.cache, '_diag.json'), 'utf8'));
    const oldSecs = computeSections(oldDiag);
    const oldByTitle = new Map(oldSecs.map(s => [s.title, s]));
    const newTitles = new Set(secs.map(s => s.title));
    const report = [];
    for (const s of secs) {
      const o = oldByTitle.get(s.title);
      s.changed = !o || o.sig !== s.sig;
      report.push(`${s.changed ? 'CHANGED  ' : 'UNCHANGED'}  ${s.title}`);
      if (!s.changed) {
        const src = path.join(opt.cache, 'sections', s.file);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(secDir, s.file));
      }
    }
    for (const o of oldSecs) if (!newTitles.has(o.title)) report.push(`REMOVED    ${o.title}`);
    logger.info('增量重采报告:\n' + report.join('\n'));
  }

  // 逐小节 clip 截图（未变化的小节已从缓存复制，跳过）
  for (const s of secs) {
    if (opt.cache && s.changed === false) continue;
    const w = Math.max(1, s.x1 - s.x0), h = Math.max(1, s.y1 - s.y0);
    try {
      await handle.screenshot({ path: path.join(secDir, s.file), clip: { x: s.x0, y: s.y0, width: w, height: h } });
    } catch (e) {
      logger.warn(`小节截图失败 ${s.file}: ${e.message}`);
    }
  }
  fs.writeFileSync(path.join(secDir, '_manifest.json'),
    JSON.stringify({ menu: opt.menu, docW: sizing.docW, docH: sizing.docH, sections: secs }, null, 2), 'utf8');
  logger.info(`小节截图: ${secs.length} 个 → ${secDir}`);

  // 导出可读文本（供 refinement / diff 使用）
  writeLeavesText(path.join(outDir, '_diag.json'), path.join(outDir, 'leaves_text.txt'));

  // 移除全部临时注入样式（导航阶段 navStyle + 截图阶段 shotStyle），页面恢复原始布局，零残留。
  // Playwright 1.65：addStyleTag 返回 ElementHandle 无 .remove()——改 DOM remove + dispose（1.64 兼容）
  const removeStyle = async (h) => { if (!h) return; await h.evaluate(el => el.remove()).catch(() => {}); await h.dispose().catch(() => {}); };
  await removeStyle(shotStyle);
  await removeStyle(navStyle);
  logger.info('已移除临时样式(零残留)');

  // 自动归档缓存（含 diag/frame/sections/leaves_text）
  archiveCache(outDir, opt.menu, logger);

  process.exit(0);
}

main().catch(err => { console.error('执行失败: ' + err.message); process.exit(1); });
