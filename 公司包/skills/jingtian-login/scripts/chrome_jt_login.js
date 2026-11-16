/**
 * 鲸天系统登录（Chrome 9333 · jingtian-login 技能自带脚本）
 *
 * 流程（2026-10-27 实测）：
 *   1. 复用页签：找 SSO/鲸天页签，没有则新开并访问 http://jt-ll.test.ztoeco.com/welcome
 *   2. 已登录（正文含 陆潇雷/预发环境）→ 直接返回 already-logged-in
 *   3. SSO 页若为扫码模式（0 输入框）→ 点 a.login-switch-link（"动态码登录"）切表单
 *   4. 填 input[name=username]=账号、input[name=password]=动态码（兼容静态密码）
 *   5. 点 button.login-btn（"登录"），等跳回鲸天并校验登录态
 *
 * 用法：node chrome_jt_login.js
 *       换账号登录（操作流程人人一致，仅账密不同）：
 *       JT_ACCOUNT=zhangsan99 JT_SECRET='xxx' JT_DISPLAY=张三 node chrome_jt_login.js
 * 前提：Chrome 9333 已带 --disable-features=HttpsUpgrades... 参数启动（用 launch_chrome_9333.ps1）
 * 输出：RESULT: already-logged-in | login-success | login-timeout（超时退出码 2）
 */
const path = require('path');

let chromium;
for (const p of [
  'playwright',
  path.join('d:', 'WorkBuddy-projects', 'testcase', 'node_modules', 'playwright'),
]) {
  try { chromium = require(p).chromium; if (chromium) break; } catch (_) {}
}
if (!chromium) { console.error('找不到 playwright 库（可 cd d:\\WorkBuddy-projects\\testcase && npm install playwright）'); process.exit(1); }

const JT_WELCOME = 'http://jt-ll.test.ztoeco.com/welcome';
// 账密只存公司层私有凭证文件（2026-11-14 拍板：技能/脚本零明文账密；接入方法见手艺包 02_提示词与模板/07）
// 优先级：环境变量临时覆盖 > 凭证文件 jt_login 字段；文件路径可用 JT_SECRETS 重定向
// 凭证文件定位（2026-11-14 目录化重构·改名免疫）：环境变量 → 自身逐级上溯，每级查本目录及其一级子目录内的 agent-secrets.json
function _secretsPath(envName) {
  const fs = require('fs'), path = require('path');
  if (process.env[envName]) return process.env[envName];
  let dir = fs.realpathSync(__dirname);
  for (let i = 0; i < 5; i++) {
    const c = path.join(dir, 'agent-secrets.json');
    if (fs.existsSync(c)) return c;
    try {
      for (const n of fs.readdirSync(dir)) {
        const s = path.join(dir, n, 'agent-secrets.json');
        if (fs.existsSync(s)) return s;
        try {
          for (const m of fs.readdirSync(path.join(dir, n))) {
            const s2 = path.join(dir, n, m, 'agent-secrets.json');
            if (fs.existsSync(s2)) return s2;
          }
        } catch (e2) {}
      }
    } catch (e) {}
    dir = path.dirname(dir);
  }
  return path.join(dir, 'agent-secrets.json');
}
let _jt = {};
try {
  _jt = JSON.parse(require('fs').readFileSync(_secretsPath('JT_SECRETS'), 'utf8')).jt_login || {};
} catch (e) { console.error('读公司层凭证文件失败（agent-secrets.json）：' + e.message); }
const ACCOUNT = process.env.JT_ACCOUNT || _jt.user;
const SECRET = process.env.JT_SECRET || _jt.pass;
const DISPLAY = process.env.JT_DISPLAY || _jt.display || '陆潇雷';
if (!ACCOUNT || !SECRET) { console.error('未取到账密：检查公司层凭证文件 agent-secrets.json 的 jt_login 字段（或 JT_ACCOUNT/JT_SECRET 环境变量）'); process.exit(1); }
const LOGGED_IN_RE = new RegExp(DISPLAY + '|预发环境');
const SHOT_OK = path.join(__dirname, 'login_success.png');
const SHOT_ERR = path.join(__dirname, 'login_error.png');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function safeEval(page, fn, fallback = null) {
  for (let i = 0; i < 3; i++) {
    try { return await page.evaluate(fn); } catch (e) { await sleep(1500); }
  }
  return fallback;
}

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333', { timeout: 10000 });
  const ctx = browser.contexts()[0];

  // 1. 找页签：SSO 或鲸天，否则新建
  let page = ctx.pages().find(p => /sso\.test\.ztoeco\.com|jt-ll\.test\.ztoeco\.com/.test(p.url()));
  if (!page) {
    page = await ctx.newPage();
    await page.goto(JT_WELCOME, { timeout: 30000, waitUntil: 'domcontentloaded' });
    await sleep(4000); // 等 SSO 重定向
  }
  console.log('[tab]', page.url().slice(0, 110));

  // 已在鲸天内页则直接校验
  if (page.url().includes('jt-ll.test.ztoeco.com')) {
    const t = await safeEval(page, () => document.body.innerText, '') || '';
    if (LOGGED_IN_RE.test(t)) { console.log('RESULT: already-logged-in'); await page.screenshot({ path: SHOT_OK }); await browser.close(); return; }
  }

  // 2. 若不在 SSO 页（如卡在鲸天），重新触发
  if (!page.url().includes('sso.test.ztoeco.com')) {
    await page.goto(JT_WELCOME, { timeout: 30000, waitUntil: 'domcontentloaded' });
    await sleep(4000);
    if (!page.url().includes('sso.test.ztoeco.com')) throw new Error('未跳转到 SSO，当前: ' + page.url());
  }

  // 3. 切换到账密表单（扫码模式 0 输入框时）
  let inputs = await safeEval(page, () => [...document.querySelectorAll('input')].filter(el => el.offsetWidth || el.offsetHeight).length, 0) ?? 0;
  if (inputs === 0) {
    console.log('[sso] 扫码模式 → 点击"动态码登录"切换');
    await page.click('a.login-switch-link');
    await sleep(2500);
  }

  // 4. 识别表单字段（以页面实际结构为准）
  const form = await safeEval(page, () => {
    const vis = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const ins = [...document.querySelectorAll('input')].filter(vis).map(el => ({
      type: el.type, ph: el.placeholder || '', id: el.id || '', name: el.name || '',
    }));
    const btns = [...document.querySelectorAll('button, a[type="submit"], [class*="login-btn"], [class*="btn"]')]
      .filter(vis).map(el => ({ tag: el.tagName.toLowerCase(), cls: (el.className + '').slice(0, 50), text: (el.innerText || '').trim().slice(0, 20) }))
      .filter(b => b.text);
    return { ins, btns };
  });
  console.log('[form] inputs =', JSON.stringify(form.ins));
  console.log('[form] buttons =', JSON.stringify(form.btns));
  if (!form || !form.ins.length) throw new Error('切换后仍无输入框');

  // 账号框：text/tel 类；密码框：password 类型或 placeholder 含 动态码/密码
  const acc = form.ins.find(i => /^(text|tel)$/.test(i.type)) || form.ins[0];
  const pwd = form.ins.find(i => i.type === 'password' || /动态码|密码/.test(i.ph || '')) || form.ins[1];
  const accLoc = acc.id ? '#' + acc.id : acc.name ? `input[name="${acc.name}"]` : `input[type="${acc.type}"]`;
  const pwdLoc = pwd.id ? '#' + pwd.id : pwd.name ? `input[name="${pwd.name}"]` : `input[type="${pwd.type}"]`;

  console.log(`[fill] 账号→${accLoc} ; 密码/动态码→${pwdLoc}`);
  await page.fill(accLoc, ACCOUNT);
  await page.fill(pwdLoc, SECRET);

  // 5. 点登录按钮
  const loginBtn = form.btns.find(b => /^登\s*录$/.test(b.text));
  if (!loginBtn) throw new Error('未找到"登录"按钮: ' + JSON.stringify(form.btns));
  const btnLoc = loginBtn.tag === 'button'
    ? `button:has-text("${loginBtn.text}")`
    : `${loginBtn.tag}.${loginBtn.cls.split(' ')[0]}:has-text("${loginBtn.text}")`;
  console.log('[click]', btnLoc);
  await page.click(btnLoc);

  // 6. 等跳回鲸天并校验（最多 40s）
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    const u = page.url();
    if (i % 5 === 0) console.log(`[wait ${(i + 1) * 2}s]`, u.slice(0, 90));
    if (u.includes('jt-ll.test.ztoeco.com')) {
      const t = await safeEval(page, () => document.body.innerText, '') || '';
      if (new RegExp(DISPLAY + '|预发环境|冷链快运').test(t)) {
        console.log('[ok] 登录成功 URL =', u.slice(0, 90));
        await page.screenshot({ path: SHOT_OK });
        console.log('RESULT: login-success');
        console.log('SCREENSHOT:', SHOT_OK);
        await browser.close();
        return;
      }
    }
  }
  await page.screenshot({ path: SHOT_ERR });
  console.log('RESULT: login-timeout');
  console.log('SCREENSHOT:', SHOT_ERR);
  console.log('URL_NOW:', page.url().slice(0, 110));
  await browser.close();
  process.exit(2);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
