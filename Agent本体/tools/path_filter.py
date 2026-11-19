# -*- coding: utf-8 -*-
"""路径 smudge/clean 过滤器（克隆通道·2026-11-19）：git 检出/入库双向换算根路径。
配套部署器写入的本地 .gitattributes（* filter=agentpath）与 filter.agentpath 配置——
**同事日常更新=纯 git pull**：远端新内容检出时自动把正本 D:/ZCodetest 换成本机根（smudge），
git 比较时自动换回（clean）→ 无本地改动、无 pull 冲突、无需再跑自举。
本机根=~/.testagent_deploy.json 的 root；无登记（发起机/未自举克隆）=透传不改（不产生副作用）。
字节级替换（二进制安全）；无命中=透传。正本路径一律正斜杠（2026-11-19 已全仓归一 58 处，
自举后新增路径也须正斜杠——否则过滤器不认）。
"""
import json
import sys
from pathlib import Path

OLD = b"D:/ZCodetest"
OLD_LOWER = b"d:/ZCodetest"


def local_root():
    try:
        reg = json.loads((Path.home() / ".testagent_deploy.json").read_text(encoding="utf-8"))
        r = str(reg.get("root", "")).replace("\\", "/").strip().rstrip("/")
        if r and r.lower() != "d:/zcodetest" and Path(r).is_dir():
            return r.encode("utf-8")
    except Exception:
        pass
    return b""


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "smudge"
    data = sys.stdin.buffer.read()
    root = local_root()
    if root:
        if mode == "smudge":
            data = data.replace(OLD, root).replace(OLD_LOWER, root)
        else:  # clean：本机根 → 正本正斜杠形态（正本已归一，双向精确互逆，roundtrip 零漂移）
            data = data.replace(root, OLD)
    sys.stdout.buffer.write(data)


if __name__ == "__main__":
    main()
