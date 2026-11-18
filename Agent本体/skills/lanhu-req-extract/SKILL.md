---
name: lanhu-req-extract
description: 蓝湖原型→Markdown 需求文档采集（当前 agent 版，Chrome 池化任务式）。当用户说"采集蓝湖需求 / 蓝湖提取需求 / 从蓝湖生成需求文档 / 采集XX菜单 / 蓝湖需求更新了重新采 / 批量采集蓝湖"，或提供 lanhuapp.com 链接要求提取内容、生成/刷新需求文档时使用。产物落需求文档权威库，随后可接 requirement-qa-loop 答疑。
---

# 蓝湖需求提取（lanhu-req-extract）

> 权威口径：《蓝湖需求采集标准_当前agent版_v1》（{paths.标准体系}，22 条红线继承自展示包方法 v4）。
> 本技能只做编排调度；采集/校验由 {paths.蓝湖工具} 脚本执行。冲突时以标准为准。

## 一、环境与地址（前置）

- **浏览器**：不自启。经 `browser_pool` 租实例：`bash {paths.公司包}/jt_exec/pool_run.sh <脚本> [参数]`（`POOL_START=9334` 防抢 9333 交互主实例；蓝湖场景无视 login 字段——自动登录的是鲸天，蓝湖用不着）。
- **蓝湖地址（因人而异，产品发谁的链接就用谁的）**，四层解析：① 对话里用户给的链接 → 命令 `--url`；② `LANHU_URL` env；③ 本机 `{paths.蓝湖工具}/lanhu_config.json`（给过一次就写入记住，永不入 git/包）；④ 全空→问用户要，别猜。
- **访客态被拦**（"用户状态变化请重新登录"横幅≠阻断，R11：内容可见即可继续；链接落到项目总览页时脚本自动点 rp 文件进原型树）。真被账号级拦截→请用户人工登录一次蓝湖（固定单一端口实例），再续跑。

## 二、单菜单采集（默认走路线 A）

```bash
POOL_START=9334 bash {paths.公司包}/jt_exec/pool_run.sh {paths.蓝湖工具}/collect_lanhu_req.js \
  --menu "<probe 出的树内真实菜单名，一字不差>" \
  --name "财务需求{年份}_{域}_{菜单简名}_v1" \
  --outdir "<产物目录：正式=D:/ZCodetest/需求用例库/需求文档；试采=lanhu_exec/out>" \
  --url "<用户本次给的链接（可省，走本机默认）>"
```

- 先跑 `probe_menu_names.js`（同入口）dump 树内真实菜单名（半/全角问号以树为准，R2）。
- 退出码：0=闸门过；3=验收红（图片未落地/弹窗缺裁）须处置重跑；1/2=连接/参数错。
- 采完**必跑**第二道闸门：`python {paths.蓝湖工具}/lanhu_verify.py <md> <imgdir>`（MISSING/表格列数/关键词/残留，非零退出）。

## 三、路线 B（视觉还原，axure 碎片小图拼面板的菜单）

判据：菜单图是"离散大图"走 A；"碎片小图/整块面板"走 B。三步：

```bash
node {paths.蓝湖工具}/extract_lanhu_visual_v3.js <端口> --menu "<菜单名>"       # 整帧+diag
python {paths.蓝湖工具}/assemble_visual_md_v2.py --menu "<菜单名>" --outfile <目标md>  # 组装
python {paths.蓝湖工具}/convert_to_relative_png.py <目标md>                      # base64→相对PNG
```

## 四、批量采集（技能层循环，断点续传）

菜单清单来源：`lanhu_menus.json`（modules 版）或 probe dump。逐菜单走 §二；进度写 `{paths.蓝湖工具}/.batch_progress.json`（`{"菜单名": "ok|fail"}`，只增不覆盖）；**单菜单失败不中断**——记 fail 续下一个，收尾汇报 fail 清单供续跑（重跑只取非 ok 项）。

## 五、需求更新（增量刷新）

1. `lanhu_diff.py <旧缓存目录> <新缓存目录>` 比对小节签名 → REMOVED/ADDED/CHANGED；
2. 仅对 CHANGED 菜单重采（升版本号 vN+1），旧版移 `需求用例库\历史版本\`（usecase-history-cleanup 口径）；
3. diff 结果输出**变更摘要呈报用户拍板**"哪些变化要传导到用例"（feedback-loop 接口），禁自行回写用例。

## 六、入库定稿（产物 → 权威库）

落 `D:/ZCodetest/需求用例库/需求文档` 时头部按权威库 4 行元信息改写：
`# {菜单名}` / `> 采集来源：蓝湖 财务需求2026.rp / {模块} / {菜单名}` / `> 采集时间：{ISO}` / `> 状态：{一句话}`（+`> 修订：`有则加）。图片目录与 MD 同名 `_images/`。命名 `财务需求{年份}_{域}_{菜单简名}_vN.md`（域=快运/云仓/智运/财务中心；同库已有同名需求先查重，禁覆盖——历史版本归档处理）。

## 七、红线摘录（全本见标准）

R1 版本对号（点错菜单全错，点击后必回读）｜R2 问号归一｜R5 置灰标"⚠️已置灰"不作计费依据｜R6 表格必须还原 MD 表禁拍扁｜R7 每次强制重采标时间｜R8 图片型表格必须下载原图精读｜R13 禁一次性脚本当交付物｜R14 验收不一致非零退出绝不声称完成｜R22 采集忠实：产品没画的就是没有，疑点在对话里说不落文档。

## 八、收尾（每次必做）

0. **对账（第三道闸门，独立质检角色）**：`node lanhu_reconcile.js <端口> --menu "<菜单名>" --doc "<文档>"` ——
   与采集器同构导航（共用 robustClickMenu，G64 铁律）独立重访蓝湖，逐文本节点核对文档覆盖；
   **coverage=1.0 才算采集完成**（非零退出=对账红→修复重采再对账）。三道闸门序：collect GATE（结构）→ lanhu_verify（文件级）→ lanhu_reconcile（内容级×原页）；
1. release 实例（pool_run 自动）+ `browser_pool.js status` 确认无残留锁；
2. 蓝湖页签必须已关（残留页签会让实例被池判忙锁死）；
3. 台账（{paths.需求流水线台账}）登记采集事件（带时刻）；
4. 图片身份确认走 GLM-5.3-Flash（全局规则）；flash 不可用回退 WinRT OCR（`ocr_run.ps1 -Paths <ASCII路径>`，中文路径须先拷 C:\temp 类 ASCII 目录）；两者皆不可→标注"需人工确认图身份"。

## 坑（本体系实测）

- 菜单名含 `/？` 当文件名=Windows 非法字符（脚本已 sanitize，--name 仍建议规整）；
- 池实例无头态 `el.screenshot` 常卡"waiting for element to be stable"→已内置 clip 降级；
- Playwright 1.65 与展示包（1.64）API 漂移两处已修（addStyleTag remove/dispose）；同事环境装最新 1.6x 均可；
- 三候选 sid 实测等价（同项目 tid）；换产品新链接直接 --url，无需改代码。
