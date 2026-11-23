# -*- coding: utf-8 -*-
"""路径 smudge/clean 过滤器（克隆通道·2026-11-19）：git 检出/入库双向换算根路径。
配套部署器写入的本地 .gitattributes（* filter=agentpath）与 filter.agentpath 配置——
**同事日常更新=纯 git pull**：远端新内容检出时自动把正本 D:/ZCodetest 换成本机根（smudge），
git 比较时自动换回（clean）→ 无本地改动、无 pull 冲突、无需再跑自举。
本机根=~/.testagent_deploy.json 的 root；无登记（发起机/未自举克隆）=透传不改（不产生副作用）。
字节级替换（二进制安全）；无命中=透传。正本路径一律正斜杠（2026-11-19 已全仓归一 58 处，
部署后新增路径也须正斜杠——否则过滤器不认）。
**本文件=仓根+纯ASCII文件名（勿挪勿改名）**：git 在 Windows 经命令行向过滤器传中文路径会
编码损坏（2026-11-19 e2e 实证）——过滤器配置用相对路径调用（git 起 filter 时 cwd=仓根）。
**键锚定布局映射（同日 e2e 三实证补）**：paths.执行工具/接口执行根 在克隆布局下须指
公司包/jt_exec（工作区 jt_chrome 不随仓走）。映射模式带 `"键": "值"` 引号锚——裸前缀映射
会与 路径迁移别名/直指同串 碰撞致 roundtrip 漂移（clean 逆映射会误伤 canonical 直指串），
键锚定使模式无歧义、双向精确互逆。布局映射与 migrate_paths 共读仓根
pathfilter_layout.json（单一配置，勿在脚本内另建副本）。
"""
import json
import sys
from pathlib import Path

# 旧根拆段存 JSON，避免共享配置自身被本过滤器 smudge 改写。
_CONFIG = json.loads((Path(__file__).with_name("pathfilter_layout.json")).read_text(encoding="utf-8"))
_OLD_TEXT = "/".join(_CONFIG["old_root_parts"])
OLD = _OLD_TEXT.encode("utf-8")
OLD_LOWER = _OLD_TEXT.lower().encode("ascii")

# jt_chrome 前缀通用映射（配置键+正文引用一揽子；克隆布局=公司包/jt_exec 承载执行工具）。
# 安全性：正本全仓唯一的直指目标串 "D:/ZCodetest/agentqa_test/公司包/jt_exec" 只存在于本文件
# （自身被 .gitattributes 自豁免不过滤）→ clean 逆映射零误伤。MD转XMind/用例设计标准 两对
# 因正本含直指串（paths.标准体系）禁做通用映射——其正文在克隆中指不存在目录，无害。
# bytes 字面量禁中文 → str 定义、装载时 encode（2026-11-19 实证 SyntaxError）。
LAYOUT = [(f"{_OLD_TEXT}/{source}".encode("utf-8"),
           f"{_OLD_TEXT}/{target}".encode("utf-8"))
          for source, target in _CONFIG["layout_map"] if source == "jt_chrome"]


def local_root():
    try:
        reg = json.loads((Path.home() / ".testagent_deploy.json").read_text(encoding="utf-8"))
        r = str(reg.get("root", "")).replace("\\", "/").strip().rstrip("/")
        if r and r.lower() != _OLD_TEXT.lower() and Path(r).is_dir():
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
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        selftest()
        return
    mode = sys.argv[1] if len(sys.argv) > 1 else "smudge"
    data = sys.stdin.buffer.read()
    root = local_root()
    if root:
        data = smudge(data, root) if mode == "smudge" else clean(data, root)
    sys.stdout.buffer.write(data)


def selftest():
    root = b"E:/colleague-root"
    cases = [
        b"plain text",
        b"D:/ZCodetest/agentqa_test/README.md",
        b"D:/ZCodetest/jt_chrome/gate_scan.py",
    ]
    assert LAYOUT, "pathfilter_layout.json missing jt_chrome filter mapping"
    for original in cases:
        assert clean(smudge(original, root), root) == original, original
    expected = "E:/colleague-root/agentqa_test/公司包/jt_exec/x".encode("utf-8")
    assert smudge(b"D:/ZCodetest/jt_chrome/x", root) == expected
    print("[OK] pathfilter smudge->clean roundtrip")


if __name__ == "__main__":
    main()
