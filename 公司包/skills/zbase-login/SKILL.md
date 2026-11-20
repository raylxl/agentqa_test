---
name: zbase-login
description: 登录 ZBASE（一体化运管平台，zbase.dev.ztoeco.com），用 Chrome 9338 专属独立实例。当用户说"登录ZBASE/打开ZBASE/访问ZBASE/进ZBASE/去ZBASE触发月结/ZBASE月结"，或要在 ZBASE 里找应用 phecda-waccount-service、调度任务"到期月结费用"（quoteSettlementBatchJob）前需要先登录时使用。SSO 跳 connect.zto.com 授权页，一键登录卡 CDP 真实点击 + 立即通知用户在宝盒确认。
---

# ZBASE 登录（Chrome 9338）

## 环境事实（2026-11-17 实测）

| 项 | 内容 |
| --- | --- |
| 系统 | ZBASE 一体化运管平台（title=一体化运管平台） |
| 完整地址 | `https://zbase.dev.ztoeco.com/#/user/product/view?productCode=prddefhov`（产品=中通冷链-财金产品） |
| 登录方式 | 无账密表单；SSO 跳 `connect.zto.com/oauth2/authorize`（appid=zt5XvzaeQpUpKCghpT8zcbcg） |
| 一键登录卡 | 电脑宝盒客户端在跑时出卡（当前登录人+部门+"一键登录"按钮）；点击后**仍需用户在电脑宝盒/手机宝盒确认**，异步轮询 **15s+** 才回跳 |
| 纯扫码态 | 电脑宝盒没开时页面只有「使用中通宝盒扫一扫」——停下提醒用户扫码，无自动路径 |
| 登录态落点 | `.chrome-cdp-9338` profile（一次性登录长期有效，勿删） |

**端口占用全景（勿撞）**：9333=鲸天 / 9334=devops 登录态实例 / 9335=AI 执行保留位 / 9336=回归锁 / 9337=被占（来历未确认） / **9338=ZBASE 专属**。

## 使用步骤

```bash
# ① 检查实例（通则跳过②）
curl -s --max-time 3 http://127.0.0.1:9338/json/version
# ② 启动实例（默认无头；需可视化传 -Visual）
powershell -NoProfile -ExecutionPolicy Bypass -File "<本技能>/scripts/launch_chrome_9338.ps1" [-Visual]
# ③ 开页签+登录（幂等，自动判态）
node "<本技能>/scripts/zbase_login.js"
```

## RESULT 分支与处置

| RESULT | 含义 | 处置 |
| --- | --- | --- |
| `already-logged-in` | 登录态有效，页签已在 ZBASE | 直接用 |
| `login-success` | 一键登录+宝盒确认完成，已回跳 | 直接用 |
| `need-user-scan` | 纯扫码态（宝盒客户端没开） | **停下提醒用户用「中通宝盒」App 扫码**，扫完重跑③ |
| `login-timeout` | 点了卡但宝盒未确认/回跳超时 | 提醒用户确认后重跑③（勿连续急点） |
| `open-failed` | 页签没建起 | 重跑③；仍失败查①② |

## 红线

1. **新开实例无登录态时：脚本打出 `NOTIFY` 后必须立即转告用户"请在电脑宝盒/手机宝盒确认"**——一键登录不是全自动，宝盒确认是用户动作（用户 2026-11-17 拍板）。
2. 合成 `el.click()` 对 OAuth 授权页无效——必须 CDP `Input.dispatchMouseEvent` 真实点击最内层"一键登录"元素中心。
3. 点击后回跳要 15s+（异步轮询），URL 不动别急着重试点。
4. 不 `taskkill /IM chrome.exe`；只操作 9338 自己的页签。
5. 本技能只管登录与页签；进了 ZBASE 之后的业务操作（月结触发等）见下节路径，另行走 CDP。

## 登录后常用去向：月结定时任务人工触发（基础数据总清单批次13）

| 项 | 内容 |
| --- | --- |
| 应用 | **phecda-waccount-service**（必须选**测试环境**） |
| 菜单 | 调度 → 任务名称=**到期月结费用**（执行器=quoteSettlementBatchJob） |
| 操作 | 编辑 → 任务参数填 JSON → 提交 → 运行一次 |
| 参数 | `{"orderNumber": "订单号", "settlementDate": "yyyy-MM-dd"}`（按订单号+指定日期精确触发，无需等真实周期日） |

## 日志查询（2026-11-17 用户演示路径 + 自动化实测固化）

| 项 | 内容 |
| --- | --- |
| 入口 | 应用详情 → 日志菜单：`#/user/application/log?appId={应用}&env={环境}&productCode=prddefhov` |
| 查询框 | zlog iframe（`zbase-zlog.zt-express.com`，**跨域 OOPIF**）内的"搜索..."框；填词→点"搜索"按钮 |
| 时间 | 默认 Last 15 minutes；改法=时间弹层 Relative 数字+单位（原生 select 可 JS 设值+change） |
| 环境 | URL env 参数：`pro*`=生产 / `fat*`=测试；应用列表页"搜索信息"框=**搜应用名**，不是日志关键字 |

**铁律：必须在 ZBASE 内嵌 iframe 态下操作**——顶层直接打开 zlog URL 时"搜索"按钮哑火（不发任何查询请求，performance 里可证）；填词须 `input`+`change` 双事件（change 才把词写进查询模型，缺 change=提交空条件假命中，2026-11-17 双盲验证），双事件后合成 `btn.click()` 有效。

**自动化通道**（跨域 iframe 主文档 JS 够不着，须 CDP 进 OOPIF session）：
```bash
# expr 文件示例见 scripts/zlog_query_example.txt（填词+点搜索+抓结果一体，awaitPromise）
node scripts/zpeek2.js 一体化 zbase-zlog <expr文件>   # Target.setAutoAttach(flatten) 进 iframe 独立 session
```
坑：zpeek2 的 evaluate 必须带 `returnByValue+awaitPromise`（async IIFE 否则返回 undefined）；搜索框填值用原生 value setter+input 事件（React 受控）。

## 故障排查

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `connect.zto.com` 页无一键登录卡 | 电脑宝盒客户端没开 | 走 need-user-scan 分支提醒用户 |
| 点击后 45s 仍不回跳 | 宝盒端没人确认 | 提醒用户；确认后重跑③（登录态幂等） |
| evaluate 全超时 | 页签导航中/卡死 | `curl -X GET http://127.0.0.1:9338/json/close/<tabId>` 关页签，重跑③ |
| 9338 连不上 | 实例没起/端口被抢 | 重跑②；`netstat -ano \| grep :9338` 查占用 |
| profile 落错位置 | 从公司包/联接位调用时相对层级错位 | 脚本按 G51 同款逻辑优先取已有 `.chrome-cdp(-9338)` 的根；仍错则显式改 D:/ZCodetest |
