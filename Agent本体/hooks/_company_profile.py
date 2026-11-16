# -*- coding: utf-8 -*-
"""运行时公司配置发现与读取（通用 Agent 本体适配层）。

本模块只提供配置定位/读取，不保存任何公司值、账号或连接信息。
"""
import json
import os
from pathlib import Path


def _is_file(path):
    try:
        return path.is_file()
    except OSError:
        return False


def find_company_config():
    """按环境变量、当前层级及同级子目录查找 agent-company.json。"""
    env = os.environ.get("AGENT_COMPANY_JSON")
    if env:
        candidate = Path(env).expanduser()
        if _is_file(candidate):
            return candidate

    here = Path(__file__).resolve()
    bases = [here.parent, *here.parents]
    seen = set()
    for base in bases:
        if base in seen:
            continue
        seen.add(base)
        direct = base / "agent-company.json"
        if _is_file(direct):
            return direct
        try:
            children = list(base.iterdir())
        except OSError:
            children = []
        for child in children:
            if not child.is_dir():
                continue
            for candidate in (child / "agent-company.json", child / "公司包" / "agent-company.json"):
                if _is_file(candidate):
                    return candidate
    return None


def load_company_profile():
    path = find_company_config()
    if not path:
        return {}, None
    try:
        return json.loads(path.read_text(encoding="utf-8")), path
    except (OSError, ValueError):
        return {}, path


def config_path(profile, key, fallback=None):
    value = (profile.get("paths") or {}).get(key)
    if isinstance(value, str) and value:
        return Path(value)
    return Path(fallback) if fallback else None


def normalize_path(value):
    return str(value).replace("/", "\\").rstrip("\\")


def prefix_regex(value):
    """生成匹配目录前缀的正则；调用方负责传入已规范化路径。"""
    import re
    return r"^" + re.escape(normalize_path(value)) + r"\\"
