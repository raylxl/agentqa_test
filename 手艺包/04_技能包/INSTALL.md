# 安装说明（一页）

## 这个包是什么

一套行业无关的 AI 测试方法论资产：标准（怎么写用例）+ 提示词与模板（怎么跟 AI 协作）+ 检查脚本（怎么防止公司内容混入）+ 流程技能（ZCode 用户的自动化工序）。零公司数据、零凭证（发版机检保证）。

## 按 usage 三选一

1. **只看文档**：读 `../01_标准/` 两份标准改写你的用例；`../02_提示词与模板/` 直接投喂你在用的 AI 工具。
2. **接你的 agent（无 ZCode）**：把 `../02_` 的模板设为你的 agent 固定工作格式（BRIEF 开工、五段式提问/呈报、三段式报告收尾）；`../03_` 机检接进交付流程。
3. **ZCode 用户装技能**：见下。

## ZCode 技能安装（三步）

1. 把 `skills/` 下十三个技能目录复制到你的 workspace 技能目录：`<你的workspace>/.zcode/skills/`
   - `requirement-qa-loop`（需求答疑闭环）
   - `usecase-challenger`（用例独立质疑门禁）
   - `usecase-defect-challenger`（提单前独立质疑：缺陷草稿六查，放行才准提单）
   - `usecase-external-compare`（外部用例对比四查）
   - `usecase-feedback-loop`（执行反馈闭环）
   - `usecase-generator`（用例生成工序，含通用组装/格式转换脚本）
   - `usecase-pipeline`（流水线编排壳＋BRIEF/矩阵/证书/组装资产）
   - `usecase-history-cleanup`（用例文件历史版本归档）
   - `usecase-execution-challenger`（执行判定独立质疑：复核包→分路六核查→双账本与改判清单）
   - `usecase-executor`（用例 AI 执行：纪律/四阶段流程/接口通道，公司件引用走 execution_adapters 占位）
   - `usecase-qc`（执行交付独立质检：九查+红黄绿判定）
   - `usecase-orchestrator`（需求流水线总调度：验门/推进/停机卡）
   - `usecase-spec-gate`（规格保真门：开批前对机器规格做机检七检＋子代理六保真维度复核）
2. 复制本目录 `agent-company.example.json` 到 `<你的workspace>/.zcode/agent-company.json`，按注释填你的公司值（**不填也能跑**：技能自动降级通用模式并提示你补配置；凭证一律不入此文件）。
3. 复制 `../03_检查脚本/wordlist.example.json` 为你的公司词表（放在包外），填你们公司/系统专名；发版/外发任何文件前跑：
   `python generic_layer_check.py <目录> --config <你的词表>` 全绿才放行。

## 首次验证（装完花 5 分钟）

1. 对任一需求文档说"熟悉下这个需求"→ qa-loop 应走五段式提问；
2. 生成用例后说"质疑一下"→ challenger 应独立重推导并出违例清单；
3. 无 agent-company.json 时技能应提示"先建公司配置"而不是报错。

## 版本

| 版本 | 日期 | 说明 |
|---|---|---|
| v1.1 | 2026-11-13 | 技能包层首版：四技能通用副本 + 公司配置模板 + 本说明 |
| v1.2 | 2026-11-16 | 新增 usecase-generator / usecase-pipeline / usecase-history-cleanup 通用副本（SKILL.md＋references/assets/scripts 附属件，小节结构与公司版一字不差） |
| v2.0 | 2026-11-16 | 十技能齐：新增 usecase-executor / usecase-qc / usecase-orchestrator 通用副本（执行硬闸/六查/调度停机卡全保留，公司件全走占位）；01_标准 增 9 份发布视图（publish_standards.py 自动生成）；机检增强（邮箱/git 元数据/中文域词可选） |
| v2.1 | 2026-11-26 | 十技能通用副本同步到本体现行内容（11-17~11-26 新增的通用方法全部补入：计时打点、独立完备性质疑、指令语义表、质检九查、执行前预估与测完对账、测试后耗时分析者、首测页面形态探针、收尾自查断言逐条落地、白名单三段嵌套取值等；公司内部库接线继续不投影）；示例配置补 paths.Agent本体／paths.执行工具／standards.L6_缺陷模板／standards.L6_执行期参考／业务线 段 |
| v2.2 | 2026-11-26 | 十技能→十三技能：新增 usecase-defect-challenger／usecase-execution-challenger／usecase-spec-gate 通用副本（提单前质疑六查／执行判定复核包＋双账本／规格保真机检七检；调度与执行副本此前已引用这三个技能名）；示例配置补 integrations.defect_platform |
