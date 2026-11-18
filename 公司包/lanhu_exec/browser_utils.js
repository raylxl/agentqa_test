/**
 * browser_utils.js - 浏览器和蓝湖操作公共模块
 * 
 * 功能：
 * - 统一的端口检查和浏览器启动
 * - CDP连接管理
 * - 蓝湖页面查找
 * - 重试机制
 * - 智能等待
 * - 日志系统
 */

const { chromium } = require('playwright');
const net = require('net');
const fs = require('fs');
const path = require('path');

// ==================== 配置 ====================
// 端口解析序（池化）：命令行第一个纯数字参数（pool_run.sh 以 $PORT 传入）→ env CDP_PORT → 无（连接时报错）
// 本模块不自启浏览器：实例由 jt_exec/browser_pool.js 统一租借/释放（任务式，采完关蓝湖页签再 release）
function resolveCdpPort() {
  const argvPort = process.argv.slice(2).map(s => parseInt(s, 10)).find(n => Number.isInteger(n) && n > 0 && String(n) === process.argv.slice(2).find(a => parseInt(a, 10) === n));
  if (argvPort) return argvPort;
  if (process.env.CDP_PORT) return parseInt(process.env.CDP_PORT, 10);
  return null;
}
const DEFAULT_CONFIG = {
  cdpPort: resolveCdpPort(),
  lanhuBaseUrl: 'https://lanhuapp.com',
  timeouts: {
    portCheck: 2000,
    waitForPort: 15000,
    pageLoad: 30000,
    contentWait: 5000,
    moduleExpand: 1500
  },
  retry: {
    maxRetries: 2,
    retryDelay: 1000
  }
};

// ==================== 日志系统 ====================
class Logger {
  constructor(scriptName) {
    this.scriptName = scriptName;
    this.logDir = path.join(__dirname, 'logs');
    this.logFile = path.join(this.logDir, `${scriptName}.log`);
    this._ensureLogDir();
  }

  _ensureLogDir() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  _log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const dataStr = data ? ' ' + JSON.stringify(data) : '';
    const logEntry = `[${timestamp}] [${level}] [${this.scriptName}] ${message}${dataStr}`;
    
    console.log(logEntry);
    
    try {
      fs.appendFileSync(this.logFile, logEntry + '\n');
    } catch (err) {
      // 日志写入失败不影响主流程
    }
  }

  info(message, data) { this._log('INFO', message, data); }
  warn(message, data) { this._log('WARN', message, data); }
  error(message, data) { this._log('ERROR', message, data); }
  debug(message, data) { this._log('DEBUG', message, data); }
}

// ==================== 端口和浏览器管理 ====================

/**
 * 检查端口是否可连接
 * @param {number} port - 端口号
 * @returns {Promise<boolean>}
 */
function isPortOpen(port = DEFAULT_CONFIG.cdpPort) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(DEFAULT_CONFIG.timeouts.portCheck);
    
    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };
    
    socket.once('connect', () => { cleanup(); resolve(true); });
    socket.once('timeout', () => { cleanup(); resolve(false); });
    socket.once('error', () => { cleanup(); resolve(false); });
    
    socket.connect(port, '127.0.0.1');
  });
}

/**
 * 检查实例端口与租借前置（不自启浏览器，池化后由 browser_pool 管实例）
 * @param {Logger} logger - 日志实例
 * @returns {Promise<boolean>}
 */
async function startBrowser(logger) {
  const log = logger || new Logger('browser_utils');
  
  if (await isPortOpen()) {
    log.info('实例端口在监听');
    return true;
  }
  
  throw new Error(
    `CDP 端口 ${DEFAULT_CONFIG.cdpPort} 未监听：本模块不自启浏览器。` +
    `请走池化入口：bash jt_exec/pool_run.sh lanhu_exec/<脚本>.js [脚本参数]（自动 acquire 传端口），` +
    `或 node browser_pool.js acquire "蓝湖采集" 取端口后设 CDP_PORT 再跑。`
  );
}

/**
 * 连接到浏览器（CDP模式）
 * @param {Logger} logger - 日志实例
 * @returns {Promise<Browser>}
 */
async function connectBrowser(logger) {
  const log = logger || new Logger('browser_utils');
  if (!DEFAULT_CONFIG.cdpPort) {
    throw new Error('未指定 CDP 端口：经 pool_run.sh 运行（自动传入）或设 CDP_PORT 环境变量');
  }
  await startBrowser(log);
  
  log.info(`连接到CDP端口 ${DEFAULT_CONFIG.cdpPort}...`);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEFAULT_CONFIG.cdpPort}`);
  log.info('CDP连接成功');
  
  return browser;
}

/**
 * 查找蓝湖页面
 * @param {Browser} browser - 浏览器实例
 * @returns {Promise<Page[]>}
 */
async function getLanhuPages(browser) {
  const pages = [];
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      if (page.url().includes('lanhuapp.com')) {
        pages.push(page);
      }
    }
  }
  return pages;
}

/**
 * 获取或创建蓝湖页面
 * @param {Browser} browser - 浏览器实例
 * @param {Logger} logger - 日志实例
 * @returns {Promise<Page>}
 */
async function getOrCreateLanhuPage(browser, logger) {
  const log = logger || new Logger('browser_utils');
  
  const lanhuPages = await getLanhuPages(browser);
  if (lanhuPages.length > 0) {
    log.info(`找到 ${lanhuPages.length} 个蓝湖页面`);
    return lanhuPages[0];
  }
  
  log.info('未找到蓝湖页面，创建新页面...');
  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage();
  // 地址四层解析：--url 参数 → LANHU_URL env → 本机 lanhu_config.json（config_loader）
  const { resolveLanhuUrl } = require('./config_loader');
  await page.goto(resolveLanhuUrl(process.argv), { 
    waitUntil: 'domcontentloaded',
    timeout: DEFAULT_CONFIG.timeouts.pageLoad 
  });
  
  return page;
}

/**
 * 进入原型视图（2026-11-18 适配：访客邀请态被"用户状态变化"降级到项目总览页时，
 * 需点击 rp 文件进入原型树；"请重新登录"横幅不阻断——R11：唯一就绪判据=内容可见）
 * @param {Page} page - 蓝湖页面
 * @param {Logger} logger - 日志实例
 * @param {string} rpName - rp 文件名（模糊包含匹配，默认"财务需求2026"）
 * @returns {Promise<boolean>} 菜单树是否可见
 */
async function enterPrototype(page, logger, rpName = '财务需求2026') {
  const log = logger || new Logger('browser_utils');
  for (let i = 0; i < 12; i++) {
    const tree = await page.evaluate(() => document.querySelectorAll('.tree-item-wrapper').length).catch(() => 0);
    if (tree > 0) { log.info(`原型树已就绪（${tree} 节点）`); return true; }
    if (i === 3) { // 等了 ~3 轮仍无树，尝试点击 rp 文件（项目总览页形态）
      try {
        const clicked = await page.evaluate((name) => {
          const els = Array.from(document.querySelectorAll('*'));
          const el = els.find(e => e.children.length === 0 && (e.textContent || '').includes(name));
          if (el) { el.click(); return (el.textContent || '').trim().slice(0, 40); }
          return null;
        }, rpName);
        if (clicked) log.info(`已点击 rp 文件「${clicked}」，等待原型树…`);
        else log.warn(`未见 rp 文件「${rpName}」（可能已在原型页或列表未渲染）`);
      } catch (e) { log.warn('点击 rp 文件异常(继续等待): ' + e.message); }
    }
    await page.waitForTimeout(2500);
  }
  log.error('enterPrototype 超时：菜单树未出现');
  return false;
}

// ==================== 菜单导航（采集器与对账器共用——G64：验证方必须与被测同构） ====================

/**
 * 精确点击左侧树菜单（真鼠标事件链才能触发蓝湖 SPA 导航；朴素 evaluate click 不导航）
 * @param {Page} page - 蓝湖页面
 * @param {string} menuName - 树内真实菜单名（一字不差；问号形态由树侧自然匹配）
 * @param {Logger} logger
 */
async function robustClickMenu(page, menuName, logger) {
  const log = logger || new Logger('browser_utils');
  await page.evaluate(() => {
    const s = document.querySelector('.prototype-sidebar');
    if (s) {
      s.style.setProperty('overflow-y', 'auto', 'important');
      s.style.setProperty('overflow', 'auto', 'important');
    }
  });
  const item = await page.evaluateHandle((nm) => {
    const els = [...document.querySelectorAll('.tree-item-wrapper,.tree-name,[class*="tree-item"]')];
    return els.find(x => (x.textContent || '').trim() === nm)
        || els.find(x => (x.textContent || '').trim().includes(nm)) || null;
  }, menuName);
  const el = item.asElement ? item.asElement() : null;
  if (!el) { log.error('菜单未找到: ' + menuName); throw new Error('MENU_NOT_FOUND'); }
  for (let k = 0; k < 80; k++) {
    const box = await el.boundingBox().catch(() => null);
    if (box && box.y >= 60 && box.y <= 680 && box.height > 0) break;
    await page.evaluate((nm) => {
      const s = document.querySelector('.prototype-sidebar');
      if (!s) return;
      const els = [...document.querySelectorAll('.tree-item-wrapper,.tree-name,[class*="tree-item"]')];
      const e = els.find(x => (x.textContent || '').trim() === nm)
             || els.find(x => (x.textContent || '').trim().includes(nm));
      if (!e) return;
      const r = e.getBoundingClientRect();
      s.scrollTop += (r.top + r.height / 2) - 400;
    }, menuName);
    await page.waitForTimeout(100);
  }
  await el.click({ timeout: 9000 }).catch(e => { throw new Error('CLICK_FAIL: ' + e.message); });
  log.info('已点击菜单: ' + menuName);
  await page.waitForTimeout(1800);
}

// ==================== 重试机制 ====================


/**
 * 带重试的函数执行
 * @param {Function} fn - 要执行的函数
 * @param {Object} options - 配置选项
 * @returns {Promise<any>}
 */
async function withRetry(fn, options = {}) {
  const { 
    maxRetries = DEFAULT_CONFIG.retry.maxRetries, 
    retryDelay = DEFAULT_CONFIG.retry.retryDelay, 
    onRetry,
    logger 
  } = options;
  const log = logger || new Logger('browser_utils');
  
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt <= maxRetries) {
        log.warn(`尝试 ${attempt}/${maxRetries + 1} 失败: ${error.message}，${retryDelay}ms后重试...`);
        if (onRetry) await onRetry(error, attempt);
        await new Promise(r => setTimeout(r, retryDelay));
      } else {
        log.error(`所有 ${maxRetries + 1} 次尝试均失败`);
        throw error;
      }
    }
  }
}

// ==================== 智能等待 ====================

/**
 * 等待元素可见
 * @param {Page} page - 页面实例
 * @param {string} selector - 选择器
 * @param {number} timeout - 超时时间
 * @returns {Promise<boolean>}
 */
async function waitForElement(page, selector, timeout = DEFAULT_CONFIG.timeouts.contentWait) {
  try {
    await page.waitForSelector(selector, { timeout, state: 'visible' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 等待页面内容稳定（不再变化）
 * @param {Page} page - 页面实例
 * @param {Object} options - 配置选项
 * @returns {Promise<boolean>}
 */
async function waitForStableContent(page, options = {}) {
  const { 
    interval = 500, 
    maxWait = 10000, 
    stableCount = 3,
    selector = 'body'
  } = options;
  
  let lastContent = '';
  let stable = 0;
  const start = Date.now();
  
  while (Date.now() - start < maxWait) {
    const content = await page.textContent(selector).catch(() => '');
    if (content === lastContent) {
      stable++;
      if (stable >= stableCount) return true;
    } else {
      stable = 0;
    }
    lastContent = content;
    await page.waitForTimeout(interval);
  }
  
  return false;
}

/**
 * 等待iframe加载
 * @param {Page} page - 页面实例
 * @param {string} frameSelector - iframe选择器
 * @param {number} timeout - 超时时间
 * @returns {Promise<Frame|null>}
 */
async function waitForFrame(page, frameSelector = 'iframe', timeout = DEFAULT_CONFIG.timeouts.contentWait) {
  try {
    const frameElement = await page.waitForSelector(frameSelector, { timeout });
    const frame = await frameElement.contentFrame();
    return frame;
  } catch {
    return null;
  }
}

// ==================== 蓝湖专用工具 ====================

/**
 * 查找包含需求内容的frame
 * @param {Page} page - 页面实例
 * @param {Logger} logger - 日志实例
 * @returns {Promise<Frame|null>}
 */
async function findContentFrame(page, logger) {
  const log = logger || new Logger('browser_utils');
  const contentKeywords = ['一、业务背景价值', '业务背景', '需求背景', '功能说明', '一、', '优化点', '迭代版本', '新增查询条件'];
  
  // 方法1：优先通过URL查找axure-file.lanhuapp.com的frame
  const frames = page.frames();
  log.info(`页面中有 ${frames.length} 个frame`);
  
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const frameUrl = frame.url();
    
    // 优先检查axure-file.lanhuapp.com的frame
    if (frameUrl && frameUrl.includes('axure-file.lanhuapp.com')) {
      log.info(`找到axure-file.lanhuapp.com的frame (Frame ${i})`);
      return frame;
    }
  }
  
  // 方法2：通过frame URL查找（排除主页面和空白页）
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const frameUrl = frame.url();
    
    if (!frameUrl || frameUrl === 'about:blank' || frameUrl.includes('lanhuapp.com/web/')) {
      continue;
    }
    
    try {
      // 检查更多内容（前2000个字符），因为需求内容可能不在最前面
      const text = await frame.evaluate(() => {
        return document.body?.innerText?.substring(0, 2000) || '';
      });
      
      if (contentKeywords.some(kw => text.includes(kw))) {
        log.info(`找到包含需求内容的frame (Frame ${i})`);
        return frame;
      }
    } catch {
      // 跨域错误，忽略
    }
  }
  
  // 方法3：通过iframe元素查找
  log.info('通过frame URL未找到，尝试查找iframe元素...');
  
  const iframeElements = await page.$$('iframe');
  log.info(`找到 ${iframeElements.length} 个iframe元素`);
  
  for (const iframe of iframeElements) {
    const frame = await iframe.contentFrame();
    if (!frame) continue;
    
    try {
      // 检查更多内容（前2000个字符）
      const text = await frame.evaluate(() => {
        return document.body?.innerText?.substring(0, 2000) || '';
      });
      
      if (contentKeywords.some(kw => text.includes(kw))) {
        log.info('通过iframe元素找到内容frame');
        return frame;
      }
    } catch {
      // 忽略错误
    }
  }
  
  return null;
}

/**
 * 检测表格数据并格式化为Markdown表格
 * @param {Array} rows - 表格行数据
 * @returns {string} Markdown表格字符串
 */
function formatTableAsMarkdown(rows) {
  if (rows.length < 2) return rows.join('\n');
  
  // 检查是否是表格数据（所有行的列数相同）
  const firstRowCols = rows[0].split('\t').length;
  const isTable = rows.every(row => {
    const cols = row.split('\t');
    return cols.length === firstRowCols && cols.length > 1;
  });
  
  if (!isTable) return rows.join('\n');
  
  // 格式化为Markdown表格
  let markdown = '';
  
  // 表头
  markdown += '| ' + rows[0].split('\t').join(' | ') + ' |\n';
  markdown += '| ' + rows[0].split('\t').map(() => '---').join(' | ') + ' |\n';
  
  // 数据行
  for (let i = 1; i < rows.length; i++) {
    markdown += '| ' + rows[i].split('\t').join(' | ') + ' |\n';
  }
  
  return markdown;
}

/**
 * 统一的内容提取函数
 * 结合单个提取和批量提取的优点：
 * - 使用 [id$="_text"] 选择器（更精确）
 * - 按位置排序（保留视觉顺序）
 * - 完整的UI元素过滤规则
 * - 清理连续空行
 * - 智能检测表格数据并格式化为Markdown表格
 *
 * @param {Frame} frame - 内容frame
 * @returns {Promise<string>}
 */

/**
 * 滚动到页面底部，确保所有内容加载完成
 * @param {Frame} frame - 内容frame
 * @param {Logger} logger - 日志实例
 * @returns {Promise<void>}
 */
async function scrollToBottom(frame, logger) {
  const log = logger || new Logger('browser_utils');
  log.info('开始滚动到页面底部（循环至稳定）...');

  try {
    // 2026-11-18 修（G64）：11.30 原型懒加载加深，旧版"一遍滚+单次增长续滚"只见到部分高度
    // （实测存储账单：旧法 3703px/4453字符 vs 真相 12365px/10222字符）。
    // 新法：整轮全容器滚动，高度仍在长就再来一整轮，至多 8 轮；稳定后全容器回顶。
    const heights = await frame.evaluate(async () => {
      const growthLog = [];
      const findAll = () => Array.from(document.querySelectorAll('*')).filter(el => {
        const s = getComputedStyle(el);
        return (s.overflowY === 'scroll' || s.overflowY === 'auto') && el.scrollHeight > el.clientHeight;
      });
      const onePass = async (step, wait) => {
        let els = findAll();
        if (!els.length) els = [document.documentElement];
        for (const el of els) {
          for (let y = 0; y <= el.scrollHeight; y += step) {
            el.scrollTop = y;
            await new Promise(r => setTimeout(r, wait));
          }
        }
      };
      let prev = document.documentElement.scrollHeight;
      growthLog.push(prev);
      for (let round = 0; round < 8; round++) {
        await onePass(250, 120);
        await new Promise(r => setTimeout(r, 900));
        const cur = document.documentElement.scrollHeight;
        growthLog.push(cur);
        if (cur <= prev) break;   // 高度稳定，收工
        prev = cur;
      }
      // 稳定后全容器回顶（提取用 viewport 坐标，回顶=坐标最小且负值最少）
      const els = findAll();
      (els.length ? els : [document.documentElement]).forEach(el => { el.scrollTop = 0; });
      window.scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 600));
      return growthLog;
    });
    log.info('滚动完成（高度增长曲线: ' + heights.join('→') + '）');
    return true;
  } catch (err) {
    log.warn('滚动警告(继续提取): ' + err.message);
    return false;
  }
}

async function extractLanhuContent(frame) {
  return frame.evaluate(() => {
    const textElements = [];
    const allElements = document.querySelectorAll('[id$="_text"]');

    allElements.forEach(el => {
      const text = el.innerText?.trim();
      if (text && text.length > 0) {
        const rect = el.getBoundingClientRect();
        // 过滤零尺寸元素
        if (rect.width > 0 && rect.height > 0) {
          textElements.push({
            text,
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          });
        }
      }
    });

    // 按位置排序（从上到下，从左到右）
    textElements.sort((a, b) => {
      const topDiff = a.top - b.top;
      if (Math.abs(topDiff) > 10) return topDiff;
      return a.left - b.left;
    });

    // 完整的UI元素过滤正则
    const uiFilterRegex = /^(img|arrow|folder|search|button|input|icon|确定|取消|关闭|保存|提交|返回|上一步|下一步|ESC|即可退出演示模式|额，好像没有权限|知道啦|移出团队通知|你已被|移出当前团队，你可创建新的团队|创建团队|🎉|知道了|正在加载|Created with Sketch\.|sheji2|wenzi2|暂无搜索结果|more_vert|chevron_right|上传产品文档|团队共享|上传文件|支持 Word|Axure 文档上传|下载蓝湖客户端|添加文档链接|支持添加任意网页链接|在区域内点击|财务需求\d+\.rp)$/i;

    // 第1步：按行分组（Y坐标阈值25px，蓝湖表格行间距约31px）
    const ROW_THRESHOLD = 25;
    const COL_THRESHOLD = 80;
    const MIN_TABLE_ROWS = 3; // 至少3行才算表格（1表头+2数据）
    const MIN_TABLE_COLS = 3; // 至少3列才算表格行

    const rows = [];
    let currentRow = [];
    let currentRowTop = -1;

    textElements.forEach(el => {
      if (uiFilterRegex.test(el.text)) return;

      if (currentRowTop === -1 || Math.abs(el.top - currentRowTop) > ROW_THRESHOLD) {
        if (currentRow.length > 0) {
          rows.push({ top: currentRowTop, cells: currentRow });
        }
        currentRow = [{ text: el.text, left: el.left }];
        currentRowTop = el.top;
      } else {
        currentRow.push({ text: el.text, left: el.left });
      }
    });
    if (currentRow.length > 0) {
      rows.push({ top: currentRowTop, cells: currentRow });
    }

    // 第2步：识别表格区域
    // 策略：连续的多列(>=3)行构成表格区域
    // 蓝湖表格因合并单元格导致列数不一致(3-8)，所以不用列数一致性判断
    const tableRegions = [];
    let regionStart = -1;

    for (let i = 0; i < rows.length; i++) {
      const isMultiCol = rows[i].cells.length >= MIN_TABLE_COLS;
      if (isMultiCol) {
        if (regionStart === -1) regionStart = i;
      } else {
        if (regionStart !== -1) {
          const regionLength = i - regionStart;
          if (regionLength >= MIN_TABLE_ROWS) {
            tableRegions.push({ start: regionStart, end: i });
          }
          regionStart = -1;
        }
      }
    }
    // 处理末尾区域
    if (regionStart !== -1) {
      const regionLength = rows.length - regionStart;
      if (regionLength >= MIN_TABLE_ROWS) {
        tableRegions.push({ start: regionStart, end: rows.length });
      }
    }

    // 第3步：块级生成输出（text/table 块），供浮层精确内联使用
    const blocks = []; // {type:'text'|'table', top, bottom, lines?|mdLines?}
    const TEXT_GAP = 200; // 垂直间隙超过该值视为独立块（浮层/弹窗 mockup 与正文间的画布间隙）

    const pushTextRows = (startIdx, endIdx) => {
      let sub = null;
      const flush = () => {
        if (sub && sub.lines.length) blocks.push({ type: 'text', top: sub.top, bottom: sub.bottom, lines: sub.lines });
        sub = null;
      };
      for (let i = startIdx; i < endIdx; i++) {
        const row = rows[i];
        const rowText = row.cells.map(c => c.text).join(' ');
        if (!rowText.trim()) continue;
        if (!sub || row.top - sub.bottom > TEXT_GAP) {
          flush();
          sub = { top: row.top, bottom: row.top + 25, lines: [] };
        }
        sub.lines.push(rowText);
        sub.bottom = row.top + 25;
      }
      flush();
    };

    let lastRowEnd = 0;

    for (const region of tableRegions) {
      // 表格区域之前的文本行
      if (region.start > lastRowEnd) pushTextRows(lastRowEnd, region.start);

      // 格式化表格区域
      const tableRows = rows.slice(region.start, region.end);

      // 收集所有列位置并聚类
      const allLefts = [];
      tableRows.forEach(r => r.cells.forEach(c => allLefts.push(c.left)));
      const sortedLefts = [...new Set(allLefts)].sort((a, b) => a - b);

      const colPositions = [];
      let currentCol = sortedLefts[0];
      for (let i = 1; i < sortedLefts.length; i++) {
        if (sortedLefts[i] - currentCol > COL_THRESHOLD) {
          colPositions.push(currentCol);
          currentCol = sortedLefts[i];
        }
      }
      colPositions.push(currentCol);

      // 构建表格数据
      const tableData = tableRows.map(row => {
        const rowData = new Array(colPositions.length).fill('');
        row.cells.forEach(cell => {
          let minDist = Infinity;
          let colIndex = 0;
          colPositions.forEach((colPos, idx) => {
            const dist = Math.abs(cell.left - colPos);
            if (dist < minDist) {
              minDist = dist;
              colIndex = idx;
            }
          });
          // 如果同一列已有内容，追加（处理同行多元素映射到同列的情况）
          if (rowData[colIndex]) {
            rowData[colIndex] += ' ' + cell.text;
          } else {
            rowData[colIndex] = cell.text;
          }
        });
        return rowData;
      });

      // 生成Markdown表格
      if (tableData.length > 0) {
        // 表头
        const mdLines = ['| ' + tableData[0].join(' | ') + ' |'];
        mdLines.push('| ' + tableData[0].map(() => '---').join(' | ') + ' |');
        // 数据行
        for (let i = 1; i < tableData.length; i++) {
          mdLines.push('| ' + tableData[i].join(' | ') + ' |');
        }
        blocks.push({ type: 'table', top: tableRows[0].top, bottom: tableRows[tableRows.length - 1].top + 25, mdLines });
      }

      lastRowEnd = region.end;
    }

    // 表格区域之后的文本行
    if (lastRowEnd < rows.length) pushTextRows(lastRowEnd, rows.length);

    // 第4步：浮层/弹窗内容块精确内联
    // 背景：axure 画布上弹窗 mockup 画在正文下方，按画布顺序提取会被追加到章节末尾。
    // 策略：与前一块垂直间隙 > TEXT_GAP 的块视为浮层候选；取候选块内 ≤10 字的短标题行，
    //       在候选块之前的正文中找包含该关键词的行（命中次数 1~4 次），取离候选块最近者
    //       作为触发点锚点，将整块移动到锚点行之后（精确内联）。
    //       找不到锚点时保留原位并加 ⚠️ 标记（转人工精修，不静默错位）。
    for (let round = 0; round < 6; round++) {
      let moved = false;
      for (let i = 1; i < blocks.length; i++) {
        const cand = blocks[i];
        const prev = blocks[i - 1];
        if (cand.top - prev.bottom <= TEXT_GAP) continue;
        const candLines = cand.type === 'table' ? cand.mdLines : cand.lines;
        const cands = candLines
          .filter(l => l.trim().length >= 2 && l.trim().length <= 10 && !l.trim().startsWith('|'))
          .sort((a, b) => b.trim().length - a.trim().length);
        let anchor = null;
        for (const kw0 of cands) {
          const kw = kw0.trim();
          const hits = [];
          for (let j = 0; j < blocks.length; j++) {
            if (blocks[j] === cand) continue;
            const ls = blocks[j].type === 'table' ? blocks[j].mdLines : blocks[j].lines;
            ls.forEach((l, li) => { if (l.includes(kw)) hits.push({ blockIdx: j, lineIdx: li }); });
          }
          // 只认候选块之前的命中（触发点在弹窗之前），取最近一块；命中过多(>4)视为太泛弃用
          const above = hits.filter(h => blocks[h.blockIdx].top <= cand.top);
          if (above.length >= 1 && above.length <= 4) {
            above.sort((a, b) => blocks[b.blockIdx].top - blocks[a.blockIdx].top);
            anchor = { kw, ...above[0] };
            break;
          }
        }
        if (!anchor) {
          candLines.unshift('> ⚠️【浮层内容块】以下内容来自画布浮层/弹窗，未能自动定位触发点，请人工核对内联位置：');
          continue;
        }
        // 在锚点行后切分锚点块并插入候选块
        const tb = blocks[anchor.blockIdx];
        const tl = tb.type === 'table' ? tb.mdLines : tb.lines;
        const before = tl.slice(0, anchor.lineIdx + 1);
        const after = tl.slice(anchor.lineIdx + 1);
        const mk = (lines) => ({ type: tb.type, top: tb.top, bottom: tb.bottom, [tb.type === 'table' ? 'mdLines' : 'lines']: lines });
        const rebuilt = [];
        for (const bl of blocks) {
          if (bl === cand) continue;
          if (bl === tb) {
            if (before.length) rebuilt.push(mk(before));
            rebuilt.push(cand);
            if (after.length) rebuilt.push(mk(after));
          } else rebuilt.push(bl);
        }
        blocks.length = 0;
        blocks.push(...rebuilt);
        moved = true;
        break; // 重建后重新扫描
      }
      if (!moved) break;
    }

    // 第5步：输出
    const outputParts = [];
    for (const b of blocks) {
      const ls = b.type === 'table' ? b.mdLines : b.lines;
      if (ls.length) outputParts.push(ls.join('\n'));
    }

    // 如果没有识别到表格区域，按普通文本输出
    if (tableRegions.length === 0) {
      const resultLines = [];
      let lastTop = -1;
      textElements.forEach(el => {
        if (uiFilterRegex.test(el.text)) return;
        if (lastTop !== -1 && Math.abs(el.top - lastTop) > 10) {
          resultLines.push('');
        }
        resultLines.push(el.text);
        lastTop = el.top;
      });

      // 清理连续空行
      const cleanedLines = [];
      let lastLineEmpty = false;
      for (const line of resultLines) {
        const isEmpty = line.length === 0;
        if (isEmpty && lastLineEmpty) continue;
        cleanedLines.push(line);
        lastLineEmpty = isEmpty;
      }
      return cleanedLines.join('\n');
    }

    return outputParts.join('\n');
  });
}

/**
 * 从页面中提取模块和菜单名称
 * @param {Page} page - 页面实例
 * @returns {Promise<{module: string, menu: string}>}
 */
async function extractMenuInfo(page) {
  try {
    return await page.evaluate(() => {
      const selectedItem = document.querySelector('.tree-item.selected, .menu-item.selected, .ant-menu-item-selected');
      if (!selectedItem) return { module: '', menu: '' };
      
      const menuText = selectedItem.textContent?.trim() || '';
      let moduleElement = selectedItem.closest('.tree-item-wrapper, .menu-submenu, .ant-menu-submenu');
      
      if (moduleElement) {
        const moduleText = moduleElement.querySelector('.tree-item-title, .menu-submenu-title, .ant-menu-submenu-title')?.textContent?.trim() || '';
        return { module: moduleText, menu: menuText };
      }
      
      return { module: '', menu: menuText };
    });
  } catch {
    return { module: '', menu: '' };
  }
}

/**
 * 展开蓝湖模块
 * @param {Page} page - 页面实例
 * @param {Locator} moduleItem - 模块元素
 * @param {Logger} logger - 日志实例
 */
async function expandModule(page, moduleItem, logger) {
  const log = logger || new Logger('browser_utils');
  
  try {
    // 蓝湖展开按钮：img[slot="expend-icon"] 或 img.icon-arrow
    // 旋转 -90deg = 折叠，0deg/无旋转 = 展开
    const expandBtn = moduleItem.locator('img[slot="expend-icon"], img.icon-arrow').first();
    if (await expandBtn.count() > 0) {
      const style = await expandBtn.getAttribute('style');
      if (style && style.includes('rotate(-90deg)')) {
        await expandBtn.click();
        log.info('点击展开按钮');
        await page.waitForTimeout(DEFAULT_CONFIG.timeouts.moduleExpand);
      }
    }
  } catch (err) {
    log.warn('展开模块失败', err.message);
  }
}

/**
 * 查找蓝湖菜单项
 * @param {Page} page - 页面实例
 * @param {string} menuName - 菜单名称
 * @param {Logger} logger - 日志实例
 * @returns {Promise<Locator|null>}
 */
async function findLanhuMenuItem(page, menuName, logger) {
  const log = logger || new Logger('browser_utils');

  // 1. 尝试精确匹配（增加超时到3000ms）
  const directMatch = page.locator(`text="${menuName}"`).first();
  if (await directMatch.isVisible({ timeout: 3000 }).catch(() => false)) {
    log.info(`精确找到菜单: ${menuName}`);
    return directMatch;
  }

  // 2. 尝试使用 :has-text() 匹配（更宽松）
  const hasTextMatch = page.locator(`.tree-item-wrapper:has-text("${menuName}")`).first();
  if (await hasTextMatch.isVisible({ timeout: 2000 }).catch(() => false)) {
    log.info(`使用 has-text 找到菜单: ${menuName}`);
    return hasTextMatch;
  }

  // 3. 尝试清理菜单名称后匹配（去掉版本号）
  const cleanMenuName = menuName.replace(/\s+\d+(\.\d+)*(\.\d+)*$/, '').trim();
  if (cleanMenuName !== menuName) {
    log.info(`尝试清理后的菜单名: ${cleanMenuName}`);
    const cleanMatch = page.locator(`.tree-item-wrapper:has-text("${cleanMenuName}")`).first();
    if (await cleanMatch.isVisible({ timeout: 2000 }).catch(() => false)) {
      log.info(`使用清理后的名称找到菜单: ${cleanMenuName}`);
      return cleanMatch;
    }
  }

  // 4. 尝试正则匹配
  const regexPattern = menuName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const regexMatch = page.locator(`.tree-item-wrapper:has-text(/${regexPattern}/)`).first();
  if (await regexMatch.isVisible({ timeout: 2000 }).catch(() => false)) {
    log.info(`使用正则匹配找到菜单: ${menuName}`);
    return regexMatch;
  }

  log.warn(`未找到菜单: ${menuName}`);
  return null;
}

/**
 * 等待页面导航完成
 * @param {Page} page - 页面实例
 * @param {Function} action - 触发导航的操作
 * @param {Object} options - 配置选项
 * @returns {Promise<boolean>}
 */
async function waitForNavigation(page, action, options = {}) {
  const { timeout = DEFAULT_CONFIG.timeouts.pageLoad, waitUntil = 'domcontentloaded' } = options;
  
  try {
    await Promise.all([
      page.waitForNavigation({ timeout, waitUntil }),
      action()
    ]);
    return true;
  } catch {
    return false;
  }
}

// ==================== 连接池 ====================
class BrowserPool {
  constructor() {
    this.browser = null;
    this.lastUsed = 0;
    this.maxIdleTime = 60000; // 1分钟空闲后断开
    this.logger = new Logger('browser_pool');
  }
  
  async getBrowser() {
    if (this.browser && Date.now() - this.lastUsed < this.maxIdleTime) {
      this.lastUsed = Date.now();
      this.logger.debug('复用现有浏览器连接');
      return this.browser;
    }
    
    if (this.browser) {
      this.logger.info('释放空闲连接');
      // connectOverCDP 语义：close()=断开 CDP 连接，不关浏览器进程（禁关浏览器红线）
      await this.browser.close().catch(() => {});
    }
    
    this.browser = await connectBrowser(this.logger);
    this.lastUsed = Date.now();
    return this.browser;
  }
  
  async release() {
    if (this.browser) {
      this.logger.info('释放浏览器连接');
      // 同上：仅断连；蓝湖页签须由调用方收尾自行 close 后再 browser_pool release
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
  
  async healthCheck() {
    try {
      const browser = await this.getBrowser();
      const pages = browser.contexts()[0]?.pages() || [];
      return { healthy: true, pageCount: pages.length };
    } catch (error) {
      return { healthy: false, error: error.message };
    }
  }
}

// ==================== 导出 ====================
module.exports = {
  // 配置
  DEFAULT_CONFIG,
  
  // 类
  Logger,
  BrowserPool,
  
  // 端口和浏览器
  isPortOpen,
  startBrowser,
  connectBrowser,
  getLanhuPages,
  getOrCreateLanhuPage,
  enterPrototype,
  robustClickMenu,
  
  // 重试
  withRetry,
  
  // 等待
  waitForElement,
  waitForStableContent,
  waitForFrame,
  waitForNavigation,
  
  // 蓝湖专用
  expandModule,
  findLanhuMenuItem,
  findContentFrame,
  extractLanhuContent,
  extractMenuInfo,
  scrollToBottom
};
