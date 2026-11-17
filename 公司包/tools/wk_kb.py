# -*- coding: utf-8 -*-
"""wk_kb.py — 开发知识库（weknora）公司层直连适配器（integrations.knowledge_base 落地件，2026-11-17 用户拍板"挂公司层"）

用法：
  python wk_kb.py search "<关键词>" [match_count]   → hybrid_search 检索并按文档汇总（默认公司开发库 ztocc-knowledge-docs）
  python wk_kb.py chunks <knowledge_id>             → list_chunks 取指定文档正文块
  python wk_kb.py raw <tool名> '<json参数>'          → 任意 MCP tool 原样调用（诊断用）

配置：URL/kb_id 从本文件逐级上溯定位 agent-company.json 的 integrations.knowledge_base 读取（目录改名免疫）；
      Bearer 从同级 agent-secrets.json 的 weknora.token 读（缺该节则裸调——2026-11-13 实测服务无状态可用）。
坑：禁用 Git Bash curl 直调（中文 GBK 坑，必须 Python UTF-8 发包）；返回是 SSE 取 `data: ` 行；
    大卡 chunk_index 可能超 list_chunks 首页（分页）；部分卡 parse_status=failed 但检索块仍可用。
"""
import io
import json
import os
import sys
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def _locate_config(name, start=None):
    """从脚本目录逐级上溯按文件名定位公司层配置（改名免疫，同 rewire 约定）。"""
    d = os.path.abspath(start or os.path.dirname(__file__))
    while True:
        p = os.path.join(d, name)
        if os.path.exists(p):
            return p
        nd = os.path.dirname(d)
        if nd == d:
            return None
        d = nd


def _load():
    cfg_p = _locate_config("agent-company.json")
    if not cfg_p:
        sys.exit("✗ 未定位到 agent-company.json（公司层配置缺失，知识库不可用→按技能契约记 BLOCKED）")
    cfg = json.load(io.open(cfg_p, encoding="utf-8"))
    kb = cfg.get("integrations", {}).get("knowledge_base", {})
    if not kb.get("enabled"):
        sys.exit("✗ integrations.knowledge_base.enabled=false")
    url, kb_id = kb.get("url"), kb.get("kb_id")
    token = ""
    sp = _locate_config("agent-secrets.json", os.path.dirname(cfg_p))
    if sp:
        try:
            token = (json.load(io.open(sp, encoding="utf-8")).get("weknora") or {}).get("token", "")
        except Exception:
            token = ""
    hdr = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if token:
        hdr["Authorization"] = "Bearer " + token
    return url, kb_id, hdr


def call(name, args, url=None, hdr=None, rid=1, timeout=120):
    payload = json.dumps({"jsonrpc": "2.0", "id": rid, "method": "tools/call",
                          "params": {"name": name, "arguments": args}}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers=hdr, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read().decode("utf-8")
    for line in body.splitlines():
        if line.startswith("data: "):
            d = json.loads(line[6:])
            if "error" in d:
                return {"error": json.dumps(d["error"], ensure_ascii=False)}
            return d["result"]
    return {"raw": body[:500]}


def _txt(res):
    return "".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd = sys.argv[1]
    url, kb_id, hdr = _load()
    if cmd == "search":
        query = sys.argv[2]
        n = int(sys.argv[3]) if len(sys.argv) > 3 else 12
        res = call("hybrid_search", {"kb_id": kb_id, "query": query, "match_count": n}, url, hdr)
        if "error" in res:
            print("✗", res["error"]); return
        data = json.loads(_txt(res))["data"]
        by_doc = {}
        for h in data:
            meta = h.get("metadata", {})
            by_doc.setdefault((h.get("knowledge_filename") or h.get("knowledge_title") or "?", meta.get("src_path", ""), h.get("knowledge_id", "?")), []).append(h)
        print(f"query=『{query}』 命中块={len(data)} 去重文档={len(by_doc)}（kb_id={kb_id[:8]}…）")
        for (doc, path, kid), hits in by_doc.items():
            top = max(x["score"] for x in hits)
            print(f"\n### {doc}  (score {top:.3f}, {len(hits)}块)  knowledge_id={kid}  src={path}")
            for h in hits[:3]:
                c = h["content"].strip().replace("\n", " / ")
                print(f"  - [{h['score']:.3f}] {c[:400]}")
    elif cmd == "chunks":
        kid = sys.argv[2]
        res = call("list_chunks", {"kb_id": kb_id, "knowledge_id": kid}, url, hdr)
        print(_txt(res) if _txt(res) else json.dumps(res, ensure_ascii=False)[:3000])
    elif cmd == "raw":
        res = call(sys.argv[2], json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}, url, hdr)
        print(_txt(res) if _txt(res) else json.dumps(res, ensure_ascii=False))
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
