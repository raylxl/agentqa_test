# Agent本体 —— 运行本体（流程技能 + 机器闸 + 接线工具）

> 2026-11-14 目录化重构立。本目录 = 测试 Agent 的运行本体：10 个参数化流程技能 + 3 hooks + 改名工具。
> 与 `手艺包`（通用分发件）、`公司包`（公司家底）同级，同住 `agentqa_test\`；接线总说明见 `..\README.md`。

## 目录

| 路径 | 内容 |
|---|---|
| `skills\` | 10 个流程技能：orchestrator（总调度）/ requirement-qa-loop（答疑）/ usecase-generator+pipeline（生成）/ usecase-challenger（质疑）/ usecase-external-compare（外部对比）/ usecase-executor（执行）/ usecase-feedback-loop（反馈闭环）/ usecase-qc（独立质检）/ usecase-history-cleanup（归档）。全部参数化：公司值读 `..\公司包\agent-company.json`（按文件名逐级定位，目录改名免疫），无配置自动降级通用模式 |
| `skills\devops-login` | 联接 → `..\公司包\skills\devops-login`（环境技能物理正本在公司包） |
| `hooks\` | 3 道机器闸：block_master_edit（正本直改拦截·PreToolUse）/ reread_reminder（正本改动重读提醒·PostToolUse）/ paiban_ledger_reminder（拍板对账提醒·PostToolUse）；注册于 `<user-home>\.zcode\cli\config.json`（改它=⚠需重开会话生效） |
| `tools\rewire.py` | 接线体检与改名工具：`--status` 体检 / `--repair` 修联接 / `--rename 旧名 新名`（迁目录+重建联接+改配置+登记别名+旧名留兼容联接） |

## 运行位与物理位

- 物理正本 = 本目录；ZCode 只认固定运行位，靠 junction 联接（`<workspace>\.zcode\skills` → 本目录 `skills\`；用户级环境技能 → `..\公司包\skills\`）；
- 技能/脚本内定位公司配置与凭证一律**按文件名逐级上溯扫描**（`agent-company.json`/`agent-secrets.json`），不写死目录名——三包目录随便改名，rewire.py 一键重接。

## 隔离契约（2026-11-14 验收）

- 本体只保留流程、通用组装/治理逻辑、hook 协议和适配器契约；公司值从 `agent-company.json` 读取，凭证只允许在公司包私有文件。
- 公司执行工具、浏览器/租户适配、知识库 provider、归档白名单和域词属于公司包；本体只使用 `{paths.X}`、`execution_adapters`、`integrations` 等配置接口，缺适配器时明确降级或 `BLOCKED`。
- `skills\devops-login` 是运行 junction，物理正本在公司包；物理扫描和外发清单必须跳过 junction，不能跟随联接复制公司内容。
- 一次性 wrapper、旧备份和 Python 缓存不属于运行本体；一次性公司工具放公司包 `tools\legacy`，本体不保留 `.bak`/`.pyc`。
- 隔离验收证据：`<workspace>\AiTest\05_问题与台账\Agent本体_手艺包物理隔离验收报告_v1.md`。

