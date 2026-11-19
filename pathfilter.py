# -*- coding: utf-8 -*-
"""路径 smudge/clean 过滤器（克隆通道·2026-11-19）：git 检出/入库双向换算根路径。
配套部署器写入的本地 .gitattributes（* filter=agentpath）与 filter.agentpath 配置——
**同事日常更新=纯 git pull**：远端新内容检出时自动把正本 D:/ZCodetest 换成本机根（smudge），
git 比较时自动换回（clean）→ 无本地改动、无 pull 冲突、无需再跑自举。
本机根=~/.testagent_deploy.json 的 root；无登记（发起机/未自举克隆）=透传不改（不产生副作用）。
字节级替换（二进制安全）；无命中=透传。正本路径一律正斜杠（2026-11-19 已全仓归一 58 处，
自举后新增路径也须正斜杠——否则过滤器不认）。
**本文件=仓根+纯ASCII文件名（勿挪勿改名）**：git 在 Windows 经命令行向过滤器传中文路径会
编码损坏（2026-11-19 e2e 实证）——过滤器配置用相对路径调用（git 起 filter 时 cwd=仓根）。
**键锚定布局映射（同日 e2e 三实证补）**：paths.执行工具/接口执行根 在克隆布局下须指
公司包/jt_exec（工作区 jt_chrome 不随仓走）。映射模式带 `"键": "值"` 引号锚——裸前缀映射
会与 路径迁移别名/直指同串 碰撞致 roundtrip 漂移（clean 逆映射会误伤 canonical 直指串），
键锚定使模式无歧义、双向精确互逆。与 migrate_paths LAYOUT_MAP 语义同源（改动两处同步）。
"""
import json
import sys
from pathlib import Path

OLD = b"D:/ZCodetest"
OLD_LOWER = b"d:/zcodetest"

# 键锚定（仅 agent-company.json 的两行；克隆布局=公司包/jt_exec 承载执行工具）。
# bytes 字面量禁中文 → 以 str 定义、装载时 encode（2026-11-19 实证 SyntaxError）。
LAYOUT = [(s.encode("utf-8"), d.encode("utf-8")) for s, d in (
    ('"执行工具": "D:/ZCodetest/jt_chrome"',
     '"执行工具": "D:/ZCodetest/agentqa_test/公司包/jt_exec"'),
    ('"接口执行根": "D:/ZCodetest/jt_chrome/pw_layered"',
     '"接口执行根": "D:/ZCodetest/agentqa_test/公司包/jt_exec/pw_layered"'),
    ('"jt_chrome": "D:/ZCodetest/jt_chrome"',
     '"jt_chrome": "D:/ZCodetest/agentqa_test/公司包/jt_exec"'),
)]


def local_root():
    try:
        reg = json.loads((Path.home() / ".testagent_deploy.json").read_text(encoding="utf-8"))
        r = str(reg.get("root", "")).replace("\\", "/").strip().rstrip("/")
        if r and r.lower() != "d:/zcodetest" and Path(r).is_dir():
            return r.encode("utf-8")
    except Exception:
        pass
    return b""


def smudge(data, root):
    for old, new in LAYOUT:                            # ① 键锚定布局映射（先于根替换）
        data = data.replace(old, new)
    data = data.replace(OLD, root).replace(OLD_LOWER, root)   # ② 根替换
    return data


def clean(data, root):
    data = data.replace(root, OLD)                     # 逆序：① 根还原
    for old, new in LAYOUT:                            # ② 布局逆映射（键锚定无歧义）
        data = data.replace(new, old)
    return data


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "smudge"
    data = sys.stdin.buffer.read()
    root = local_root()
    if root:
        data = smudge(data, root) if mode == "smudge" else clean(data, root)
    sys.stdout.buffer.write(data)


if __name__ == "__main__":
    main()
