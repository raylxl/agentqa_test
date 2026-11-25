/**
 * collect_lanhu_req.js — 蓝湖需求采集通用脚本（终局版 v3 · 强制流程化）
 *
 * 设计目标（用户 2026-10-14 要求）：让每一次采集都走**同一套流程**、**同一套工具**，
 * 不再依赖一次性 probe_/capture_ 脚本救火；并用「前置分类器 + 后置验收闸门」把
 * "走错了就翻篇"变成"采集当时就过不了关"。
 *
 * 三道强制流程：
 *   阶段0 前置分类器（classifyDoc）：探测章节编号 scheme + 产物类型
 *           （real-img / hidden-img / axure-popup / 浮层），输出 doc-type 与预期产物清单。
 *   阶段2b 弹窗坐标裁剪（detectPopups + cropPopup）：把一次性 capture_fhf_shots.js 的
 *           「最小 ax_default 祖先包围盒 + page.clip 截图」收编为标准内置能力，
 *           自动处理 fhf 类「重算/适用报价」axure 控件组合弹窗（结构性非 img 资源）。
 *   阶段4 后置验收闸门（acceptanceGate）：采集产出结构化清单，与预期逐条对账；
 *           不一致则非零退出（硬性阻断），绝不声称完成。
 *
 * 用法（池化任务式——经 jt_exec/pool_run.sh 租实例，端口自动传入）：
 *   POOL_START=9334 bash ../jt_exec/pool_run.sh collect_lanhu_req.js \
 *        --menu "拼多多平台发货费账单 7.14/10.27" \
 *        --outdir "D:/ZCodetest/需求用例库/需求文档" \
 *        --name "财务需求2026_快运_拼多多平台发货费账单 7.14-10.27_v3" \
 *        --url "https://lanhuapp.com/link/#/invite?sid=xxx"   # 蓝湖地址四层解析第①层（产品发的链接）
 *   # 仅前置分类（不采集，先看 doc-type 与预期产物）：
 *   node collect_lanhu_req.js <端口> --menu "..." --outdir <目录> --classify-only
 *   # 声明预期（闸门据此硬阻断；维度省略则用自动推断值）：
 *   node collect_lanhu_req.js <端口> --menu "..." --outdir <目录> --expect "popups=4,imgs=0,sections=2"
 *   # 关闭弹窗自动裁剪（如某文档误检弹窗）：--popups off
 *   # 人工指定弹窗清单（JSON 文件，含 [{ids:[...],label:"重算弹窗"}]）：--popups spec:./popups.json
 *   # 临时关闭闸门（仅告警不阻断）：--no-gate
 *
 * 前置：Chrome 实例已由 browser_pool 租借（本脚本不自启浏览器）；无蓝湖页签时自动新开并 goto 邀请链接；
 *       收尾自动关本任务开的蓝湖页签（池化硬要求），实例归还由 pool_run.sh release 完成。
 */
const fs = require('fs');
const path = require('path');
const {
  connectBrowser, findContentFrame, Logger, scrollToBottom, extractLanhuContent,
  getLanhuPages, robustClickMenu
} = require('./browser_utils.js');
const { rebuildFlow, cdpShot2x } = require('./lanhu_flowmermaid.js');

// G91：流程图渲染库（mermaid npm 包里的浏览器单文件版，MIT，见 vendor/README_mermaid.txt）。
// 缺这个文件时流程图只出 Mermaid 源码、不出渲染图（采集照常，闸门只记数）。
const MERMAID_JS = path.join(__dirname, 'vendor', 'mermaid.min.js');
const FENCE = '```';

// 文件名安全化（菜单名含 / ？ : 等在 Windows 非法；未传 --name 时的兜底输出用）
function safeFileBase(A) {
  const raw = A.name || A.menu || 'lanhu_doc';
  return raw.replace(/[\/:*?"<>|]/g, '-').replace(/\s+/g, '_').slice(0, 80);
}
function parseArgs(argv) {
  const a = {
    menu: '', outdir: '', name: '',
    textOnly: false, imagesOnly: false, noMd: false,
    classifyOnly: false, expect: '', popups: 'auto', noGate: false
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--menu') a.menu = argv[++i];
    else if (k === '--outdir') a.outdir = argv[++i];
    else if (k === '--name') a.name = argv[++i];
    else if (k === '--text-only') a.textOnly = true;
    else if (k === '--images-only') a.imagesOnly = true;
    else if (k === '--no-md') a.noMd = true;
    else if (k === '--classify-only') a.classifyOnly = true;
    else if (k === '--expect') a.expect = argv[++i];
    else if (k === '--popups') a.popups = argv[++i];
    else if (k === '--no-gate') a.noGate = true;
    // --url 由 config_loader.resolveLanhuUrl 直接从 argv 解析（四层解析第①层），此处不占位
  }
  return a;
}

// 解析 --expect "popups=4,imgs=0,sections=2,hidden=1" → {popups:-1,...}
function parseExpect(s) {
  const e = { popups: -1, imgs: -1, sections: -1, hidden: -1, diagrams: -1 };
  if (!s) return e;
  for (const part of s.split(',')) {
    const [k, v] = part.split('=');
    if (k && v !== undefined && k in e) e[k] = parseInt(v, 10);
  }
  return e;
}

// 优先复用已打开的蓝湖页签（池化任务式：复用=同实例上次残留页签）；无则新开并 goto 邀请链接
// （地址四层解析：--url / LANHU_URL / 本机 lanhu_config.json；被拦降级到项目页时自动点 rp 文件进原型）
async function getPage(browser, openedPages, logger) {
  const lanhuPages = await getLanhuPages(browser);
  if (lanhuPages.length > 0) { logger.info(`复用蓝湖页签 ${lanhuPages[0].url().slice(0, 60)}`); return lanhuPages[0]; }
  const { resolveLanhuUrl, missingUrlHelp } = require('./config_loader');
  const url = resolveLanhuUrl();
  if (!url) { console.error(missingUrlHelp()); throw new Error('无蓝湖页签且未获得地址，无法开新页签'); }
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = await ctx.newPage();
  openedPages.push(page); // 池化收尾必关（防 IDLE_URL_RE 判忙锁死实例）
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => logger.warn('goto 邀请链接异常(继续): ' + e.message));
  await page.waitForTimeout(3500);
  const { enterPrototype } = require('./browser_utils');
  const rpName = (process.argv.includes('--rp') ? process.argv[process.argv.indexOf('--rp') + 1] : '财务需求2026');
  await enterPrototype(page, logger, rpName);
  return page;
}
// 全页图片块 + 章节标题(top)，一次 evaluate 保证坐标一致
function scanImagesAndHeadings() {
  const doc = document;
  const scrollY = Math.round(window.scrollY || doc.documentElement.scrollTop || 0);
  const all = [...doc.querySelectorAll('img,svg')];
  const imgs = [];
  all.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    // G77：panel_state（mockup 面板）内部的 img/svg 由面板截图整体覆盖——不重复拍散图（与对账器口径一致）
    const host = el.closest ? el.closest('.panel_state') : null;
    if (host) {
      const hr = host.getBoundingClientRect();
      if (hr.width >= 350 && hr.height >= 250) return;
    }
    let w = Math.round(r.width), h = Math.round(r.height);
    if (w <= 0 || h <= 0) {
      // 隐藏动态面板中的图（display:none）：rect 为 0 但 naturalWidth 有效 → 真实内容图
      if (el.tagName === 'IMG' && el.naturalWidth >= 200 && el.naturalHeight >= 120) {
        imgs.push({ index: i, id: el.id || '', tag: 'img', top: -1, w: el.naturalWidth, h: el.naturalHeight, hidden: true });
      }
      return;
    }
    // 过滤装饰性小图标/关闭按钮等（真实界面图均 >=200x120）
    if (w < 200 || h < 120) return;
    // G78：文字型位图识别——img 包围盒内有整段 axure 文本重叠（≥100 字符）= 产品把文字说明贴成图；
    // 文字已由文本提取覆盖（miss=0 证明），按用户拍板"内容是文字的用文字不用图"跳拍。
    // 实测：货量考核 6 张文字图 142~764 字符；真界面图（新增/编辑弹窗截图）0 字符。
    const y1 = r.top + scrollY, y2 = y1 + h;
    let overlapChars = 0;
    doc.querySelectorAll('[id$="_text"]').forEach(t => {
      const tr = t.getBoundingClientRect();
      if (tr.width <= 0 || tr.height <= 0) return;
      const ty = tr.top + scrollY;
      if (ty >= y1 && ty < y2) overlapChars += (t.innerText || '').replace(/\s+/g, '').length;
    });
    if (overlapChars >= 100) return;
    imgs.push({ index: i, id: el.id || '',
                tag: el.tagName.toLowerCase(),
                src: el.currentSrc || el.src || '',
                top: Math.round(r.top + scrollY), w, h });
  });
  imgs.sort((a, b) => a.top - b.top);
  // 通用章节标题（一、二、三… / 一）二）… / 优化点一/二/三），用于图片归属与命名
  const headRe = /^[一二三四五六七八九十]+[、）、]|^优化点[一二三四五六七八九十]+[：:]/; // G66：补识别"优化点N："——否则图片全归唯一章节尾部、界面图不跟优化点标题（货量考核实证）
  const heads = [];
  for (const el of doc.querySelectorAll('[id$="_text"]')) {
    const t = (el.innerText || '').trim();
    if (headRe.test(t)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) heads.push({ top: Math.round(r.top + scrollY), text: t });
    }
  }
  heads.sort((a, b) => a.top - b.top);
  return { imgs, heads, scrollHeight: doc.documentElement.scrollHeight };
}

// —— 前置分类器（阶段0）：探测 doc-type 与 预期产物清单 ——
// 章节编号 scheme + 产物类型（real-img / hidden-img / axure-popup / 浮层）
function classifyDoc() {
  const doc = document;
  const scrollY = Math.round(window.scrollY || doc.documentElement.scrollTop || 0);
  const headRe = /^[一二三四五六七八九十]+[、）、]/;
  const heads = [];
  for (const el of doc.querySelectorAll('[id$="_text"]')) {
    const t = (el.innerText || '').trim();
    if (headRe.test(t)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) heads.push({ top: Math.round(r.top + scrollY), text: t });
    }
  }
  heads.sort((a, b) => a.top - b.top);
  // scheme 判定
  let scheme = 'unknown';
  if (heads.some(h => /优化点/.test(h.text))) scheme = 'optimize';
  else if (heads.some(h => /^[一二三四五六七八九十]+、/.test(h.text))) scheme = 'cn-num-dot';
  else if (heads.length) scheme = 'cn-num';

  // 真实 img / svg（可见，>=200x120）
  let realImgs = 0;
  for (const el of doc.querySelectorAll('img,svg')) {
    const r = el.getBoundingClientRect();
    if (r.width >= 200 && r.height >= 120) realImgs++;
    else if (r.width <= 0 && el.tagName === 'IMG' && el.naturalWidth >= 200 && el.naturalHeight >= 120) realImgs++; // 隐藏面板图也算真实产物
  }
  // 弹窗簇计数在 Node 侧单独 evaluate(detectPopupsImpl) 完成（浏览器内无法跨函数引用）
  return {
    scheme,
    sections: heads.length,
    realImgs,
    heads,
    popupClusters: 0,
    popupNames: []
  };
}

// —— 弹窗簇探测（阶段2b 输入）：axure 控件组合弹窗 = 大间隙 + 按钮/触发标签的 _text 簇 ——
// 与 browser_utils.extractLanhuContent 的「浮层内容块」判定同源，保证检测与内联一致。
function detectPopupsImpl() {
  const nodes = [...document.querySelectorAll('[id$="_text"]')]
    .map(el => {
      const r = el.getBoundingClientRect();
      return {
        id: el.id, text: (el.innerText || '').trim(),
        top: Math.round(r.top + (window.scrollY || 0)),
        bottom: Math.round(r.bottom + (window.scrollY || 0))
      };
    })
    .filter(n => n.text.length > 0 && n.bottom > n.top)
    .sort((a, b) => a.top - b.top);
  const GAP = 220;
  const clusters = [];
  let cur = null;
  for (const n of nodes) {
    if (!cur) { cur = [n]; continue; }
    if (n.top - cur[cur.length - 1].bottom <= GAP) cur.push(n);
    else { clusters.push(cur); cur = [n]; }
  }
  if (cur) clusters.push(cur);
  const BTN = /^(确定|取消|关闭|保存|提交|重算|适用报价|新增|上传|查询条件|批量|导出|导入|筛选|选择)$/;
  const popups = [];
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    const prevBottom = i === 0 ? -Infinity : clusters[i - 1][clusters[i - 1].length - 1].bottom;
    const leadGap = i === 0 ? 0 : c[0].top - prevBottom;
    const hasBtn = c.some(n => BTN.test(n.text));
    const span = c[c.length - 1].bottom - c[0].top;
    if (leadGap > 250 && hasBtn && span > 60 && span < 1400) {
      // 名称：取簇内最短的按钮/触发标签，否则取首节点短文本
      let label = '';
      for (const n of c) { if (BTN.test(n.text)) { label = n.text; break; } }
      if (!label) label = c[0].text.slice(0, 6);
      popups.push({ ids: c.map(n => n.id), top: c[0].top, bottom: c[c.length - 1].bottom, name: label + '弹窗' });
    }
  }
  return popups;
}

// —— 弹窗坐标裁剪（一次性格外 capture_fhf_shots.js 的通用化收编）——
// 以簇内锚点 id 为种子向上找「包含全部锚点且面积≤文本并集 8 倍的最小 ax_default 祖先」
// = 弹窗精确边界 → frameElement().boundingBox() + 弹窗 viewport rect 合成 page 视口 clip 截图。
async function cropPopup(frame, page, feBox, cluster, imgDir, baseName, secName, n, logger) {
  // 先把簇滚入 iframe 视口
  await frame.evaluate((y) => window.scrollTo(0, Math.max(0, y - 250)), cluster.top).catch(() => {});
  await page.waitForTimeout(350);
  const info = await frame.evaluate((ids) => {
    const els = ids.map(id => document.getElementById(id)).filter(Boolean);
    if (!els.length) return null;
    const rects = els.map(e => e.getBoundingClientRect());
    const u = {
      left: Math.min(...rects.map(r => r.left)),
      top: Math.min(...rects.map(r => r.top)),
      right: Math.max(...rects.map(r => r.right)),
      bottom: Math.max(...rects.map(r => r.bottom))
    };
    let best = null, n0 = els[0];
    while (n0 && n0 !== document.body) {
      const r = n0.getBoundingClientRect();
      if (r.width > 0 && r.left <= u.left + 2 && r.top <= u.top + 2 && r.right >= u.right - 2 && r.bottom >= u.bottom - 2) {
        const area = r.width * r.height, ua = (u.right - u.left) * (u.bottom - u.top);
        if (area <= ua * 8) best = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, cls: (typeof n0.className === 'string' ? n0.className : '').slice(0, 50) };
      }
      n0 = n0.parentElement;
    }
    return { union: u, panel: best };
  }, cluster.ids);
  if (!info) { logger.warn('弹窗裁剪失败（无 rects）: ' + cluster.name); return null; }
  const usePanel = info.panel && (info.panel.right - info.panel.left) >= 280 && (info.panel.bottom - info.panel.top) >= 110;
  const r = usePanel ? info.panel : info.union;
  const pad = usePanel ? 4 : 22;
  const clip = {
    x: Math.max(0, feBox.x + r.left - pad),
    y: Math.max(0, feBox.y + r.top - pad),
    width: (r.right - r.left) + pad * 2,
    height: (r.bottom - r.top) + pad * 2
  };
  const file = `${secName}_弹窗${n}.png`;
  const ok = await page.screenshot({ path: path.join(imgDir, file), clip, timeout: 15000 }).then(() => true).catch(e => { logger.warn('弹窗截图失败 ' + cluster.name + ' ' + e.message); return false; });
  if (!ok) return null;
  return { file, ref: `![${secName}_弹窗${n}](${baseName}_images/${file})` };
}

// G91：Mermaid 源码 → PNG（2 倍图）。在同一浏览器上下文新开 about:blank 页、注入渲染库，拍完即关页。
// 兼作 Mermaid 语法的"可渲染"验证：渲染不出来就不把这段源码写进文档（该图退回"截图 + 逐行节点文字"）。
// 返回 'ok' | 'fail' | 'novendor'
async function renderMermaid(context, jsPath, id, src, pngPath, logger) {
  if (!fs.existsSync(jsPath)) return 'novendor';
  let rp = null;
  try {
    rp = await context.newPage();
    await rp.goto('about:blank');
    await rp.addScriptTag({ path: jsPath });
    const svg = await rp.evaluate(async (a) => {
      mermaid.initialize({
        startOnLoad: false, securityLevel: 'strict', theme: 'base',
        flowchart: { curve: 'linear', htmlLabels: true, nodeSpacing: 46, rankSpacing: 75, padding: 10 },
        themeVariables: { fontFamily: '"Microsoft YaHei","PingFang SC",sans-serif', fontSize: '14px', primaryColor: '#ffffff', primaryTextColor: '#222222',
          primaryBorderColor: '#666666', lineColor: '#00bfbf', secondaryColor: '#f5f5f5', tertiaryColor: '#ffffff', clusterBkg: '#ffffff' }
      });
      const r = await mermaid.render(a.id, a.src);
      return r.svg;
    }, { id, src });
    await rp.setContent('<!doctype html><html><body style="margin:0;background:#fff;padding:16px;overflow:hidden">' + svg + '</body></html>');
    const bb = await rp.evaluate(() => {
      const s = document.querySelector('svg'); const v = s.viewBox.baseVal;
      s.setAttribute('width', Math.ceil(v.width)); s.setAttribute('height', Math.ceil(v.height)); s.style.maxWidth = 'none';
      const r = s.getBoundingClientRect();
      return { w: Math.ceil(r.width), h: Math.ceil(r.height) };
    });
    const cdp = await context.newCDPSession(rp);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: bb.w + 120, height: bb.h + 120, deviceScaleFactor: 2, mobile: false });
    await rp.evaluate(() => document.fonts.ready);
    await rp.waitForTimeout(300);
    // G92：2 倍像素——走 CDP 直拍（page.screenshot 会归一成 1 倍像素尺寸）
    await cdpShot2x(cdp, { x: 0, y: 0, width: bb.w + 32, height: bb.h + 32 }, pngPath);
    return 'ok';
  } catch (e) {
    logger.warn('流程图渲染失败: ' + String((e && e.message) || e).split('\n')[0].slice(0, 140));
    try { if (fs.existsSync(pngPath)) fs.unlinkSync(pngPath); } catch (e2) {}
    return 'fail';
  } finally { if (rp) { try { await rp.close(); } catch (e) {} } }
}

// markdown 级界面残留清理（精确，不误删真实内容）
function cleanResidue(md) {
  // G91：围栏代码块（```mermaid 流程图源码等）整体保护——下面的残留清理规则只针对正文行，
  // 围栏内的语法行（如带"未审核 审核通过 审核驳回"枚举词的连线标注）碰上就会被整行删掉，把流程图删残
  const fences = [];
  md = md.replace(/```[^\n]*\n[\s\S]*?\n```/g, (m) => { fences.push(m); return '\u0000FENCE' + (fences.length - 1) + '\u0000'; });
  const lines = md.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (t === '查询 重置' || t === '查询重置') continue;
    if (/^99\+/.test(t)) continue;
    if (/(未审核|审核通过|审核驳回|未生效|生效中|已失效)/.test(t)
        && (t.match(/未审核|审核通过|审核驳回|未生效|生效中|已失效/g) || []).length >= 3
        && !/[。；;，]/.test(t)) continue;
    out.push(line);
  }
  let s = out.join('\n');
  // G65（2026-11-18 撤除）：曾有"政策列表整表删除"规则（表头含政策ID 或 政策名称+创建时间 → 整块删），
  // 系当年清某文档残留的一次性规则被误当管道通用规则——无差别处决了正文真实的政策/报价列表示例表
  //（空仓政策示例表整块丢失、货量考核第二张子表丢失实证）。按 R22 采集忠实：产品画的就是有的，
  // 管道不做内容级删除；确需清理的历史残留走 lanhu_verify --olds 显式清单逐文档指定。
  const arr = s.split('\n');
  const res = [];
  for (let i = 0; i < arr.length; i++) {
    res.push(arr[i]);
    const sepRe = /^\s*\|[\s:|-]+\|\s*$/;
    const prevIsTable = i === 0 ? false : arr[i - 1].trim().startsWith('|');
    const curIsTable = arr[i].trim().startsWith('|');
    const nextIsTable = i + 1 < arr.length && arr[i + 1].trim().startsWith('|');
    // G66c：前一行已是分隔行则不再插（双 --- 实证）；行首非表行也跳过
    const prevIsSep = i === 0 ? false : sepRe.test(arr[i - 1].trim());
    if (curIsTable && !prevIsTable && nextIsTable && !sepRe.test(arr[i + 1].trim()) && !prevIsSep) {
      const cols = (arr[i].match(/\|/g) || []).length - 1;
      res.push('|' + Array(cols).fill('---').join(' | ') + ' |');
    }
  }
  s = res.join('\n');
  // G66c：连续两条分隔行去重（extract 自带一条+历史插入残留一条；通用计费双 --- 实证）
  s = s.replace(/^(\s*\|[\s:|-]+\|\s*)\n\s*(\|[\s:|-]+\|)\s*$/gm, '$1');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.replace(/(优化点[一二三][^\n]*?)(?=\d、[基本信息查询数据导入历史使用考核])/g, '$1\n');
  s = s.replace(/\u0000FENCE(\d+)\u0000/g, (_, i) => fences[+i]); // G91：还原围栏块
  return s.trim() + '\n';
}

// 落盘前预警：检测「导入模版」等示例表是否被抓成单行挤行
function checkSqueezedTable(md, logger) {
  const lines = md.split('\n').filter(l => l.trim().startsWith('|'));
  if (lines.length < 2) return;
  const cols = (l) => (l.match(/\|/g) || []).length - 1;
  let headerCols = cols(lines[0]);
  for (let i = 1; i < lines.length; i++) {
    if (i + 1 < lines.length && /^[\s|:-]+$/.test(lines[i + 1])) { headerCols = cols(lines[i]); continue; } // 表头行（其后紧跟分隔行）=新表起点，各表各比
    if (/^[\s|:-]+$/.test(lines[i])) continue; // 分隔行
    const c = cols(lines[i]);
    if (headerCols > 0 && c > headerCols * 1.6) {
      logger.warn('⚠️ 疑似挤行表格（第' + (i + 1) + '行单元格数 ' + c + ' 远超表头 ' + headerCols + '），若为「导入模版」等示例表，请运行 probe_template_table.js 精确抠格重写');
      break;
    }
  }
}

// —— 后置验收闸门（阶段4）：结构化清单 × 预期 对账，不一致非零退出（硬阻断）——
function acceptanceGate(A, manifest, logger) {
  const e = parseExpect(A.expect);
  const fails = [];
  const report = [];
  const check = (dim, actual, expected) => {
    if (expected === undefined || expected === null) return;
    if (expected < 0) return; // -1 = 用自动推断，不单独卡此维
    report.push(`  · ${dim}: 实际=${actual} 预期=${expected}`);
    if (actual !== expected) fails.push(`${dim} 实际 ${actual} ≠ 预期 ${expected}`);
  };
  // 弹窗维度：未显式声明时，以"检测到的弹窗簇必须全部裁出"为硬约束
  if (e.popups >= 0) {
    check('弹窗截图数', manifest.popupCrops, e.popups);
  } else {
    report.push(`  · 弹窗截图数: 实际=${manifest.popupCrops} 自动期望=${manifest.popupClusters}（须全部裁出）`);
    if (manifest.popupCrops !== manifest.popupClusters) fails.push(`弹窗截图数 ${manifest.popupCrops} ≠ 检测到弹窗簇 ${manifest.popupClusters}（存在裁剪失败的弹窗，禁止声称完成）`);
  }
  if (e.imgs >= 0) check('真实图片数', manifest.realImgs, e.imgs);
  // G85：几何识别出的图示必须全部截到图（漏截=文字层拍扁而无结构图，税务信息维护 v1 实证）
  if (e.diagrams >= 0) check('图示截图数', manifest.diagramShots, e.diagrams);
  else {
    report.push(`  · 图示截图数: 实际=${manifest.diagramShots} 自动期望=${manifest.diagrams}（须全部截到）`);
    if ((manifest.diagrams || 0) !== (manifest.diagramShots || 0)) fails.push(`图示截图数 ${manifest.diagramShots} ≠ 几何识别图示数 ${manifest.diagrams}（存在未截图的流程图/图示，禁止声称完成）`);
  }
  // G91：每张图示必有去向（换成流程图块 / 退回逐行文字 / 拓扑未采信），四数之和须等于图示数
  {
    const em = manifest.flowEmitted || 0, nv = manifest.flowNoVendor || 0, fb = manifest.flowFallback || 0, un = manifest.flowUntrusted || 0;
    report.push(`  · 流程图去向: 源码块+渲染图=${em} 只出源码块(缺渲染库)=${nv} 退回逐行文字=${fb} 拓扑未采信=${un} 图示数=${manifest.diagrams}`);
    if (em + nv + fb + un !== (manifest.diagrams || 0)) fails.push(`流程图去向合计 ${em + nv + fb + un} ≠ 图示数 ${manifest.diagrams}（有图示既没出流程图也没走既定降级，禁止声称完成）`);
    if (nv) report.push('  · 提示: 缺 vendor/mermaid.min.js，流程图只出了源码、没出渲染图');
  }
  if (e.sections >= 0) check('章节数', manifest.sections, e.sections);
  if (e.hidden >= 0) check('隐藏面板图', manifest.hiddenImgs, e.hidden);
  // G95：正文非空——图片/图示/章节都对得上，但正文一个字没有（页面没渲染就采了），绝不能判 PASS 入库。
  // 判据：去掉文档头、图片引用、表格骨架线后的正文字符数须 ≥ 20（空文档实测为 0；最小的真实菜单也有上百字）
  {
    const bodyChars = String(A.finalMd || '').split('\n')
      .filter(l => !/^\s*$/.test(l) && !/^\s*!\[/.test(l) && !/^\|[:\-\s|]+\|\s*$/.test(l) && !/^#\s|^>\s*采集时间/.test(l))
      .join('').replace(/\s+/g, '').length;
    report.push(`  · 正文字符数: ${bodyChars}`);
    if (bodyChars < 20) fails.push(`正文字符数 ${bodyChars} < 20——页面未渲染就采集，产出的是空文档，禁止声称完成`);
  }

  logger.info('—— 验收闸门清单 ——');
  report.forEach(l => logger.info(l));
  // G82：验收清单落工具侧（lanhu_exec/out/manifests/），不进需求库——库只留 .md + _images/（用户拍板，总需求库干净）
  const manifestDir = path.join(__dirname, 'out', 'manifests');
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifestPath = path.join(manifestDir, safeFileBase(A) + '.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  logger.info('结构化清单已写: ' + manifestPath);

  if (fails.length) {
    logger.error('GATE FAIL（硬性阻断，未通过不得声称采集完成）:');
    fails.forEach(f => logger.error('  ✗ ' + f));
    return false;
  }
  logger.info('GATE PASS ✅');
  return true;
}

(async () => {
  const A = parseArgs(process.argv);
  if (!A.menu) { console.error('缺少 --menu'); process.exit(2); }
  if (!A.outdir) { console.error('缺少 --outdir（产物目录，如需求文档权威库绝对路径）'); process.exit(2); }
  const logger = new Logger('collect_lanhu_req');
  const openedPages = []; // 本任务 new 出的页签（收尾必关）
  let exitCode = 0;
  let browser = null;
  try {
  browser = await connectBrowser(logger);
  const page = await getPage(browser, openedPages, logger);
  const frame = await findContentFrame(page, logger);
  if (!frame) { logger.error('NO FRAME'); return exitCode = 2; }

  await robustClickMenu(page, A.menu, logger);
  // 点击后重找内容帧：axure 换页可能换 iframe，旧句柄滞留会滚/读错页（G64 配套）
  const frame2 = await findContentFrame(page, logger);
  const liveFrame = frame2 || frame;
  // G95（2026-11-24 全量重采·配送价格实证）：点击菜单后 axure 页偶发不渲染（文档高停在视口高 936、可见文字件 0），
  // 而一分钟后对账器访问同一菜单页面高 5539——是瞬时加载失败，不是页面无内容。旧流程照常往下采，产出 5 行 87 字的空文档，
  // 且内置闸门全绿（闸门只查图片/图示/章节数，没有"正文非空"）。对策：等到"文档高超过视口高 或 出现可见文字件"再往下走，最多等 60 秒。
  {
    const vh = await liveFrame.evaluate(() => window.innerHeight).catch(() => 936);
    let ok = false, last = '';
    for (let i = 0; i < 30; i++) {
      const s = await liveFrame.evaluate(() => ({
        h: document.documentElement.scrollHeight, n: (() => { let c = 0; document.querySelectorAll('[id$="_text"]').forEach(el => { const t = (el.innerText || '').trim(); if (!t) return; const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) c++; }); return c; })(),
      })).catch(() => null);
      last = s ? `文档高=${s.h} 可见文字件=${s.n}` : '取不到页面状态';
      if (s && (s.h > vh + 40 || s.n > 0)) { ok = true; break; }
      await page.waitForTimeout(2000);
    }
    if (!ok) {
      logger.error(`G95 页面未渲染（等待 60 秒后仍为：${last}；视口高=${vh}）——疑似蓝湖访客态被拦或加载失败，中止采集，不出空文档`);
      throw new Error('PAGE_NOT_RENDERED');
    }
    logger.info(`页面已渲染（${last}）`);
  }
  await scrollToBottom(liveFrame, logger).catch(e => logger.warn('scroll warn: ' + e.message));
  await liveFrame.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(500);

  // G65：axure repeater（列表）数据行异步渲染——不等到稳定就提取，未渲染行 rect=0 被零尺寸过滤丢弃
  // （11-18 空仓政策示例表整块丢失、货量考核第二张子表数据行丢失实证）。稳定判据=可见文本节点数连续两次一致。
  {
    let prev = -1, stable = 0;
    for (let i = 0; i < 25; i++) {
      const n = await liveFrame.evaluate(() => {
        let c = 0;
        document.querySelectorAll('[id$="_text"]').forEach(el => {
          const t = (el.innerText || '').trim(); if (!t) return;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) c++;
        });
        return c;
      }).catch(() => -1);
      if (n === prev && n >= 0) { stable++; if (stable >= 2) { logger.info(`repeater 渲染稳定（可见节点=${n}）`); break; } }
      else { stable = 0; prev = n; }
      await page.waitForTimeout(800);
    }
  }

  // —— 阶段0：前置分类器（每次必跑，输出 doc-type 与预期产物清单）——
  const cls = await liveFrame.evaluate(classifyDoc);
  logger.info(`[前置分类] doc-type: scheme=${cls.scheme} 章节=${cls.sections} 真实图片=${cls.realImgs}`);
  const detectedPopups = await liveFrame.evaluate(detectPopupsImpl);
  cls.popupClusters = detectedPopups.length;
  cls.popupNames = detectedPopups.map(p => p.name);
  logger.info(`[前置分类] 弹窗簇=${cls.popupClusters} 名称=[${cls.popupNames.join(', ')}]`);

  if (A.classifyOnly) {
    logger.info('仅分类，结束');
    fs.writeFileSync(path.join(A.outdir, safeFileBase(A) + '_classify.json'), JSON.stringify(cls, null, 2), 'utf-8');
    return; // exit 0
  }

  // 1) 正文（已验证保真，含浮层最近锚点内联）
  const ex = await extractLanhuContent(liveFrame);
  let md = ex.md;

  // G90：给第四道闸（lanhu_fidelity 文字忠实）供源——leaves_text.txt 此前只由旧路线 B 脚本落，
  // 现行路线 A 不写缓存，忠实闸实际在拿旧缓存（甚至无源）比对。这里落"本次采集所见"的可见文字与控件值。
  // 目录命名与路线 B 一致（collect_cache/<菜单名去非法字符>/<时间戳>/），两路线互认。
  if (ex.sourceLines && ex.sourceLines.length) {
    try {
      const safeMenu = (A.menu || 'menu').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
      const cacheDir = path.join(__dirname, 'out', 'collect_cache', safeMenu, new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, 'leaves_text.txt'), ex.sourceLines.join('\n') + '\n', 'utf-8');
      logger.info(`忠实闸源已落: collect_cache/${safeMenu}/…（${ex.sourceLines.length} 行）`);
    } catch (e) { logger.warn('忠实闸源落盘失败(不影响采集): ' + e.message); }
  }

  // G91：流程图还原为流程图（Mermaid）——蓝湖上画的是流程图，文档里也要以流程图样式展示（用户 2026-11-24 要求）。
  // 拓扑由页面几何机器重建（Axure 连接器箭头的 SVG 里自带整条连线路径），不靠模型看图；
  // 两套独立方法结果一致才采信，重建不出的保持"截图 + 逐行节点文字"。这里只做重建，
  // 是否替换进正文等渲染验证通过后再定（见 G85 图示截图段）：渲染不出来就不写源码。
  ex.diagrams = ex.diagrams || [];
  if (ex.diagrams.length) {
    const flowSvg = {};
    const srcs = new Set();
    ex.diagrams.forEach(d => { const g = d.geo || {}; [...(g.cells || []), ...(g.dots || [])].forEach(o => { if (o.src) srcs.add(o.src); }); });
    for (const s of srcs) {
      try { const resp = await page.context().request.get(s, { timeout: 15000 }); if (resp.ok()) flowSvg[s] = (await resp.body()).toString('utf-8').slice(0, 6000); } catch (e) {}
    }
    ex.diagrams.forEach((d, i) => {
      const r = rebuildFlow(d, src => flowSvg[src]);
      d.flow = r;
      if (r.ok) {
        logger.info(`流程图拓扑重建 #${i + 1}：${r.report.nodes} 节点 / ${r.report.arrows} 箭头 → ${r.report.methodA} 条连线，两法一致，流向 ${r.report.orient}`);
        if (r.report.gaps.length) logger.info(`  端点留缝 ${JSON.stringify(r.report.gaps)}（产品挪过节点框、连线用线段补缝）`);
      } else {
        const why = r.report.skip || (r.report.bad.length ? r.report.bad[0].why : (!r.report.agree ? '两套方法结果不一致' : '连线数或方向不满足'));
        logger.warn(`流程图拓扑重建 #${i + 1} 未采信（${why}）——该图保持截图 + 逐行节点文字`);
      }
    });
  }
  const inlineImgs = []; // G76：{top, ref} 全部图（画布图/查询条件带/弹窗裁剪/面板）按画布 y 内联到文字块之间

  // G69：查询条件带截图 + G75：mockup 面板截图（每弹窗一张完整图）——必须在任何滚动前截（extract 坐标=当刻视口）
  const baseName = A.name || ('财务需求2026_' + A.menu);
  const outDir = A.outdir;
  const imgDir = path.join(outDir, baseName + '_images');
  const bandShots = [];
  const panelShots = []; // G75：[{file, top, title}] 面板截图清单（阶段2按章节插入）
  let feBox = null;
  if ((ex.bands && ex.bands.length) || (ex.panels && ex.panels.length) || (ex.diagrams && ex.diagrams.length)) {
    fs.mkdirSync(imgDir, { recursive: true });
    const fe = await liveFrame.frameElement().catch(() => null);
    feBox = fe ? await fe.boundingBox() : null;
  }
  if (feBox) {
    // G71：宽带用全 iframe 宽（bd.left 起点窄会裁掉左侧字段标签）
    // G73：溢出区域左右两拍（内容完整已验证）→ 收尾 PIL 无缝拼接成一张（用户拍板"不拆两半"）
    const shootStrip = async (rect, file, tag) => {
      const files = [];
      const vw = Math.min(feBox.width - 8, 1900);
      const vh = await liveFrame.evaluate(() => window.innerHeight).catch(() => 1080);
      const regionH = Math.min(2400, Math.max(40, rect.bottom - rect.top + 40));
      const TOP_PAD = 40; // G74：带上区域上方紧邻的说明行（计费方式行被裁实证，垫6不够）
      const overflowX = rect.right > feBox.width - 8;
      const cdpUsed = false; // 两拍为主路径
        // —— 视口内单张 / 溢出时右张 ——
        await liveFrame.evaluate((y) => window.scrollTo(0, Math.max(0, y - 150)), rect.top).catch(() => {});
        await page.waitForTimeout(300);
        let curScroll = await liveFrame.evaluate(() => (window.scrollY || document.documentElement.scrollTop || 0)).catch(() => 0);
        let y = feBox.y + (rect.top - TOP_PAD - curScroll);
        if (y + regionH > feBox.y + vh) y = Math.max(feBox.y, feBox.y + vh - regionH);
        if (vw >= 60 && regionH >= 40 && y >= feBox.y - 5) {
          try {
            await page.screenshot({ path: path.join(imgDir, file), clip: { x: feBox.x + 4, y, width: vw, height: regionH + TOP_PAD }, timeout: 25000 });
            files.push(file);
            logger.info(`${tag} ${file}（${Math.round(vw)}x${Math.round(regionH)}）`);
          } catch (e) { logger.warn(`${tag}失败: ` + e.message.split('\n')[0]); }
        }
        if (overflowX) {
          const targetX = Math.max(vw - 60, rect.right - vw + 60);
          const scrolled = await liveFrame.evaluate((tx) => {
            const cands = [document.documentElement, document.body, ...document.querySelectorAll('*')].filter(el => el && el.scrollWidth > el.clientWidth + 4 && el.clientWidth > 400);
            const cont = cands.sort((a, b) => (b.scrollWidth - b.clientWidth) - (a.scrollWidth - a.clientWidth))[0] || document.documentElement;
            if (cont.scrollTo) cont.scrollTo(tx, cont.scrollTop || 0);
            if (cont === document.documentElement || cont === document.body) window.scrollTo(tx, window.scrollY);
            return { sl: cont.scrollLeft || window.scrollX || 0 };
          }, targetX).catch(() => null);
          await page.waitForTimeout(350);
          if (scrolled && (scrolled.sl || 0) > 30) {
            const f2 = file.replace(/\.png$/, '_右.png');
            curScroll = await liveFrame.evaluate(() => (window.scrollY || document.documentElement.scrollTop || 0)).catch(() => 0);
            const y2 = feBox.y + (rect.top - TOP_PAD - curScroll);
            try {
              await page.screenshot({ path: path.join(imgDir, f2), clip: { x: feBox.x + 4, y: Math.max(feBox.y, y2), width: vw, height: regionH + TOP_PAD }, timeout: 25000 });
              files.push(f2);
              logger.info(`${tag}右半 ${f2}（scrollLeft=${scrolled.sl}）`);
            } catch (e) { logger.warn(`${tag}右半失败: ` + e.message.split('\n')[0]); }
            await liveFrame.evaluate(() => window.scrollTo(0, curScroll)).catch(() => {});
          }
        }
      return files.length ? files : null;
    };
    for (let bi = 0; bi < (ex.bands || []).length; bi++) {
      const bd = ex.bands[bi];
      const r = await shootStrip(bd, `查询条件_${bi + 1}.png`, '查询条件带截图');
      bandShots.push(r);
      let fl = (r || []).flat().filter(Boolean);
      // G80：stitch 拼接可能把 _右 并入 base（文件消失）——此处同步过滤不存在的文件，防引用悬空
      fl = fl.filter(fn => fs.existsSync(path.join(imgDir, fn)));
      for (const fn of fl) inlineImgs.push({ top: bd.top, ref: `![查询条件_${bi + 1}](${baseName}_images/${fn})` });
    }
    // G75/G79：mockup 面板逐个一张图——元素级截图 el.screenshot（Playwright 自动滚动合成超视口整元素；
    // 审计实证：横排弹窗布局画布 4980 vs 视口 1640，5 个面板右缘超视口，page.clip 必截半——用户点破"截一半"根因）
    await liveFrame.evaluate((pans) => {
      document.querySelectorAll('[data-lanhu-panel]').forEach(el => el.removeAttribute('data-lanhu-panel'));
      document.querySelectorAll('.panel_state').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width < 350 || r.height < 250) return;
        const m = pans.find(p => Math.abs(Math.round(r.left) - p.left) <= 3 && Math.abs(Math.round(r.top + (window.scrollY || 0)) - p.top) <= 3);
        if (m) el.setAttribute('data-lanhu-panel', String(m.pi));
      });
    }, (ex.panels || []).map((p, i) => ({ left: p.left, top: p.top, pi: i }))).catch(() => {});
    for (let pi = 0; pi < (ex.panels || []).length; pi++) {
      const pn = ex.panels[pi];
      const safeT = (pn.title || '面板').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '').slice(0, 14);
      const f = `界面_${pi + 1}_${safeT}.png`;
      let done = false;
      // ① 元素级截图（主路径）
      try {
        const h = await liveFrame.$(`[data-lanhu-panel="${pi}"]`).catch(() => null);
        const el = h || null;
        if (el) {
          // G89：横向可滚动的面板（列表 mockup 的"列表明细"可视 959 宽、内容 3718 宽）——元素截图只拍得到可视部分，
          // 右侧十余列永远拍不到；iframe 外的内容也拍不到（"撑开面板"实测右半空白）。做法：面板按步横向滚动逐条截图，
          // 再按各自的滚动位置拼成整表一张（至多 8 条）。
          const strips = []; // {file, x}
          if ((pn.scrollW || 0) > (pn.clientW || 0) + 60 && (pn.scrollW || 0) <= 8000) {
            const step = Math.max(200, (pn.clientW || 0) - 40);
            for (let target = 0; strips.length < 8; target += step) {
              const sl = await el.evaluate((p, tx) => { p.scrollLeft = tx; return p.scrollLeft; }, target).catch(() => null);
              if (sl === null || (strips.length && sl <= strips[strips.length - 1].x)) break; // 滚不动了
              await page.waitForTimeout(150);
              const sf = f.replace(/\.png$/, `_条${strips.length + 1}.png`);
              const okS = await el.screenshot({ path: path.join(imgDir, sf), timeout: 30000 }).then(() => true)
                .catch(() => false);
              if (!okS) break;
              strips.push({ file: sf, x: sl });
              if (sl + (pn.clientW || 0) >= (pn.scrollW || 0) - 2) break; // 已滚到内容右缘
            }
            await el.evaluate((p) => { p.scrollLeft = 0; }).catch(() => {});
          }
          let ok = false;
          if (strips.length > 1) {
            const { execFileSync } = require('child_process');
            const dropStrips = (keepIdx) => strips.forEach((s, k) => { if (k !== keepIdx) { try { fs.unlinkSync(path.join(imgDir, s.file)); } catch (e) {} } });
            try {
              execFileSync(process.platform === 'win32' ? 'python' : 'python3',
                [path.join(__dirname, 'stitch_at.py'), path.join(imgDir, f), `--bottom-crop=${Math.max(0, (pn.bottom - pn.top) - (pn.clientH || 0))}`, ...strips.map(s => `${s.x}:${s.file}`)], { timeout: 60000 }); // 裁掉各条底部的横向滚动条带
              ok = fs.existsSync(path.join(imgDir, f));
              if (ok) { dropStrips(-1); logger.info(`面板横滚拼接 ${f}（${strips.length} 条）`); }
            } catch (e) {
              logger.warn('面板横滚拼接失败(只留首条): ' + String(e.message).slice(0, 80));
              try { fs.renameSync(path.join(imgDir, strips[0].file), path.join(imgDir, f)); ok = true; } catch (e2) {}
              dropStrips(-1);
            }
          } else if (strips.length === 1) {
            fs.renameSync(path.join(imgDir, strips[0].file), path.join(imgDir, f)); ok = true;
          } else {
            ok = await el.screenshot({ path: path.join(imgDir, f), timeout: 30000 }).then(() => true)
              .catch(e => { logger.warn(`面板元素截图失败 ${f}: ` + e.message.slice(0, 60)); return false; });
          }
          if (ok) {
            const fsx = require('fs');
            try {
              const buf = fsx.readFileSync(path.join(imgDir, f));
              if (buf.length > 2000 && buf.readUInt32BE(16) > 60) { // 有效 PNG 且宽>60
                panelShots.push({ file: f, top: pn.top, title: pn.title || '面板' });
                logger.info(`面板截图(元素级) ${f}（${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}）`);
                done = true;
              }
            } catch (e) {}
          }
        }
      } catch (e) { logger.warn(`面板元素路径异常 ${f}: ` + e.message.slice(0, 50)); }
      // ② 降级：旧 clip 法（视口内面板兜底）
      if (!done) {
        await liveFrame.evaluate((y) => window.scrollTo(0, Math.max(0, y - 80)), pn.top).catch(() => {});
        await page.waitForTimeout(280);
        const curScroll = await liveFrame.evaluate(() => (window.scrollY || document.documentElement.scrollTop || 0)).catch(() => 0);
        const vh2 = await liveFrame.evaluate(() => window.innerHeight).catch(() => 1080);
        const ph = Math.min(2400, pn.bottom - pn.top + 16);
        let y = feBox.y + (pn.top - 8 - curScroll);
        if (y + ph > feBox.y + vh2) y = Math.max(feBox.y, feBox.y + vh2 - ph);
        const w = Math.min(pn.right - pn.left + 16, feBox.width - 8);
        const x = Math.max(feBox.x, feBox.x + pn.left - 8);
        if (w >= 60 && ph >= 60 && y >= feBox.y - 5 && pn.right <= 1648) { // 右缘在视口内才走 clip（否则必截半，宁缺勿残）
          try {
            await page.screenshot({ path: path.join(imgDir, f), clip: { x, y, width: w, height: ph }, timeout: 25000 });
            panelShots.push({ file: f, top: pn.top, title: pn.title || '面板' });
            logger.info(`面板截图(clip降级) ${f}（${Math.round(w)}x${Math.round(ph)}）`);
            done = true;
          } catch (e) { logger.warn('面板clip失败 ' + f + ': ' + e.message.slice(0, 50)); }
        }
        if (!done) logger.warn(`面板截图失败（跳过，防半图）: ${f} [right=${pn.right}]`);
      }
    }
    await liveFrame.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    // G73 终案：查询条件带左右拍拼接 + 空白边裁剪（仅 bands；面板无横向溢出无需拼接）
    const bandFiles = bandShots.flat().filter(Boolean);
    if (bandFiles.length) {
      const { execFileSync } = require('child_process');
      const py = process.platform === 'win32' ? 'python' : 'python3';
      try {
        execFileSync(py, [path.join(__dirname, 'stitch_pairs.py'), imgDir], { timeout: 60000 });
        logger.info('左右拍拼接完成');
      } catch (e) { logger.warn('拼接失败(保留两拍): ' + String(e.message).slice(0, 80)); }
      try {
        execFileSync(py, [path.join(__dirname, 'trim_margin.py'), imgDir, ...bandFiles.filter(f2 => !f2.includes('_右'))], { timeout: 60000 });
        logger.info('空白边裁剪完成');
      } catch (e) { logger.warn('空白边裁剪失败(保留原图): ' + String(e.message).slice(0, 80)); }
    }
  }

  md = cleanResidue(md);
  logger.info('正文提取+残留清理完成（长度 ' + md.length + '）');

  if (A.textOnly) {
    fs.writeFileSync(path.join(A.outdir, safeFileBase(A) + '.raw.txt'), md, 'utf-8');
    logger.info('仅文本，结束'); return; // exit 0
  }

  // 2) 图片扫描 + 截图（按通用章节标题归属、语义化命名、过滤装饰图标）
  // G80（11-19 用户拍板"双版本并存"）：覆盖写前自动备份旧文档+图目录到 历史版本\采集覆盖备份_日期\——永不无备份覆盖
  {
    const dstMd = path.join(outDir, baseName + '.md');
    if (fs.existsSync(dstMd)) {
      const bakDir = path.join(outDir, '历史版本', '采集覆盖备份_' + new Date().toISOString().slice(0, 10).replace(/-/g, ''));
      fs.mkdirSync(bakDir, { recursive: true });
      let bakMd = path.join(bakDir, baseName + '.md');
      let n = 1;
      while (fs.existsSync(bakMd)) bakMd = path.join(bakDir, baseName + '_' + (n++) + '.md');
      fs.copyFileSync(dstMd, bakMd);
      const dimg = path.join(outDir, baseName + '_images');
      if (fs.existsSync(dimg)) fs.cpSync(dimg, bakMd.slice(0, -3) + '_images', { recursive: true });
      logger.info('G80 已备份旧文档 → ' + path.relative(outDir, bakMd));
    }
  }
  fs.mkdirSync(imgDir, { recursive: true });

  const { imgs, heads, scrollHeight } = await liveFrame.evaluate(scanImagesAndHeadings);
  // G70：heads 按归一化标题去重（画布常把同一 mockup 重复画 N 次=同名标题多条；indexOf 全塌第一处→空块重复追加同组图引用 ×N）
  const seenHead = new Set();
  const uniqHeads = heads.filter(h => {
    const k = h.text.replace(/\s+/g, '');
    if (seenHead.has(k)) return false;
    seenHead.add(k); return true;
  });
  logger.info(`图片块=${imgs.length}（已过滤装饰图标 w<200||h<120） 章节标题=${heads.map(h => h.text).join(' / ')} 文档高=${scrollHeight}`);
  if (scrollHeight > 6000) logger.warn(`⚠️ 文档高 ${scrollHeight} 异常（正常≤~3500），可能异常渲染，建议先跑 reload_lanhu.js 再采集`);

  const sectionShort = (text) => text.replace(/[、）、\s]/g, '').slice(0, 8) || '图';
  const sectionIndexOf = (top) => {
    let idx = -1;
    for (let i = 0; i < uniqHeads.length; i++) { if (top >= uniqHeads[i].top) idx = i; }
    return idx;
  };
  const allEls = await liveFrame.$$('img,svg');
  const sectionImgs = new Map();
  const hiddenRefs = [];
  const counters = {};
  const missedShots = []; // 截图未落地清单（闸门判红：MD 引用必须与文件一一对应）
  let hiddenN = 0;
  let realImgsCount = 0;
  for (let i = 0; i < imgs.length; i++) {
    const im = imgs[i];
    if (im.hidden) {
      hiddenN++;
      const file = `隐藏图_待定位${hiddenN}_${im.w}x${im.h}.png`;
      const dataUrl = await liveFrame.evaluate((idx) => {
        const el = document.querySelectorAll('img,svg')[idx];
        if (!el || el.tagName !== 'IMG' || !el.src) return null;
        return fetch(el.src).then(r => r.blob()).then(b => new Promise(res => {
          const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(b);
        })).catch(() => null);
      }, im.index).catch(() => null);
      if (dataUrl && dataUrl.startsWith('data:image')) {
        fs.writeFileSync(path.join(imgDir, file), Buffer.from(dataUrl.split(',')[1], 'base64'));
        hiddenRefs.push(`![${file.replace('.png', '')}](${baseName}_images/${file})`);
        logger.info(`隐藏面板图 ${file}（natural ${im.w}x${im.h}，无画布坐标，已列入待人工定位清单）`);
      } else {
        logger.warn('隐藏面板图抓取失败 idx=' + im.index);
      }
      continue;
    }
    realImgsCount++;
    const secIdx = sectionIndexOf(im.top);
    const key = secIdx < 0 ? '__pre__' : secIdx;
    counters[key] = (counters[key] || 0) + 1;
    const n = counters[key];
    const secName = secIdx < 0 ? '前置' : sectionShort(heads[secIdx].text);
    const file = `${secName}_图${n}.png`;
    const el = allEls[im.index];
    let shotOk = false;
    // G79：原图下载优先（审计：蓝湖 img= http 原图 1:1 显示 complete）——比屏幕截图更保真（原分辨率、不受视口/渲染摆布）
    if (im.src && (im.src.startsWith('http') || im.src.startsWith('data:'))) {
      try {
        let buf = null;
        if (im.src.startsWith('data:')) {
          const b64 = im.src.split(',')[1];
          if (b64) buf = Buffer.from(b64, 'base64');
        } else {
          const resp = await page.context().request.get(im.src, { timeout: 20000 });
          if (resp.ok()) buf = await resp.body();
        }
        if (buf && buf.length > 2000 && buf[0] === 0x89 && buf[1] === 0x50) { // PNG 魔数校验
          fs.writeFileSync(path.join(imgDir, file), buf);
          shotOk = true;
          logger.info(`原图下载 ${file}（${buf.length}B ${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}）`);
        } else if (buf) {
          logger.warn(`原图非PNG(${buf.length}B magic=${buf[0]},${buf[1]})降级截图: ` + im.src.slice(0, 60));
        }
      } catch (e) { logger.warn('原图下载失败降级截图: ' + e.message.slice(0, 60)); }
    }
    if (!shotOk && el) {
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(250);
      // ① 元素截图（15s）；失败则 ② bbox+clip 截图（page.clip 不要求元素 stable——池实例无头态 el.screenshot 常卡 "waiting for element to be stable"）
      shotOk = await el.screenshot({ path: path.join(imgDir, file), timeout: 15000 }).then(() => true)
        .catch(async e => {
          logger.warn('元素截图失败 idx=' + im.index + '，降级 clip 截图: ' + e.message.split('\n')[0]);
          try {
            const bb = await el.boundingBox();
            if (!bb || bb.width < 2 || bb.height < 2) return false;
            bb.x = Math.max(0, bb.x); bb.y = Math.max(0, bb.y);
            await page.screenshot({ path: path.join(imgDir, file), clip: bb, timeout: 20000 });
            return true;
          } catch (e2) { logger.warn('clip 截图也失败 idx=' + im.index + ': ' + e2.message.split('\n')[0]); return false; }
        });
    } else {
      logger.warn('未定位到元素 idx=' + im.index + '，跳过截图');
    }
    if (!shotOk) {
      // 图片没落地就不能写引用（否则 MD 引用↔文件对账必红）；计入 missingImgs 供闸门判红
      missedShots.push({ file, index: im.index, top: im.top });
      logger.error('截图未落地，跳过引用写入: ' + file);
      continue;
    }
    const rel = `${baseName}_images/${file}`;
    const ref = `![${secName}_图${n}](${rel})`;
    inlineImgs.push({ top: im.top, ref });
    logger.info(`截图 ${file} top=${im.top} → ${secName}`);
  }

  // G85：axure 矢量图示（流程图：节点矩形+连接线+箭头）——文字层只保阅读序，结构（菱形/分支/连线）必须靠截图。
  // extract 按几何识别出 ex.diagrams（画布包围盒，frame 页顶坐标），这里按包围盒裁图；高出视口的竖切多条后竖拼一张。
  const diagramRefs = [];
  // G91 计数：flowEmitted=出了流程图（结构块+渲染图）的图数；flowFallback=拓扑采信但渲染失败的图数（退回逐行文字）；flowNoVendor=缺渲染库只出结构块的图数
  let flowEmitted = 0, flowFallback = 0, flowNoVendor = 0;
  {
    const vh = await liveFrame.evaluate(() => window.innerHeight).catch(() => 936);
    const cw = await liveFrame.evaluate(() => document.documentElement.clientWidth).catch(() => 1640);
    const diagCounters = {};
    // G92：图示截图按 2 倍像素密度拍——蓝湖流程图多为细线小字，1 倍图放大后发虚。
    // 只改像素密度、不改视口尺寸（版面不动），拍完还原。
    let cdp2x = null;
    if ((ex.diagrams || []).length) {
      try {
        const vp = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
        cdp2x = await page.context().newCDPSession(page);
        await cdp2x.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 2, mobile: false });
        await page.waitForTimeout(400);
      } catch (e) {
        logger.warn('2 倍像素密度设置失败（按 1 倍拍）: ' + String((e && e.message) || e).slice(0, 80));
        if (cdp2x) { try { await cdp2x.detach(); } catch (e2) {} }
        cdp2x = null;
      }
    }
    for (let di = 0; di < (ex.diagrams || []).length; di++) {
      const dg = ex.diagrams[di];
      const secIdx = sectionIndexOf(dg.top + 12);
      const secName = secIdx < 0 ? '前置' : sectionShort(heads[secIdx].text);
      diagCounters[secIdx] = (diagCounters[secIdx] || 0) + 1;
      const stem = `流程图_${secName}_图${diagCounters[secIdx]}`;
      const strips = [];
      const PAD = 6; // 图示包围盒在 extract 侧已含标签外沿 4px，这里只留小边（大留白会把上方标题的半截字带进图）
      const x0 = Math.max(0, Math.round(dg.left - PAD)), x1 = Math.min(cw - 4, Math.round(dg.right + PAD));
      const w = x1 - x0, yEnd = Math.round(dg.bottom + PAD);
      let y = Math.max(0, Math.round(dg.top - PAD)), guard = 0;
      if (w >= 60 && yEnd - y >= 30) {
        while (y < yEnd && guard++ < 16) {
          await liveFrame.evaluate((yy) => window.scrollTo(0, Math.max(0, yy - 40)), y).catch(() => {});
          await page.waitForTimeout(220);
          const cs = await liveFrame.evaluate(() => (window.scrollY || document.documentElement.scrollTop || 0)).catch(() => 0);
          const a = Math.max(y, cs + 2), b = Math.min(yEnd, cs + vh - 2); // 以实际滚动量重算本条起止（页底滚动会被夹住）
          if (b - a < 8) break;
          const f = `${stem}_条${strips.length + 1}.png`;
          try {
            if (cdp2x) await cdpShot2x(cdp2x, { x: feBox.x + x0, y: feBox.y + (a - cs), width: w, height: b - a }, path.join(imgDir, f)); // G92：2 倍像素
            else await page.screenshot({ path: path.join(imgDir, f), clip: { x: feBox.x + x0, y: feBox.y + (a - cs), width: w, height: b - a }, timeout: 25000 });
            strips.push(f);
            logger.info(`图示截图 ${f}（版面 ${w}x${b - a}${cdp2x ? '，2 倍像素' : ''}，画布 y ${a}~${b}）`);
          } catch (e) { logger.warn('图示截图失败: ' + e.message.split('\n')[0]); break; }
          y = b;
        }
      }
      if (!strips.length) {
        missedShots.push({ file: stem + '.png', index: -1, top: dg.top, kind: 'diagram' });
        logger.error('图示截图未落地，跳过引用写入: ' + stem);
        continue;
      }
      const finalFile = `${stem}.png`;
      if (strips.length === 1) fs.renameSync(path.join(imgDir, strips[0]), path.join(imgDir, finalFile));
      else {
        const { execFileSync } = require('child_process');
        try {
          execFileSync(process.platform === 'win32' ? 'python' : 'python3', [path.join(__dirname, 'stitch_strips.py'), path.join(imgDir, finalFile), ...strips.map(s => path.join(imgDir, s))], { timeout: 60000 });
          logger.info(`图示竖拼完成 ${finalFile}（${strips.length} 条）`);
        } catch (e) { logger.warn('图示竖拼失败(保留分条，只引首条): ' + String(e.message).slice(0, 80)); }
      }
      const useRef = fs.existsSync(path.join(imgDir, finalFile)) ? finalFile : strips[0];
      inlineImgs.push({ top: dg.top - 7, ref: `![流程图_${di + 1}](${baseName}_images/${useRef})` });
      diagramRefs.push(useRef);
      // G91：拓扑采信的图示 → 先渲染验证，再把该图示的文字块从"逐行节点文字"换成"Mermaid 流程图源码 + 渲染图"；原图截图保留在上方。
      // G93（2026-11-24 用户实证："流程图没了，还没上次展示的好"）：源码块必须可见——
      //   用户在 ZCode 客户端里读文档，客户端把 ```mermaid 代码块直接画成流程图，这才是用户眼里的"流程图"；
      //   v5 按我对"蓝湖怎么展示就怎么展示"的理解把源码藏进 HTML 注释，客户端里流程图整块消失，被驳。
      //   渲染图是图片，给不支持 Mermaid 的阅读器/转 Word 用（"兼容各种工具打开"），两层并存。
      // 没归到节点/连线上的文字（leftover）原样接在后面，不能因为出了流程图而丢。
      if (dg.flow && dg.flow.ok) {
        const rFile = stem.replace(/^流程图_/, '流程图渲染_') + '.png';
        const st = await renderMermaid(page.context(), MERMAID_JS, 'g' + di, dg.flow.mermaid, path.join(imgDir, rFile), logger);
        if (st === 'ok') { dg.rendered = rFile; logger.info(`流程图渲染 ${rFile}`); }
        else if (st === 'fail') { dg.flow.ok = false; dg.flow.fallback = '渲染失败'; }
        const pt = (ex.parts || []).find(p => p.flow === di);
        if (dg.flow.ok && pt) {
          const ls = [FENCE + 'mermaid', dg.flow.mermaid, FENCE];
          if (dg.rendered) ls.push('', `![流程图渲染_${di + 1}](${baseName}_images/${dg.rendered})`);
          if (dg.flow.leftover.length) ls.push('', ...dg.flow.leftover.map(t => t.replace(/[\r\n]+/g, ' ')));
          pt.text = ls.join('\n');
          if (dg.rendered) flowEmitted++; else flowNoVendor++;
        } else if (!dg.flow.ok) flowFallback++;
      }
    }
    await liveFrame.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    if (cdp2x) { // G92：还原像素密度
      try { await cdp2x.send('Emulation.clearDeviceMetricsOverride'); } catch (e) {}
      try { await cdp2x.detach(); } catch (e) {}
    }
  }

  // 2b) 弹窗坐标裁剪（fhf 类 axure 控件组合弹窗；默认 auto，可 off / spec:path）
  let popupCrops = 0;
  const popupRefs = []; // {key, ref}
  let specPopups = null;
  if (typeof A.popups === 'string' && A.popups.startsWith('spec:')) {
    try { specPopups = JSON.parse(fs.readFileSync(A.popups.slice(5), 'utf-8')); }
    catch (e) { logger.error('弹窗 spec 读取失败: ' + e.message); specPopups = []; }
  }
  const doPopups = A.popups !== 'off' && (cls.popupClusters > 0 || specPopups);
  if (doPopups) {
    const fe = await liveFrame.frameElement().catch(() => null);
    const feBox = fe ? await fe.boundingBox() : null;
    if (!feBox) {
      logger.warn('无法获取 iframe 包围盒，跳过弹窗裁剪');
    } else {
      let clusters;
      if (specPopups) {
        // spec: 每项 {ids:[...], label:"重算弹窗"}；top 由 DOM 实时取
        clusters = specPopups.map(p => ({ ids: p.ids, name: p.label || '弹窗', top: 0, bottom: 0 }));
      } else {
        clusters = detectedPopups;
      }
      for (let i = 0; i < clusters.length; i++) {
        const cl = clusters[i];
        const secIdx = sectionIndexOf(cl.top > 0 ? cl.top : (await liveFrame.evaluate((ids) => {
          const el = document.getElementById(ids[0]); return el ? Math.round(el.getBoundingClientRect().top + (window.scrollY || 0)) : 0;
        }, cl.ids)));
        const secName = secIdx < 0 ? '前置' : sectionShort(heads[secIdx].text);
        const key = secIdx < 0 ? '__pre__' : secIdx;
        const crop = await cropPopup(liveFrame, page, feBox, cl, imgDir, baseName, secName, (sectionImgs.get(key) || []).length + popupRefs.filter(r => r.key === key).length + 1, logger);
        if (crop) {
          popupCrops++;
          const clTop = cl.top > 0 ? cl.top : 0;
          inlineImgs.push({ top: clTop, ref: crop.ref });
          popupRefs.push({ key, ref: crop.ref });
          logger.info(`弹窗裁剪 ${crop.file} → ${secName}`);
        } else {
          logger.warn(`弹窗裁剪失败: ${cl.name}（ids=${cl.ids.join(',')}）`);
        }
      }
    }
  } else {
    logger.info('弹窗自动裁剪跳过（detected=0 或 --popups off）');
  }

  // G76：面板/查询条件带引用也进 inlineImgs（按画布 y 与其他图统一内联）
  for (const ps of panelShots) {
    inlineImgs.push({ top: ps.top, ref: `![${ps.title}](${baseName}_images/${ps.file})` });
  }
  // G82：images_map 停写（内联模式后纯冗余、零消费方——用户拍板需求库只留 .md + _images/）

  if (A.imagesOnly) { logger.info('仅图片，结束'); return; } // exit 0
  if (A.noMd) { logger.info('不出MD，结束'); return; } // exit 0

  // 3) G76：按画布 y 内联组装——图插在"画布上它上方那段文字"与"下方那段文字"之间（用户拍板位置对齐模型）；
  //    parts=extract 块级 {top,bottom,text}（浮层重排后的最终序）；inlineImgs 按 top 排序逐块 flush
  let body;
  if (ex.parts && ex.parts.length) {
    // G80：stitch 在 inlineImgs 建立之后执行（_右 文件此刻才被并入 base）——组装时终滤不存在的文件
    const validImgs = inlineImgs.filter(it => {
      const m = it.ref.match(/\]\((.+?)\)/);
      return !m || fs.existsSync(path.join(outDir, m[1]));
    });
    const sorted = [...validImgs].sort((a, b) => a.top - b.top);
    let cursor = 0;
    const chunks = [];
    for (const pt of ex.parts) {
      while (cursor < sorted.length && sorted[cursor].top < pt.top - 6) {
        chunks.push(sorted[cursor].ref);
        cursor++;
      }
      chunks.push(pt.text);
    }
    while (cursor < sorted.length) { chunks.push(sorted[cursor].ref); cursor++; }
    body = cleanResidue(chunks.join('\n\n')); // G76：内联体同样过残留清理（图行 ! 开头不受影响）
    logger.info(`内联组装：${ex.parts.length} 块 × ${sorted.length} 图（按画布 y 对位）`);
  } else {
    // fallback：无块级信息（无表格页）——旧章节末尾机制
    const positions = [];
    let searchFrom = 0;
    for (const h of uniqHeads) {
      const p = md.indexOf(h.text, searchFrom);
      if (p >= 0) { positions.push({ p, text: h.text }); searchFrom = p + h.text.length; }
    }
    const blocks2 = [];
    if (positions.length === 0) {
      blocks2.push({ content: md, key: '__pre__' });
    } else {
      if (positions[0].p > 0) blocks2.push({ content: md.slice(0, positions[0].p), key: '__pre__' });
      for (let i = 0; i < positions.length; i++) {
        const start = positions[i].p;
        const end = (i + 1 < positions.length) ? positions[i + 1].p : md.length;
        const secIdx = uniqHeads.findIndex(h => h.text === positions[i].text);
        blocks2.push({ content: md.slice(start, end), key: secIdx < 0 ? '__pre__' : secIdx });
      }
    }
    const byKey = new Map();
    for (const it of inlineImgs) byKey.set('__all__', [...(byKey.get('__all__') || []), it.ref]);
    const tail = (byKey.get('__all__') || []);
    body = blocks2.map(b => b.content.replace(/\s+$/, '')).join('\n\n') + (tail.length ? '\n\n' + tail.join('\n\n') : '');
  }
  let hiddenSection = '';
  if (hiddenRefs.length) {
    // G67：隐藏面板图保留引用但**不带任何人工指引注释**（R22：疑点在对话里说，禁编辑性标记落文档）；
    // 隐藏图计数走 manifest.hiddenImgs（机器可读），需人工定位时由对话/报告呈报
    hiddenSection = '\n\n' + hiddenRefs.join('\n\n') + '\n';
  }
  let finalMd = ['# 蓝湖需求（文本保真版）— ' + A.menu, '',
    '> 采集时间: ' + new Date().toISOString().slice(0, 10) + ' | 文本保真提取（DOM 文本）+ 全页图片扫描（相对路径 PNG）+ 弹窗坐标裁剪。'
      + ((flowEmitted + flowNoVendor) ? ' 流程图：原图截图 + 流程图（Mermaid 源码块，阅读器直接显示为流程图；节点文字与蓝湖逐字一致，拓扑由页面几何重建）' + (flowEmitted ? ' + 渲染图（给不支持流程图的阅读器用）。' : '（本机缺渲染库，未出渲染图）。') : ''), '',
    body, hiddenSection
  ].join('\n');

  // G66c：落盘前对齐表列数——合并单元格的子表头/跨列表头行列数天然不等（extract 注释明示"不用列数一致性判断"），
  // 按各表表头列数补齐尾部空单元格（与 lanhu_verify --fix 同算法），文档"出生即对齐"，verify 硬闸不再红
  finalMd = finalMd.split('\n').map((ln, idx, arr) => {
    const t = ln.trim();
    if (!t.startsWith('|') || /^[\s|:-]+$/.test(t)) return ln;
    let h = idx;
    while (h > 0 && arr[h - 1].trim().startsWith('|')) h--;
    const ncol = (arr[h].match(/\|/g) || []).length;
    const have = (ln.match(/\|/g) || []).length;
    if (have < ncol) {
      let x = t.endsWith('|') ? t : t + ' |';
      while ((x.match(/\|/g) || []).length < ncol) x = x.slice(0, -1) + '  |';
      return x;
    }
    return ln; // 超列不裁（保真），verify 仍拦
  }).join('\n');

  // G69/G71/G72：@@TBAND/@@TFULL 标记 → 查询条件带/表格全景截图引用（数组=左+右多张；截失败的标记行删除）
  const refsOf = (arr, prefix) => {
    if (!arr) return '';
    const list = (Array.isArray(arr) ? arr : [arr]).filter(fn => fs.existsSync(path.join(imgDir, fn))); // G73：拼接后 _右 已并入 base，只引用存在文件
    return list.map(fn => `![${prefix}](${baseName}_images/${fn})`).join('\n\n');
  };
  finalMd = finalMd.replace(/^@@TBAND:(\d+)@@[ \t]*$/gm, (m, i) => refsOf(bandShots[+i], `查询条件_${+i + 1}`));
  finalMd = finalMd.replace(/\n{3,}/g, '\n\n');

  checkSqueezedTable(finalMd, logger);
  A.finalMd = finalMd; // G95：验收闸门查"正文非空"用

  fs.writeFileSync(path.join(outDir, baseName + '.md'), finalMd, 'utf-8');
  const totalImgs = inlineImgs.length + hiddenRefs.length + flowEmitted; // flowEmitted=写在流程图块后的渲染图（不走 inlineImgs）
  logger.info(`MD 生成: ${baseName}.md（正文 + 图片 ${totalImgs} 张 = 真实图 ${realImgsCount} + 弹窗 ${popupCrops} + 隐藏 ${hiddenN} + 流程图渲染 ${flowEmitted}）`);

  // —— 阶段4：后置验收闸门（硬阻断）——
  const manifest = {
    menu: A.menu, name: baseName,
    scheme: cls.scheme,
    sections: heads.length,
    realImgs: realImgsCount,
    hiddenImgs: hiddenN,
    popupClusters: specPopups ? specPopups.length : cls.popupClusters,
    popupCrops,
    diagrams: (ex.diagrams || []).length,
    diagramShots: diagramRefs.length,
    // G91：每张图示必有去向——换成流程图源码 / 退回逐行文字 / 拓扑未采信，三者之和须等于图示数
    flowEmitted, flowNoVendor, flowFallback,
    flowUntrusted: (ex.diagrams || []).filter(d => !(d.flow && d.flow.ok) && !(d.flow && d.flow.fallback)).length,
    geoTables: (ex.tables || []).length,
    missedShots
  };
  if (missedShots.length > 0 && !A.noGate) {
    logger.error(`闸门红：${missedShots.length} 张截图未落地（${missedShots.map(m => m.file).join(', ')}）——引用未写入，产物不完整`);
    exitCode = 3; return;
  }
  const passed = A.noGate ? (logger.info('[闸门关闭] 仅告警不阻断'), true) : acceptanceGate(A, manifest, logger);
  if (!passed) { exitCode = 3; return; } // 硬阻断：非零退出，绝不声称完成

  logger.info('DONE');
  } finally {
    // —— 池化收尾（硬要求）：关本任务开的蓝湖页签（残留会被 browser_pool IDLE_URL_RE 判忙锁死实例），
    //    再断开 CDP 连接（connectOverCDP 语义=断连，不关浏览器进程；实例归还由 pool_run.sh release 完成）
    for (const p of openedPages) { try { await p.close(); logger.info('已关闭本任务蓝湖页签'); } catch (e) { logger.warn('关页签失败(忽略): ' + e.message); } }
    if (browser) { try { await browser.close(); } catch (e) {} }
    if (exitCode) process.exitCode = exitCode;
  }
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
