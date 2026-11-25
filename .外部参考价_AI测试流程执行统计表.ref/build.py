# 外部参考价 AI 测试流程执行统计表（8 列 × 11 流程行，纯文本无公式）
import os

try:
    import openpyxl
except ImportError:
    import subprocess, sys
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "openpyxl>=3.1.0"])
    import openpyxl

from openpyxl.styles import Font, PatternFill, Alignment, Side, Border

def xl_color(css_hex: str) -> str:
    value = css_hex.removeprefix("#").upper()
    if len(value) != 6:
        raise ValueError(f"Expected #RRGGBB, got: {css_hex}")
    return "FF" + value

XL_HEADER_BG = xl_color("#4472C4")   # 商务蓝表头
XL_TOTAL_BG  = xl_color("#2F5597")   # 合计行深蓝
XL_LIGHT     = xl_color("#D9E2F3")   # 浅底
XL_BORDER    = xl_color("#BFBFBF")
thin_side = Side(style="thin", color=XL_BORDER)
border_all = Border(left=thin_side, right=thin_side, top=thin_side, bottom=thin_side)

# ---- 数据 ----
HEADERS = ["需求", "模型", "流程", "耗时多久", "原因", "卡点是什么", "根因分析", "解决方案"]

ROWS = [
    ["外部参考价", "glm5.3", "答疑", "约 0.5 天（含等待拍板）",
     "需求源为蓝湖 Axure 原型，先提取 148KB 源码再五段式逐条提问，Q1~Q8 需用户逐条确认",
     "蓝湖 iframe 跨域 + 长文本截断，无法直接读取需求内容",
     "蓝湖原型页面嵌套 iframe 跨域限制",
     "直读 Axure 源文件绕过 iframe 全量提取；「一次一问」收敛，Q1~Q8 全部按推荐拍板落地"],
    ["外部参考价", "glm5.3", "用例生成", "约 0.5 天（3 轮迭代）",
     "初版仅 27 条，经两轮追问迭代补齐至 286 条",
     "首轮未接入公司包标准，覆盖度不足",
     "未加载公司包 L1 经典方法 / L2 报价政策族 / L5 交付标准",
     "接入 L1/L2/L5 标准，27→229→266→286（P0=99/P1=167/P2=20），总册+7 分章双形态"],
    ["外部参考价", "glm5.3", "质疑", "约 2h",
     "按要求启动独立质疑，门禁 A/B 双员执行",
     "门禁 A/B 各 1 处不达标；期间 GitHub 密码变更",
     "生成方覆盖矩阵有缺口；凭证失效",
     "独立重推导逐格比对，修复后复跑全绿，2026-11-19 11:20 签发完成证书"],
    ["外部参考价", "glm5.3", "生成交付物", "约 1h",
     "用例册 265KB + 7 分章 + PRE 数据准备 + 证书组装",
     "无",
     "—",
     "分章+总册交付，便于执行期按章取用"],
    ["外部参考价", "glm5.3", "ai测试执行-界面", "11-19 10:39~17:05 约 6.5h",
     "CDP 真机驱动 6 轮执行，含机构切换（总部↔长沙 133456）、登录过期重登",
     "弹框检测误判、下拉坐标点击被 footer 遮挡、iframe 误选录单 frame、删除按钮误认",
     "Element Plus DOM 形态特殊（必填报错是 errorRed 标红；弹框可见性须按自身宽度判定）；多层 iframe 路由并存",
     "沉淀 jt_core.js 核心库：.el-dialog 可见宽判弹框、DOM click 交互、按 referencePrice 精确定位业务 frame"],
    ["外部参考价", "glm5.3", "ai测试执行-脚本", "与界面执行交织约 4h",
     "批量用例（判重 20/导入 10/导出 8/ADD·DET 102/SYS 11/MCH 90）用脚本+接口重放提效",
     "导入报「日期解析异常」；xlsx 重建写坏；接口重放过滤条件全部失效；429 限流中断",
     "模板日期是 Excel serial+s=\"3\" 样式；边读边写同一 zip；重放时覆盖 Content-Type 致后端忽略过滤；5h 用量上限",
     "按模板样式重建文件；全量读内存再写；保留原始 charset=UTF-8 全头重放；限流后从断点续跑"],
    ["外部参考价", "glm5.3", "问题反馈", "贯穿全程约 1.5h",
     "生成期 17 项 + 执行期 16 项 + 第 6 轮增补（D1/F22~F26）实时记录",
     "判重缺陷 D1 需产品拍板",
     "系统不拦截 13 维同键重叠报价（新增/编辑/导入三通道实证）",
     "三通道证据齐备，问题单升级为待拍板项等用户决策"],
    ["外部参考价", "glm5.3", "ai复测", "约 1h（穿插执行）",
     "OPS-06 首判误报、DET 跨字段证据不足、SYS-06 刷新口径需复核",
     "toast 抓取时机空窗；基础必填红项干扰明细校验归因；reload 后 frame 未就绪",
     "toast 异步短暂出现；多必填同时标红难归因；frame 加载时序",
     "严格补测（先填全基础信息再制造明细冲突）拿到明确 toast，8/8 PASS；修正 OPS-06 为通过"],
    ["外部参考价", "glm5.3", "ai分析判断问题优先级", "约 0.5h",
     "MCH 90 条分层定级 + 全部缺陷按影响分级",
     "报价查询接口环境未暴露，28 条无法严格判定",
     "测试环境未部署需求五.1 接口（前端 bundle+网关 30 候选+Swagger 全量确认不存在）",
     "62 条给数据侧 ALT 证据（1279 条分布/前闭后闭/重量段左开右闭/区域 5×5 档），28 条标 BLOCKED，不以维护接口冒充匹配结果"],
    ["外部参考价", "glm5.3", "人工复核", "未开始（待输入）",
     "D1 拍板、报价查询接口文档、费用明细接口、三角色权限账号共 4 项依赖人工提供",
     "外部输入未就绪",
     "环境与权限资源不归 AI 控制",
     "已列输入清单，用户回复后回归 MCH 90 条与 SYS 权限复测"],
    ["外部参考价", "glm5.3", "合计", "生成侧约 1 个工作日 + 真机执行 6.5h（1 天内完成）",
     "286 条用例从需求提取到全量结论约 2 个工作日",
     "最大卡点为报价查询接口未暴露（28 条 BLOCKED）",
     "测试环境接口缺失 + 判重规则系统未实现",
     "累计 286/286 有结论：196 严格判定 / 62 数据侧 ALT / 28 环境阻塞"],
]

# ---- 建表（锚点：第1行标题、第2行表头、第3~13行数据、第15行脚注） ----
wb = openpyxl.Workbook()
ws = wb.active
ws.title = "流程执行统计"

# 标题行
ws.merge_cells("A1:H1")
ws["A1"] = "外部参考价 AI 测试流程执行统计表"
ws["A1"].font = Font(bold=True, size=14, color=xl_color("#1F3864"))
ws["A1"].alignment = Alignment(horizontal="center", vertical="center")
ws.row_dimensions[1].height = 26

# 表头行
for c, name in enumerate(HEADERS, start=1):
    cell = ws.cell(row=2, column=c, value=name)
    cell.font = Font(bold=True, color="FFFFFFFF")
    cell.fill = PatternFill("solid", fgColor=XL_HEADER_BG)
    cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    cell.border = border_all

# 数据行（含合计行强调）
n_rows = len(ROWS)
for i, row in enumerate(ROWS):
    r = 3 + i
    is_total = (i == n_rows - 1)
    for c, val in enumerate(row, start=1):
        cell = ws.cell(row=r, column=c, value=val)
        cell.border = border_all
        if is_total:
            cell.font = Font(bold=True, color="FFFFFFFF")
            cell.fill = PatternFill("solid", fgColor=XL_TOTAL_BG)
        else:
            cell.font = Font()
            if i % 2 == 1:
                cell.fill = PatternFill("solid", fgColor=XL_LIGHT)
        if c in (1, 2):  # 需求/模型 居中
            cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        elif c == 3:     # 流程 居中加粗
            cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
            if not is_total:
                cell.font = Font(bold=True)
        else:            # 长文本列左对齐换行
            cell.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)

# 脚注（隔一行，避免被一并复制进正表）
note = ws.cell(row=3 + n_rows + 1, column=1,
    value="注：生成侧（答疑→交付物）跨多会话完成，按工作日估算；真机执行侧有逐轮时间戳（11-19 10:39~17:05），6.5h 为可信数据。")
note.font = Font(size=9, italic=True, color=xl_color("#808080"))

# 列宽（长文本列宽 + 换行）
widths = {"A": 11, "B": 9, "C": 17, "D": 20, "E": 34, "F": 32, "G": 34, "H": 40}
for col, w in widths.items():
    ws.column_dimensions[col].width = w

ws.freeze_panes = "A3"

wb.properties.title = "外部参考价 AI 测试流程执行统计表"

out = "/Users/kimfang/WorkBuddy/ai测试agent/aiagentqa_test/外部参考价_AI测试流程执行统计表.xlsx"
wb.save(out)
print("SAVED:", out)
print("rows(data):", n_rows, "cols:", len(HEADERS))
