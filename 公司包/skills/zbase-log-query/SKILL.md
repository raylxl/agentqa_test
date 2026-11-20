---
name: zbase-log-query
description: 查 ZBASE（一体化运管平台）应用日志——一条命令完成"应用页导航+时间范围(默认1天)+关键字查询+结果抓取"。当用户说"查ZBASE日志/ZBASE查日志/看看应用日志/日志里查一下/这个单号日志/这个任务的日志"，或要从开发代码仓反推应用与日志关键字（app_map 映射）时使用。前置依赖 zbase-login（Chrome 9338 已登录）。
---

# ZBASE 日志查询（一条命令）

## 用法

```bash
node scripts/zlog_query.js <应用名> <关键字> [天数=1] [环境=fatlengliannew]
# 示例：月结任务日志（默认1天）
node scripts/zlog_query.js phecda-waccount-service quoteSettlementBatchJob
# 示例：MQ 消费链按订单号查（3天）
node scripts/zlog_query.js ztocc-phecda-quote-wbms-mq 1794923846 3
```

输出 JSON：`{app, kw, days, env, timeBar, total, sample}`——total=命中数，sample=结果区前 4000 字符（`ZLOG_SAMPLE` 环境变量可调大）。

## 应用名从哪来：app_map.json（36 应用全量映射，2026-11-17 实抓）

- `scripts/app_map.json`：`apps`（应用→git 仓库地址）+ `repo_to_apps`（仓→应用反向九组）
- **代码仓 → 应用**：查 `repo_to_apps`；注意 **-mq 后缀应用共用主仓**（MQ 消费链日志查 `-mq` 应用）、`ztocc-phecda-quote` 一仓喂三应用（tqs/quote-provider/quote-service）
- 不知道应用也不知道关键字时：`{integrations.dev_git.clone_root}` 代码库 grep 功能词/单号字段定位类 → 查 app_map 得应用 → 关键字见下节
- 正本登记=基础数据总清单批次30

## 关键字怎么挑

| 场景 | 关键字 | 说明 |
| --- | --- | --- |
| 查某单 | 订单号/运单号/**完整流水号** | ⚠纯数字短词会模糊命中爆炸（1794923846→2.6万条）；完整 wbmsEventConsumerId（含字母前缀）最准 |
| 查任务/调度 | 代码日志字面量 | grep 仓内 `log.info/error` 挑特征词（如 `quoteSettlementBatchJob`） |
| 查报错 | ERROR 类日志特征词 | sample 里 ERROR+堆栈可直接当缺陷证据引用 |

**⚠查询有效性铁律（2026-11-17 双盲验证）**：填词必须 `input`+`change` **双事件**（change 才把词写进查询模型，缺 change=提交空条件→total 显示的是全量日志数的假命中）；**自动化查询上线/改版后必做"不存在词对照"**（查 `zlog_probe_zzz_notexist123` 应 total=0，非 0=条件没生效）。

## 环境与时间

- 环境：默认 `fatlengliannew`（**测试**）；`prolengliannew`=生产（勿用于测试取证）
- 时间：默认 **1 天**（用户 2026-11-17 拍板）；脚本自动改 Relative N days，无需手动

## 原理（排障时看）

1. 主文档 hash 导航到 `#/user/application/log?appId=...`（iframe 重建）
2. `Target.setAutoAttach(flatten)` 拿 zlog 跨域 OOPIF 独立 session
3. iframe 内全 DOM 操作：时间弹层（数字+单位 select）→填词→合成 click"搜索"→等 8s→抓 body
4. **铁律**：必须 ZBASE 内嵌 iframe 态（顶层开 zlog URL 搜索按钮哑火，详见坑库 G52）

| 症状 | 处置 |
| --- | --- |
| `NO_TAB: 9338 无一体化页签` | 先跑 zbase-login 技能登录 |
| `NO_ZLOG_IFRAME` | iframe 时序未就绪，重跑一次即可 |
| total=0 但应有日志 | 关键字换完整流水号；天数拉长；确认环境是测试 |
| total 异常巨大 | 纯数字/短词模糊命中，换更长关键字 |
| timeBar 为空 | 时间设置失败（弹层时序），重跑；结果仍可用但范围=默认 |

## 失败用例自动取证（执行体系集成，2026-11-17 立）

**触发**：用例 FAIL（断言失败/落账超时/可疑 BLOCKED）→ 失败钩子立即取证（日志时效优先，勿等收尾）。

```bash
# 单号来自失败上下文（A2 六字段本就收集单号）；应用链默认计费域双应用，可按册覆盖
node scripts/zlog_evidence.js <单号> --tag <用例号> --outdir <本轮证据目录> [--apps ...] [--days 1]
# 输出：stdout 汇总 JSON + zlog_<单号>.md（报告可 include 的失败卡片第七块）
```

**三挂点**（取/现/用分层）：

| 层 | 位置 | 接线 |
| --- | --- | --- |
| 取（引擎层） | pw_layered 失败落账处 | 调 `zlog_evidence.js`，产物落证据目录（与截图/接口json同级），账本失败行记 `zlog_evidence` 指针 |
| 现（报告层） | executor 工序5 §20.10 失败卡片 | 六字段后渲染**第七块"ZBASE 日志证据"**（可选块：有则 include MD 片段，登录态失效标"未取"不红、不阻塞 report_sync 硬⑥） |
| 用（闭环层） | feedback-loop 定性 / 缺陷提单 | 证据已在卡片：定性 SYS/DEF 直接引用；缺陷模板"判定过程留痕"字段引用 ERROR 行 |

**降级链**：9338 登录态失效→先跑 zbase-login（宝盒须通知用户）→仍失败则子块标"未取（原因）"；单应用查询失败不中断其余应用。

**应用链配置建议**：计费域默认 `ztocc-phecda-quote-wbms-mq,phecda-waccount-service`；对客册侧重 customer 消费链（mq 同应用）；存储/仓内册按落账应用换 `ztocc-phecda-data-wbms-mq` 或 waccount；跨册统一配在执行轮 spec。

**关键字纪律**：完整流水号（`wbmsEventConsumerId` 形态，含字母前缀）> 订单号 > 纯数字短词（模糊命中爆炸，禁用于取证）。

## 红线

1. 前置 zbase-login：9338 登录态失效时先走该技能（一键登录须通知用户宝盒确认）
2. 只查测试环境（fat*）做取证；生产（pro*）只读不操作
3. 本技能只读日志；改任务参数/运行任务走 ZBASE 调度页人工或另行固化
