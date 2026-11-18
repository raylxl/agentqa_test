/**
 * 参数化蓝湖需求重采管线（标准 v3 §11/§12 战法泛化版）
 * 用法: node lanhu_refetch_pipeline.js --menu "配送价格 10.?" --key "配送费" --tag psjg \
 *        [--imgdir "财务需求文档知识库/xxx_v3_images"] [--fullw]
 * 流程: 复用/新开页签(R21) → reload(R7) → 精确点菜单+R1回读 → 全量滚动 → 视觉坐标dump(R15) → 整带截图(R19) → label块保真拉取 → JSON落盘
 * 输出: out/<tag>_diag.json / <tag>_blocktexts.json / <tag>_shot_manifest.json + 图
 */
const { connectBrowser, getLanhuPages, findLanhuMenuItem, findContentFrame, Logger } = require('./browser_utils');
const fs = require('fs');
const path = require('path');

const A = {};
process.argv.slice(2).forEach((s, i, arr) => { if (s.startsWith('--')) A[s.slice(2)] = arr[i + 1]; });
const MENU = A.menu, KEY = A.key, TAG = A.tag;
const IMGDIR = A.imgdir ? A.imgdir : path.join(__dirname, 'out', `${TAG}_imgs`);
const FULLW = 'fullw' in A;
if (!MENU || !KEY || !TAG) { console.error('need --menu --key --tag'); process.exit(1); }

(async () => {
  require('fs').mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  const logger = new Logger(TAG);
  const browser = await connectBrowser(logger);
  const pages = await getLanhuPages(browser);
  if (!pages.length) { logger.error('NO PAGE'); process.exit(2); }
  let page = null, isNew = false;
  for (const p of pages) {
    const vp = await p.evaluate(() => ({ w: window.innerWidth })).catch(() => null);
    const has = await p.evaluate((m) => [...document.querySelectorAll('.tree-item-wrapper,.tree-name,[class*="tree-item"]')].some(x => (x.textContent || '').includes(m)), MENU.split(' ')[0]).catch(() => false);
    if (has && vp && vp.w > 400) { page = p; break; }
  }
  if (!page) {
    page = await pages[0].context().newPage(); isNew = true;
    await page.goto(pages[0].url(), { waitUntil: 'load', timeout: 45000 }).catch(e => logger.warn('goto ' + e.message));
    await page.waitForTimeout(6000);
  }
  logger.info((isNew ? 'NEW' : 'REUSE') + ' tab');

  // R7
  await page.reload({ waitUntil: 'load' }).catch(e => logger.warn('reload ' + e.message));
  await page.waitForTimeout(3500);

  // R1
  const item = await findLanhuMenuItem(page, MENU, logger).catch(() => null);
  if (item) await item.click({ timeout: 9000 }).catch(() => {});
  else await page.evaluate((m) => { const els = [...document.querySelectorAll('.tree-item-wrapper,.tree-name,[class*="tree-item"]')]; const e = els.find(x => (x.textContent || '').trim() === m) || els.find(x => (x.textContent || '').includes(m)); if (e) e.click(); }, MENU);
  await page.waitForTimeout(2500);
  const frame = await findContentFrame(page, logger);
  if (!frame) { logger.error('NO FRAME'); process.exit(2); }
  const rb = await frame.evaluate((k) => [...document.querySelectorAll('[id$="_text"]')].some(e => (e.innerText || '').includes(k)), KEY);
  if (!rb) { logger.error('R1 FAIL no key=' + KEY); process.exit(3); }
  logger.info('R1 OK');

  // 滚动渲染
  const H = await frame.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y <= H; y += 900) { await frame.evaluate((yy) => { [document.documentElement, document.body].forEach(c => { if (c && c.scrollHeight > c.clientHeight + 50) c.scrollTop = yy; }); window.scrollTo(0, yy); }, y).catch(() => {}); await page.waitForTimeout(120); }
  await frame.evaluate(() => { [document.documentElement, document.body].forEach(c => { if (c) c.scrollTop = 0; }); window.scrollTo(0, 0); }).catch(() => {});
  await page.waitForTimeout(600);

  // dump
  const data = await frame.evaluate(() => {
    const sy = window.scrollY || 0;
    const seq = [];
    document.querySelectorAll('[id$="_text"]').forEach(el => {
      const t = (el.innerText || '').trim();
      const r = el.getBoundingClientRect();
      if (t && r.width > 0 && r.height > 0) {
        let host = el.closest('.ax_default');
        seq.push({ k: 't', id: el.id, host: host ? host.id : '', top: Math.round(r.top + sy), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), len: t.length, head: t.replace(/\s+/g, ' ').slice(0, 50) });
      }
    });
    document.querySelectorAll('img').forEach(el => {
      const r = el.getBoundingClientRect();
      if ((el.naturalWidth || 0) >= 200 && (el.naturalHeight || 0) >= 120 && r.width > 0) {
        let host = el.closest('.ax_default');
        seq.push({ k: 'i', host: host ? host.id : '', top: Math.round(r.top + sy), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), src: (el.getAttribute('src') || '').slice(-40) });
      }
    });
    seq.sort((a, b) => (Math.abs(a.top - b.top) > 12 ? a.top - b.top : a.left - b.left));
    const cands = [];
    document.querySelectorAll('.ax_default').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width >= 350 && r.height >= 150) cands.push({ id: el.id || '', cls: (el.getAttribute('class') || '').slice(0, 36), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top + sy), left: Math.round(r.left), len: (el.textContent || '').trim().length, dAx: el.querySelectorAll('.ax_default').length });
    });
    const leaves = cands.filter(c => !cands.some(o => o.id !== c.id && o.w >= c.w && o.h >= c.h && o.top <= c.top && o.top + o.h >= c.top + c.h && (o.w > c.w || o.h > c.h)));
    const svgs = [];
    document.querySelectorAll('img[src$=".svg"]').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width >= 200 || r.height >= 100) svgs.push({ src: (el.getAttribute('src') || '').replace('./', ''), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top + sy), host: (el.closest('.ax_default') || {}).id || '' });
    });
    return { docH: document.documentElement.scrollHeight, docW: document.documentElement.scrollWidth, seq, bigC: cands.length, leaves, svgs };
  });
  fs.writeFileSync(path.join(__dirname, 'out', `${TAG}_diag.json`), JSON.stringify(data, null, 2), 'utf-8');
  logger.info(`docH=${data.docH} docW=${data.docW} seq=${data.seq.length} leaves=${data.leaves.length} svgs=${data.svgs.length}`);
  for (const l of data.leaves) logger.info(`LEAF ${l.id} ${l.w}x${l.h} top=${l.top} left=${l.left} cls=${l.cls.slice(0, 20)} dAx=${l.dAx} len=${l.len}`);

  // 带划分：按 leaves 大块(文本 label/box_2)与图片行聚合。策略：每 600px 内的图片+弹窗容器=一带；label 文本块独立记录
  // 简化整带计划：从 seq 聚"图片带"（连续 top 差<80 的 img 组）与"文本块带"（len>=200 的 label）
  const bands = [];
  let curImgs = [];
  const imgSeq = data.seq.filter(s => s.k === 'i');
  for (let i = 0; i < imgSeq.length; i++) {
    const im = imgSeq[i];
    if (curImgs.length && im.top - curImgs[curImgs.length - 1].top > 120) { bands.push({ kind: 'img', items: curImgs.slice() }); curImgs = []; }
    curImgs.push(im);
  }
  if (curImgs.length) bands.push({ kind: 'img', items: curImgs.slice() });

  fs.mkdirSync(IMGDIR, { recursive: true });
  const manifest = [];
  const geo = await page.evaluate(() => { const r = document.querySelector('iframe[src*="axure-file"]').getBoundingClientRect(); return { fx: r.x, fy: r.y }; });
  let bi = 0;
  for (const b of bands) {
    bi++;
    const top = Math.min(...b.items.map(x => x.top));
    const bot = Math.max(...b.items.map(x => x.top + x.h));
    const leftMost = Math.min(...b.items.map(x => x.left));
    const h = Math.min(bot - top + 24, 900);
    const w = FULLW ? data.docW : Math.min(Math.max(...b.items.map(x => x.left + x.w)) - leftMost + 40, data.docW);
    const name = `带${bi}_y${top}_图${b.items.length}`;
    await frame.evaluate((y) => { [document.documentElement, document.body].forEach(c => { if (c && c.scrollHeight > c.clientHeight + 50) c.scrollTop = Math.max(0, y - 180); }); window.scrollTo(0, Math.max(0, y - 180)); }, top).catch(() => {});
    await page.waitForTimeout(600);
    const vy = await frame.evaluate((y) => y - (window.scrollY || document.documentElement.scrollTop || 0), top);
    const clip = { x: geo.fx + Math.max(0, leftMost - 12), y: geo.fy + vy - 12, width: w, height: h };
    const file = path.join(IMGDIR, name + '.png');
    const ok = await page.screenshot({ path: file, clip, timeout: 30000 }).then(() => true).catch(e => { logger.warn('FAIL ' + name + ' ' + e.message.split('\n')[0]); return false; });
    if (ok) { manifest.push({ name, kind: b.kind, top, imgs: b.items.map(x => `${x.host}`), ok, kb: Math.round(fs.statSync(file).size / 1024) }); logger.info(`OK ${name}.png ${manifest[manifest.length - 1].kb}KB hosts=${b.items.map(x => x.host).join(',')}`); }
  }

  // 文本块拉取：全部 len>=150 的 label 宿主 + 章节标题短块
  const textIds = [...new Set(data.seq.filter(s => s.k === 't' && s.len >= 150).map(s => s.host).filter(Boolean))];
  const texts = await frame.evaluate((ids) => { const out = {}; for (const id of ids) { const el = document.getElementById(id); out[id] = el ? (el.innerText || '') : null; } return out; }, textIds).catch(() => ({}));
  fs.writeFileSync(path.join(__dirname, 'out', `${TAG}_blocktexts.json`), JSON.stringify(texts, null, 2), 'utf-8');
  logger.info(`texts=${Object.keys(texts).length} (len>=150)`);

  fs.writeFileSync(path.join(__dirname, 'out', `${TAG}_shot_manifest.json`), JSON.stringify({ taken: manifest.filter(m => m.ok).length, total: manifest.length, items: manifest }, null, 2), 'utf-8');
  if (isNew) await page.close().catch(() => {});
  logger.info(`PIPELINE DONE shots=${manifest.filter(m => m.ok).length}/${manifest.length}`);
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
