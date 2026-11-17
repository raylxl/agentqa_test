# 公司包 —— 公司家底（永不出门）

> 2026-11-14 立（用户拍板"所有涉及公司层的都迁移：方法留手艺包、连接信息留公司层"）。
> **整包列入分发禁发清单**（agent-company.json `分发.禁发清单`）；发版/外发任何文件前跑双机检。

## 内容

| 文件/目录 | 说明 |
|---|---|
| `agent-company.json` | 公司适配配置：paths/naming/standards/环境/域词/白名单/分发/**路径迁移别名**；技能与脚本运行时现读（改完无需重开会话）；修改按硬规则 8 宣告 |
| `agent-secrets.json` | **明文账密/DB 连接信息唯一落点**（jt_login/jt_login_2/pm_login/db_pwqsdb 四组）：任何技能/文档/报告/memory 禁复述其中明文；登录脚本运行时按文件名逐级定位（目录改名不影响） |
| `company_wordlist.json` | 发版机检词表（公司专名/内网域名），配合手艺包 03_检查脚本使用 |
| `param_check.py` + `param_snapshot.json` | 参数化护航：快照 48 值零丢失校验；目录搬迁/改名经「路径迁移别名」换算后判定 |
| `开发代码库接入说明_v1.md` | 同事换/接自己的 git 开发代码库操作指引（clone→改 integrations.dev_git 两字段→验证；含权限/多产品线/app_map 重抓说明） |
| `skills\` | 7 个环境登录技能（jingtian-login / jingtian-org-switch / jingtian-tenant-switch / pm-center-login / devops-login / zbase-login / zbase-log-query）：公司专属，经用户级联接被 ZCode 发现 |

## 纪律

1. 凭证只进 `agent-secrets.json`，别处一律写"读凭证文件 xx 字段"；
2. 本包任何文件不随分发出门；`手艺包` 发版前跑 `generic_layer_check`（词表=本包 company_wordlist.json）+ 密钥扫描双绿；
3. 接线体检/改名：`python ..\Agent本体\tools\rewire.py --status`。
