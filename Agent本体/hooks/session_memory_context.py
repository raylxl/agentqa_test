# -*- coding: utf-8 -*-
"""SessionStart：记忆分册提示与截断兜底（2026-11-26 立）。

事实依据（读 ZCode 客户端实现 formatMemoryIndexContent 实证）：每次会话只自动加载
<项目记忆目录>/MEMORY.md，且最多 200 行、25000 个字符，超出的尾部不加载；主题文件与分册索引都不自动加载。
SessionStart 在会话启动／恢复／清空／上下文压缩后都会触发，所以压缩把前面的提示挤掉后这里会重新提示。

动作：对 ZCODE_HOME 下每个项目的记忆目录——
  ① 总索引引用了分册索引（分册索引_*.md）→ 注入分册目录与使用提示（哪一类要去哪个文件读）；
  ② 总索引按客户端算法会被截断 → 把不会被加载的尾部原文一并注入（兜底，防规则或条目丢失）。
两者皆无→不输出。任何异常一律吞掉、exit 0、不输出：本钩子绝不干扰会话启动。
输出格式与同目录其他钩子一致：{"additionalContext": "..."}；总量控制在钩子输出上限（默认 32768 字节）以内。
阈值与折叠工具同源：tools/memory_health_check.py。路径由 ZCODE_HOME 推导，不写死。
"""
import io
import json
import os
import re
import sys
from pathlib import Path

ENTRY_RX = re.compile(r"^- \[([^\]]+)\]\(([^)]+)\) — (.*)$", re.M)
FOLD_PREFIX = "分册索引_"
LINES_RED, CHARS_RED = 200, 25000
OUT_LIMIT = 28000   # 字节；钩子输出默认上限 32768，留 JSON 转义与声明语的余量


def _u16(s):
    return len(s.encode("utf-16-le")) // 2


def _client_split(text):
    """与客户端截断逻辑一致：返回 (会被加载的部分, 不会被加载的尾部)；未超限时尾部为空串"""
    t = re.sub(r"^---\s*\n[\s\S]*?---\s*\n?", "", text).strip()
    if not t:
        return "", ""
    lines = t.split("\n")
    if len(lines) <= LINES_RED and _u16(t) <= CHARS_RED:
        return t, ""
    u = "\n".join(lines[:LINES_RED])
    if _u16(u) > CHARS_RED:
        k = u.rfind("\n", 0, CHARS_RED + 1)
        u = u[:k] if k > 0 else u[:CHARS_RED]
    return u, t[len(u):].lstrip("\n")


def project_memory_dirs():
    home = Path(os.environ.get("ZCODE_HOME") or (Path.home() / ".zcode")).expanduser()
    root = home / "cli" / "memories" / "projects"
    return sorted(root.glob("*/memory")) if root.exists() else []


def context_for(d, with_tail=True):
    """一个项目记忆目录 → 提示串；不需要提示返回空串"""
    idx = d / "MEMORY.md"
    if not idx.is_file():
        return ""
    text = io.open(idx, encoding="utf-8").read()
    parts = []
    items = []
    for m in ENTRY_RX.finditer(text):
        title, tgt, hook = m.group(1), m.group(2), m.group(3).strip()
        if not tgt.startswith(FOLD_PREFIX) or not (d / tgt).is_file():
            continue
        n = len(ENTRY_RX.findall(io.open(d / tgt, encoding="utf-8").read()))
        items.append(f"  · {hook}（{n} 条）→ {d / tgt}")
    if items:
        parts.append("总索引之外的分类索引（不随会话自动加载），用到对应类别时先读：\n" + "\n".join(items))
    loaded, tail = _client_split(text)
    if tail:
        warn = f"总索引超过客户端加载上限（{LINES_RED} 行／{CHARS_RED} 字符），后面有 {len(tail.splitlines())} 行不会被自动加载"
        if with_tail:
            parts.append(warn + "。现把这段原文补入（兜底），并须尽快跑 memory_health_check.py --fold 折叠低频的节：\n" + tail)
        else:
            parts.append(warn + "。补入内容超出钩子输出上限，**这段没有补进来**——须立即跑 memory_health_check.py --fold 折叠")
    if not parts:
        return ""
    return f"【记忆加载提示｜项目 {d.parent.name}】\n" + "\n".join(parts)


def main():
    try:
        dirs = project_memory_dirs()
        msgs = [m for m in (context_for(d) for d in dirs) if m]
        if not msgs:
            return
        out = "\n\n".join(msgs)
        if len(json.dumps({"additionalContext": out}, ensure_ascii=False).encode("utf-8")) > OUT_LIMIT:
            out = "\n\n".join(m for m in (context_for(d, with_tail=False) for d in dirs) if m)
        sys.stdout.buffer.write(json.dumps({"additionalContext": out}, ensure_ascii=False).encode("utf-8"))
    except Exception:
        pass   # 尽力而为：钩子出错绝不干扰会话启动


if __name__ == "__main__":
    main()
