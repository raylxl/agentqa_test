/**
 * 鲸天登录（端口参数化版 · 分层执行模式 preflight 组件）
 * 流程改编自 jingtian-login 技能 chrome_jt_login.js（2026-10-27 实测），仅把 9333 参数化；
 * 沉淀原则：照抄已验证行为，不重新发明。
 *
 * CLI：  node pw_login.js --port 9335
 * 输出： RESULT: already-logged-in | login-success | login-timeout（超时退出码 2）
 * 模块： ensureLogin(port) → 同上三态
 * 账号/密码/显示名：JT_ACCOUNT / JT_SECRET / JT_DISPLAY 可覆盖；缺省均读 agent-secrets.json 的 jt_login，
 *        缺凭证报错退出（凭证红线，姿势照抄 api_channel.js）
 */
const path = require('path');
const fs = require('fs');
let chromium;
try { chromium = require('playwright').chromium; }
catch (_) { console.error('缺 playwright：在部署根执行 npm i playwright，或重跑部署器自动安装'); process.exit(1); }

const JT_WELCOME = 'http://jt-ll.test.ztoeco.com/welcome';
function findUpSecrets() {
  let d = __dirname;
  while (true) {
    for (const f of [path.join(d, 'agent-secrets.json'), path.join(d, '公司包', 'agent-secrets.json')]) {
      if (fs.existsSync(f)) return f;
    }
    const p = path.dirname(d);
    if (p === d) return null;
    d = p;
  }
}
function readLogin() {
  const f = findUpSecrets();
  if (!f) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')).jt_login || {}; } catch (_) { return {}; }
}
const LOGIN = readLogin();
const ACCOUNT = process.env.JT_ACCOUNT || LOGIN.user;
const SECRET = process.env.JT_SECRET || LOGIN.pass;
const DISPLAY = process.env.JT_DISPLAY || LOGIN.display || '';
if (!ACCOUNT || !SECRET) {
  console.error('缺凭证：设 JT_ACCOUNT/JT_SECRET，或填写 agent-secrets.json 的 jt_login 字段');
  process.exit(1);
}
const LOGGED_IN_RE = new RegExp([DISPLAY, '预发环境'].filter(Boolean).join('|'));
function loggedInText(t) { return t.includes('预发环境') && (!DISPLAY || t.includes(DISPLAY)); }
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function safeEval(page, fn, fallback = null) {
  for (let i = 0; i < 3; i++) {
    try { return await page.evaluate(fn); } catch (_) { await sleep(1500); }
  }
  return fallback;
}

async function ensureLogin(port) {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 10000 });
  try {
    const ctx = browser.contexts()[0];
    let page = ctx.pages().find(p => /sso\.test\.ztoeco\.com|jt-ll\.test\.ztoeco\.com/.test(p.url()));
    if (!page) {
      page = await ctx.newPage();
      await page.goto(JT_WELCOME, { timeout: 30000, waitUntil: 'domcontentloaded' });
      await sleep(4000); // 等 SSO 重定向
    }
    console.log('[login tab]', page.url().slice(0, 110));

    // ① 已在鲸天页：等 SPA 首屏渲染完再判（首帧常为「资源加载中...」，2026-11-09 实测 9335 误判教训）
    for (let i = 0; i < 8; i++) {
      if (page.url().includes('sso.test.ztoeco.com')) break;
      const t = (await safeEval(page, () => document.body.innerText, '')) || '';
      if (loggedInText(t)) return 'already-logged-in';
      await sleep(2000);
    }
    // ② 不在 SSO 且无登录特征：可能 token 过期但页面不自动跳 → 清 token 重新触发 SSO
    if (!page.url().includes('sso.test.ztoeco.com')) {
      console.log('[sso] 无登录特征，清 token 重新触发');
      await page.evaluate(() => { localStorage.removeItem('MICRO_APP_MAIN_TOKEN_KEY'); location.href = 'http://jt-ll.test.ztoeco.com/welcome'; }).catch(() => {});
      await sleep(4000);
      if (!page.url().includes('sso.test.ztoeco.com')) {
        await page.goto(JT_WELCOME, { timeout: 30000, waitUntil: 'load' });
        await sleep(4000);
      }
      if (!page.url().includes('sso.test.ztoeco.com')) {
        const t = (await safeEval(page, () => document.body.innerText, '')) || '';
        if (loggedInText(t)) return 'already-logged-in';
        await page.screenshot({ path: path.join(SHOTS, `login_noredir_${port}.png`) }).catch(() => {});
        return 'login-timeout';
      }
    }
    // 扫码模式（0 输入框）→ 切"动态码登录"表单
    const inputs = (await safeEval(page, () => [...document.querySelectorAll('input')].filter(el => el.offsetWidth || el.offsetHeight).length, 0)) ?? 0;
    if (inputs === 0) {
      console.log('[sso] 扫码模式 → 切动态码表单');
      await page.click('a.login-switch-link');
      await sleep(2500);
    }
    const form = await safeEval(page, () => {
      const vis = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const ins = [...document.querySelectorAll('input')].filter(vis).map(el => ({ type: el.type, ph: el.placeholder || '', id: el.id || '', name: el.name || '' }));
      const btns = [...document.querySelectorAll('button, a[type="submit"], [class*="login-btn"], [class*="btn"]')]
        .filter(vis).map(el => ({ tag: el.tagName.toLowerCase(), cls: (el.className + '').slice(0, 50), text: (el.innerText || '').trim().slice(0, 20) }))
        .filter(b => b.text);
      return { ins, btns };
    });
    if (!form || !form.ins.length) throw new Error('SSO 表单无输入框（可能改版）');
    const acc = form.ins.find(i => /^(text|tel)$/.test(i.type)) || form.ins[0];
    const pwd = form.ins.find(i => i.type === 'password' || /动态码|密码/.test(i.ph || '')) || form.ins[1];
    const accLoc = acc.id ? '#' + acc.id : acc.name ? `input[name="${acc.name}"]` : `input[type="${acc.type}"]`;
    const pwdLoc = pwd.id ? '#' + pwd.id : pwd.name ? `input[name="${pwd.name}"]` : `input[type="${pwd.type}"]`;
    await page.fill(accLoc, ACCOUNT);
    await page.fill(pwdLoc, SECRET);
    const loginBtn = form.btns.find(b => /^登\s*录$/.test(b.text));
    if (!loginBtn) throw new Error('未找到"登录"按钮: ' + JSON.stringify(form.btns));
    const btnLoc = loginBtn.tag === 'button' ? `button:has-text("${loginBtn.text}")` : `${loginBtn.tag}.${loginBtn.cls.split(' ')[0]}:has-text("${loginBtn.text}")`;
    await page.click(btnLoc);

    for (let i = 0; i < 20; i++) {
      await sleep(2000);
      const u = page.url();
      if (u.includes('jt-ll.test.ztoeco.com')) {
        const t = (await safeEval(page, () => document.body.innerText, '')) || '';
        if (loggedInText(t)) return 'login-success';
      }
    }
    await page.screenshot({ path: path.join(SHOTS, `login_timeout_${port}.png`) }).catch(() => {});
    return 'login-timeout';
  } finally {
    await browser.close(); // 只断 CDP 连接，不关浏览器（红线）
  }
}

module.exports = { ensureLogin };

if (require.main === module) {
  const i = process.argv.indexOf('--port');
  const port = i >= 0 ? parseInt(process.argv[i + 1], 10) : 9333;
  ensureLogin(port)
    .then(r => { console.log('RESULT:', r); if (r === 'login-timeout') process.exit(2); })
    .catch(e => { console.error('ERR:', e.message); process.exit(1); });
}
