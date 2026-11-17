---
name: devops-login
description: 访问/登录中通一站式研发平台（devops.dev.ztoeco.com），在 Chrome 9333 实例上打开平台页签；OAuth 会话过期时自动完成 connect.zto.com 授权页的"一键登录"（宝盒账号卡真实点击）。当用户说"访问一站式平台/打开 devops/登录一站式平台/去一站式看缺陷/提单"，或提到 devops.dev.ztoeco.com、ISS 缺陷单号要查缺陷前使用。
---

# 一站式研发平台登录与访问

## 0. 前置

- Chrome 9333 CDP 实例在线（不在线先跑 jingtian-login 的 launch 脚本启动实例；本 skill 只负责平台侧）
- 工具链在本技能 `scripts/`：`node "$SKILL/cdp_eval.js" <页签关键词> <exprFile>`；真实点击用 `node "$SKILL/zc_steps.js" <页签关键词> steps.json`。`$SKILL`=当前宿主加载本技能时的 scripts 子目录。

## 1. 打开平台页签（两步法，/json/new 不可靠）

```bash
# ① 建空白页签（PUT /json/new 经常只建 about:blank 不导航，正常）
curl -s -X PUT "http://127.0.0.1:9333/json/new" 
# ② 对 about:blank 发 location 导航（exprFile 内容：location.href="<目标URL>"; "navigating"）
node cdp_eval.js about _expr_nav.txt
```

**快速通道**：9334 登录态落在部署根 `.chrome-cdp-9334`。Windows：运行 `$SKILL/open_devops.ps1` 后 `node "$SKILL/devops_auto_login.js"`；Mac 尚未完成一站式宝盒客户端链路真机验收，按首验清单记录。
成功判据=②输出 `OK`。失败才走下面 §1~§3 手动流程。

常用 URL：
- 缺陷列表：`https://devops.dev.ztoeco.com/cooperate/bug?productCode=PRO2307058000&tabActive=4`（PRO2307058000=中通冷链-财金产品；tabActive=4=全部缺陷视图）
- 平台首页：`https://devops.dev.ztoeco.com`

页签关键词：**中通**（OAuth 页 title="中通快递 - 誉满中华，通达天下"）/**缺陷**（登录后 title="缺陷-一站式研发平台"）/**一站式**。

## 2. 登录态三形态与处置

| 形态 | 判据 | 处置 |
| --- | --- | --- |
| ① 已登录直达 | 页签 title="…-一站式研发平台"，URL 回 devops 域 | 无需操作，直接抓数据 |
| ② OAuth 自动过 | 停 connect.zto.com 几秒内自己回跳 devops | 等待即可（≤15s） |
| ③ OAuth 停授权页（需一键登录） | title="中通快递…"，页面文本含"您已打开电脑宝盒，可选择账号一键登录"+当前登录人的宝盒账号卡+"一键登录"按钮 | 走 §3 |

## 3. 一键登录（2026-11-06 实测定稿）

**铁律：合成 el.click() 无效**（会点到 .login-box 等容器 DIV 不触发 Vue 事件）——必须 **CDP 真实点击最内层元素**：

```bash
# ① 定位最内层"一键登录"元素中心坐标（children.length===0 的叶子）
# expr: [...document.querySelectorAll('*')].filter(e=>e.offsetParent&&e.children.length===0&&(e.innerText||'').trim()==='一键登录')[0] → 取 rect 中心
# ② zc_steps 真实点击（steps.json: [{"loc":"[x,y]","click":true,"wait":5000}]）
node zc_steps.js 中通 _steps.json
```

- 点击后**等 5~15 秒**（宝盒确认是异步轮询，URL 不动别急着重试）；成功判据=页签 title 变"…-一站式研发平台"且 URL 回 devops
- 失败分支：页面是纯扫码态（无"一键登录"卡，提示用「中通宝盒」扫一扫）→ 停下提醒用户用中通宝盒扫码，其余情况不麻烦用户

## 4. 平台页数据抓取要点（缺陷列表）

- 表格：`[...document.querySelectorAll('table')].flatMap(tb=>[...tb.querySelectorAll('tbody tr')].map(r=>[...r.querySelectorAll('td')].map(c=>c.innerText.trim()).join(' | ')))`
- 分页：`.z-pager` 内数字页签（点"2"翻页后重抓）；总数=正文"共 N 条"
- 页签卡死（evaluate 全超时）→ `curl -X GET http://127.0.0.1:9333/json/close/<tabId>` 关掉，按 §1 重开
- 刷新数据：优先点页面内"查询"类按钮；确需 reload 时注意 evaluate 会因导航超时属正常，等 10s 再抓

## 5. 红线

1. 全程真实事件点击（合成 click 对该平台 OAuth 页无效，§3 铁律）
2. 不 taskkill chrome；只能关目标页签
3. OAuth/宝盒扫码需要用户手机操作时才提醒用户，自动路径（一键登录）必须先走完
