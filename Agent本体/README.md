# Agent本体 —— 运行本体（流程技能 + 机器闸 + 接线工具）

> 2026-11-14 目录化重构立。本目录 = 测试 Agent 的运行本体：14 个实体技能 + 3 个环境技能联接 + 7 hooks + 改名工具。
> 与 `手艺包`（通用分发件）、`公司包`（公司家底）同级，同住 `agentqa_test\`；接线总说明见 `..\README.md`。

## 目录

| 路径 | 内容 |
|---|---|
| `skills\` | 14 个实体技能：usecase-orchestrator（总调度）/ requirement-qa-loop（①答疑）/ lanhu-req-extract（需求文档采集）/ usecase-generator＋usecase-pipeline（②生成）/ usecase-spec-gate（②规格保真门）/ usecase-challenger（③设计质疑）/ usecase-external-compare（外部对比）/ usecase-executor（⑤执行）/ usecase-execution-challenger（⑤判定质疑门）/ usecase-feedback-loop（⑥反馈闭环）/ usecase-defect-challenger（提单前质疑）/ usecase-qc（⑦独立质检）/ usecase-history-cleanup（归档）。全部参数化：公司值读 `..\公司包\agent-company.json`（按文件名逐级定位，目录改名免疫），无配置自动降级通用模式；**清单以 `skills\` 目录实况为准** |
| `skills\{devops-login,zbase-login,zbase-log-query}` | 联接 → `..\公司包\skills\` 对应目录（环境技能物理正本在公司包，本体侧只留 junction） |
| `hooks\` | 7 个钩子。5 道机器闸：block_master_edit（正本直改拦截·PreToolUse）/ reread_reminder（正本改动重读提醒·PostToolUse）/ paiban_ledger_reminder（拍板对账提醒·PostToolUse）/ memory_guard（记忆索引守卫·PostToolUse）/ activity_trace（计时底账·工具时刻·PostToolUse）；计时底账另两件（2026-11-25 立）turn_in_trace（回合开始·UserPromptSubmit）/ turn_out_trace（回合结束·Stop）——只记不输出不阻断，钩子在子代理内不触发；＋辅助模块 `_company_profile.py`；注册于 `<user-home>\.zcode\cli\config.json`（改它=⚠需重开会话生效）；**数量与清单以 `tools\rewire.py` 的 `hook_templates()` 为准** |
| `tools\rewire.py` | 接线体检与改名工具：`--status` 体检 / `--repair` 修联接 / `--rename 旧名 新名`（迁目录+重建联接+改配置+登记别名+旧名留兼容联接） |
| `tools\timeline_mark.py`／`timeline_check.py` | 阶段计时（《计时与时间线规范》v1.2）：打点工具 `begin/end/miss/status/report`（净耗时取三路底账自动算，禁手填）＋独立机检（只读、十三项、可对账本批次行）；每个流程技能开工第一步／收工最后一步各打一点 |

## 运行位与物理位

- 物理正本 = 本目录；ZCode 只认固定运行位，靠 junction 联接（`<workspace>\.zcode\skills` → 本目录 `skills\`；用户级环境技能 → `..\公司包\skills\`）；
- 技能/脚本内定位公司配置与凭证一律**按文件名逐级上溯扫描**（`agent-company.json`/`agent-secrets.json`），不写死目录名——三包目录随便改名，rewire.py 一键重接。
- 客户端目录可用环境变量覆盖：`ZCODE_HOME`（默认 `<user-home>\.zcode`）、`CLAUDE_HOME`（默认 `<user-home>\.claude`），供并行客户端或多用户目录排查使用。

## 隔离契约（2026-11-14 验收）

- 本体只保留流程、通用组装/治理逻辑、hook 协议和适配器契约；公司值从 `agent-company.json` 读取，凭证只允许在公司包私有文件。
- 公司执行工具、浏览器/租户适配、知识库 provider、归档白名单和域词属于公司包；本体只使用 `{paths.X}`、`execution_adapters`、`integrations` 等配置接口，缺适配器时明确降级或 `BLOCKED`。
- `skills\{devops-login,zbase-login,zbase-log-query}` 是运行 junction，物理正本在公司包；物理扫描和外发清单必须跳过 junction，不能跟随联接复制公司内容。
- 一次性 wrapper、旧备份和 Python 缓存不属于运行本体；一次性公司工具放公司包 `tools\legacy`，本体不保留 `.bak`/`.pyc`。
- 隔离验收证据：`<workspace>\AiTest\05_问题与台账\Agent本体_手艺包物理隔离验收报告_v1.md`。

