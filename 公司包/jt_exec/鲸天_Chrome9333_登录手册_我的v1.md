# 鲸天系统 Chrome 登录手册（我的方案 v1）

> 2026-10-27 实测建立。本手册是**独立实测产物**：仅参考了 `D:\ZCodetest\鲸天系统_登录与操作文件汇总_20261027\` 中的账号与"强制 http"经验，浏览器环境、脚本、选择器均为本方案自有，与该汇总中的 Edge 9222 体系无关。
> 用户口径（2026-10-27）：所有既有文档仅作参考；鲸天一律用我配置的 **Chrome 9333** 实例操作。

## 1. 环境

| 项目 | 值 |
|------|-----|
| 浏览器 | Chrome 156 独立实例（不影响日常浏览器） |
| CDP 端口 | `127.0.0.1:9333` |
| 用户目录 | `D:\ZCodetest\.chrome-cdp`（登录态持久化于此，重启自动恢复） |
| 鲸天地址 | `http://jt-ll.test.ztoeco.com/welcome`（**全程 http**，登录成功后停在 /welcome） |
| SSO | `http://sso.test.ztoeco.com/oauth2/authorize`（http，页面自动跳转，无需手动进） |
| 账号 | luxiaolei99（显示名：陆潇雷） |
| 密码 | **不入文档**——=`agent-secrets.json` 的 jt_login.pass（登录技能/pw_login 自动读取；SSO"动态密码"框兼容此静态密码） |

## 2. 启动命令（关键：防 http→https 自动升级）

服务器对 http 直接返回 200（已 curl 验证），**不需要** host-resolver-rules 重定向；但 Chrome 会把 http 导航自动升级为 https，导致 SSO 链路变 https 而失败。必须带以下参数启动：

```bash
powershell -NoProfile -Command "Start-Process -FilePath 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ArgumentList '--remote-debugging-port=9333','--user-data-dir=D:\ZCodetest\.chrome-cdp','--no-first-run','--no-default-browser-check','--start-maximized','--ignore-certificate-errors','--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,HttpsFirstModeV2ForEngagedSites'"
```

- 用前检查：`curl -s http://127.0.0.1:9333/json/version`
- 实例若以旧参数（无 disable-features）在跑，需先 kill 再按上述重启：
  `netstat -ano | grep :9333` 找 PID → `taskkill //PID <pid> //F`

## 3. 登录流程（实测，2026-10-27 走通）

1. 打开 `http://jt-ll.test.ztoeco.com/welcome` → 自动 302 到 SSO 授权页（标题"中通快递 - 誉满中华，通达天下"）
2. SSO 默认**扫码模式**（0 个输入框，页面有"「中通宝盒」扫一扫登录"字样）
3. 点切换链接 `a.login-switch-link`（文字"动态码登录"）→ 出现账密表单
4. 表单结构（以 name 定位，无 id）：
   - 账号：`input[name="username"]`（placeholder"请输入中天账号"）
   - 密码：`input[name="password"]`（**type=text**，placeholder"请输入中通宝盒动态密码"，直接填静态密码）
   - 提交：`button.login-btn`（文字"登录"）
5. 点登录 → 带 code 跳回 `http://jt-ll.test.ztoeco.com/login/login.html?code=...` → 进入 `/welcome`

### 登录成功判据

- URL 回到 `jt-ll.test.ztoeco.com`，页面正文含 **陆潇雷** / **预发环境**
- 租户行显示 **冷链快运**；侧边菜单（冷链财务管理、仓链账单管理等）已渲染

## 4. 我的脚本（`D:\ZCodetest\jt_chrome\`）

| 脚本 | 作用 |
|------|------|
| `chrome_jt_probe.js` | 连 9333 打开鲸天，dump SSO 页输入框/按钮/切换链接结构（摸页面用） |
| `chrome_jt_login.js` | 完整自动登录：找/建页签 → 扫码模式自动切表单 → 填账号密码 → 点登录 → 校验登录态，截图 `login_success.png` / `login_error.png` |

运行：`cd D:\ZCodetest\jt_chrome && node chrome_jt_login.js`（playwright 库取自本机 `d:\WorkBuddy-projects\testcase\node_modules`，仅作驱动库）。已登录时脚本幂等，直接返回 already-logged-in。

## 5. 与参考文档（Edge 9222 体系）的实测差异

| 项 | 参考文档（Edge） | 本方案（Chrome 9333 实测） |
|----|----------------|--------------------------|
| 扫码→表单切换 | `.login-switch.by-static` | `a.login-switch-link`（文字"动态码登录"） |
| 防 https 手段 | `--host-resolver-rules=MAP ...:443 127.0.0.1:80` 等重定向 | 仅需 `--disable-features=HttpsUpgrades,...`（服务器 http 本就 200） |
| 登录后落点 | `/dashboard` | `/welcome`（正文含陆潇雷/预发环境即成功） |

## 6. 注意事项

- 全程禁止 https：任何一步 URL 变 `https://` 即异常，检查 Chrome 是否带齐启动参数
- 只 kill 9333 端口对应的进程，绝不 `taskkill /IM chrome.exe`（会杀用户日常浏览器）
- 登录态存于 `.chrome-cdp` 目录；若 SSO 会话过期，重跑 `chrome_jt_login.js` 即可（会重新走账密）
- 若某天动态密码不再兼容静态密码（提示密码错误），改走"中通宝盒"扫码：留 SSO 扫码页让用户手机扫即可
