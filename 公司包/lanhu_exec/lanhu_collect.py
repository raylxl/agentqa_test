#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
lanhu_collect.py - 蓝湖需求「精确点菜单 + 回读校验 + 整帧截图 + 元素清单」合一采集器

固化本标准方法 v1 的红线与对策：
  R1 精确匹配叶子节点 + 点击后回读激活项 + 内容帧正文确认（输出 ACTIVE_TREE / CONTENT_HEAD）
  R2 半角/全角问号归一化（配置 '？' <-> 树 '?'）
  R3 高页面改用 Python+Playwright page.screenshot 对 iframe 包围盒裁剪（不依赖 Node）
  P4 弹窗检测：_diag.json 含 imgs 列表（bounding box），供后续精确裁剪

用法（池化任务式，实例由 browser_pool 租借，端口以 env CDP_PORT 或第一参数传入）:
  CDP_PORT=9334 python lanhu_collect.py --menu "配送价格 10.?" --outdir "<产物目录>"
可选:
  --url "https://lanhuapp.com/link/#/invite?sid=xxx"   # 蓝湖地址四层解析第①层（产品发的链接）
  --sig "出库箱数"                                          # 内容帧确认关键标记（R1 第三步）
依赖: playwright, PIL；CDP 端点 http://127.0.0.1:<CDP_PORT>
"""
import sys, os, json, time, argparse
from playwright.sync_api import sync_playwright

# 地址四层解析（--url 参数 > LANHU_URL env > 本机 lanhu_config.json），与 config_loader.js 同口径
_HERE = os.path.dirname(os.path.abspath(__file__))
def _resolve_url(cli_url):
    if cli_url and cli_url.startswith(("http://", "https://")):
        return cli_url
    env = os.environ.get("LANHU_URL", "")
    if env.startswith(("http://", "https://")):
        return env
    try:
        cfg = json.load(open(os.path.join(_HERE, "lanhu_config.json"), encoding="utf-8"))
        u = (cfg.get("lanhu") or {}).get("fullUrl") or ""
        if u.startswith(("http://", "https://")):
            return u
    except Exception:
        pass
    return None

def _cdp_endpoint():
    # 端口解析序：CDP_PORT env → 命令行第一个纯数字参数（pool_run.sh 传 $PORT）→ 报错
    port = os.environ.get("CDP_PORT", "")
    if not port:
        for a in sys.argv[1:]:
            if a.isdigit():
                port = a
                break
    if not port:
        sys.exit("未指定 CDP 端口：设 CDP_PORT 或经 pool_run.sh 运行（自动传入）")
    return "http://127.0.0.1:%s" % port

def norm_q(s: str) -> str:
    """R2: 半角/全角问号归一化，用于匹配容错"""
    return (s or "").replace("？", "?").strip()

def find_menu_handle(page, name):
    """R1+R2: 优先全串相等（含版本号，避免同名系列误匹配），includes 兜底"""
    n = norm_q(name)
    return page.evaluate_handle(
        """(nm) => {
            const els = Array.from(document.querySelectorAll('.tree-item-wrapper, .tree-name'));
            const eq = els.find(e => norm((e.textContent||'').trim()) === norm(nm));
            const inc = els.find(e => (e.textContent||'').includes(nm));
            return eq || inc || null;
            function norm(s){ return (s||'').replace(/\\uFF1F/g,'?').replace(/\\uFF0E/g,'.').trim(); }
        }""", n)

def robust_click(page, name):
    """R1+R2: 强制侧栏可滚动后滚入视口真实点击（蓝湖虚拟列表，Playwright 自动滚动失效）"""
    handle = find_menu_handle(page, name)
    el = handle.as_element() if handle else None
    if el is None:
        print("MENU_NOT_FOUND", flush=True)
        return False
    for _ in range(40):
        try:
            page.evaluate("""() => { const s=document.querySelector('.prototype-sidebar');
                if(s){ s.style.setProperty('overflow-y','auto','important'); s.style.setProperty('overflow','auto','important'); } }""")
        except Exception:
            pass
        try:
            box = el.bounding_box()
        except Exception:
            box = None
        if box and 70 <= box['y'] <= 680 and box['height'] > 0:
            break
        try:
            page.evaluate("""(nm) => {
                const s=document.querySelector('.prototype-sidebar'); if(!s) return;
                const els=Array.from(document.querySelectorAll('.tree-item-wrapper, .tree-name'));
                const e=els.find(x=>norm((x.textContent||'').trim())===norm(nm))||els.find(x=>(x.textContent||'').includes(nm));
                if(!e) return; const r=e.getBoundingClientRect(); s.scrollTop += (r.top + r.height/2) - 400;
                function norm(s){ return (s||'').replace(/\\uFF1F/g,'?').replace(/\\uFF0E/g,'.').trim(); }
            }""", norm_q(name))
        except Exception:
            pass
        time.sleep(0.15)
    try:
        box = el.bounding_box()
        print("CLICK_AT", round(box['x']), round(box['y']), flush=True)
        el.click(timeout=9000)
    except Exception as e:
        print("CLICK_WARN", repr(e), flush=True)
        return False
    time.sleep(3)
    return True

def readback(page, frame, name, sig):
    """R1 第三步：回读激活菜单 + 内容帧正文确认，输出供人工核对"""
    # 激活树项（带 selected/active 类且含菜单名）
    active = page.evaluate("""(nm) => {
        const els=Array.from(document.querySelectorAll('.tree-item-wrapper, .tree-name'));
        const cand=els.filter(e=>(e.textContent||'').includes(nm));
        const act=cand.find(e=>/active|selected|current|on/.test((e.className||'')+' '+(e.parentElement?.className||'')));
        return (act||cand[0]||{}).textContent?.trim() || '';
        function norm(s){ return (s||'').replace(/\\uFF1F/g,'?').replace(/\\uFF0E/g,'.').trim(); }
    }""", norm_q(name))
    # 内容帧首屏标题 + 是否含签名标记
    head = frame.evaluate("""() => {
        const h=document.querySelector('h1,h2,h3'); const t=(document.body?document.body.innerText:'').slice(0,400);
        return {firstHeading:(h?h.innerText:'').trim().slice(0,80), sample:t};
    }""")
    print("ACTIVE_TREE", repr(active), flush=True)
    print("CONTENT_HEAD", repr(head.get('firstHeading')), flush=True)
    ok = norm_q(name) in norm_q(active) or norm_q(name) in norm_q(head.get('sample',''))
    if sig:
        ok = ok and (sig in head.get('sample',''))
        print("SIG_HIT", sig, sig in head.get('sample',''), flush=True)
    print("READBACK_OK" if ok else "READBACK_MISMATCH", flush=True)
    return ok

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--menu", required=True)
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--url", default=None)
    ap.add_argument("--sig", default="")
    a = ap.parse_args()
    share_url = _resolve_url(a.url)
    if not share_url:
        sys.exit("未获得蓝湖地址（--url / LANHU_URL / 本机 lanhu_config.json 四层全空）")

    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(_cdp_endpoint())
        pages = []
        for ctx in browser.contexts:
            for pg in ctx.pages:
                if 'lanhu' in (pg.url or '') or 'axure' in (pg.url or ''):
                    pages.append(pg)
        if not pages:
            pages = [ctx.pages[0] for ctx in browser.contexts if ctx.pages]
        page = pages[0]
        print("PAGE_URL", page.url, flush=True)

        # 当前页不是蓝湖分享页则跳转
        if 'lanhuapp.com' not in (page.url or '') and 'axure' not in (page.url or ''):
            print("NAV_TO_SHARE", flush=True)
            page.goto(share_url, wait_until="load", timeout=30000)
            time.sleep(3)

        if not robust_click(page, a.menu):
            print("ABORT_CLICK_FAILED", flush=True)
            browser.close(); sys.exit(1)

        frame = None
        for fr in page.frames:
            if 'axure-file' in (fr.url or ''):
                frame = fr; break
        if frame is None:
            print("FRAME_NOT_FOUND", flush=True); browser.close(); sys.exit(1)
        print("FRAME", frame.url, flush=True)

        # R1 回读校验
        if not readback(page, frame, a.menu, a.sig):
            print("ABORT_READBACK_MISMATCH", flush=True)
            browser.close(); sys.exit(1)

        # R3 撑高 iframe 到全文档
        dim = frame.evaluate("""() => ({docW: document.documentElement.scrollWidth, docH: document.documentElement.scrollHeight})""")
        page.evaluate("""({w,h}) => {
            let el=null;
            document.querySelectorAll('iframe').forEach(f=>{ if(!el && (f.src||'').includes('axure-file')) el=f; });
            if(!el) return;
            document.querySelectorAll('*').forEach(node=>{
                const s=getComputedStyle(node);
                const scrollable = s.overflowY==='scroll'||s.overflowY==='auto'||s.overflow==='auto'||s.overflow==='scroll';
                if(scrollable && node.scrollHeight>node.clientHeight+4){ node.style.setProperty('height',node.scrollHeight+'px','important'); node.style.setProperty('overflow','visible','important'); node.style.setProperty('max-height','none','important'); }
            });
            let pp=el,n=0; while(pp && pp.tagName!=='BODY' && pp.tagName!=='HTML' && n<12){ pp.style.setProperty('transform','none','important'); pp.style.setProperty('transform-origin','0 0','important'); pp.style.setProperty('overflow','visible','important'); pp=pp.parentElement; n++; }
            el.style.setProperty('transform','none','important');
            const dw=Math.max(document.documentElement.scrollWidth,w); const dh=Math.max(document.documentElement.scrollHeight,h);
            el.style.setProperty('width',dw+'px','important'); el.style.setProperty('height',dh+'px','important');
        }""", dim)
        time.sleep(1.5)
        frame.evaluate("""() => { document.querySelectorAll('*').forEach(el=>{ const s=getComputedStyle(el); if(s.overflowY==='scroll'||s.overflowY==='auto') el.scrollTop=0; if(s.overflowX==='scroll'||s.overflowX==='auto') el.scrollLeft=0; }); window.scrollTo(0,0); }""")
        time.sleep(0.5)

        docW, docH = dim['docW'], dim['docH']
        print("DOC", docW, docH, flush=True)

        # R3 整帧截图（Python page.screenshot 对 iframe 包围盒裁剪，高页面稳）
        os.makedirs(a.outdir, exist_ok=True)
        try:
            iframe_el = page.query_selector('iframe[src*="axure-file"]')
            ibox = iframe_el.bounding_box()
            print("IFRAME_BOX", ibox, flush=True)
            page.screenshot(path=os.path.join(a.outdir, "_frame_full.png"),
                            clip={"x":ibox["x"],"y":ibox["y"],"width":ibox["width"],"height":ibox["height"]},
                            timeout=180000, animations="disabled")
            print("SHOT_OK", flush=True)
        except Exception as e:
            print("SHOT_ERR", repr(e), flush=True); browser.close(); sys.exit(1)

        # 元素清单（含 imgs→弹窗 bbox 检测 P4；borders/leaves 供分栏还原 R6）
        inv = frame.evaluate("""() => {
            const norm = s => (s||'').replace(/\\u00a0/g,' ').trim();
            const rectOf = el => { const r=el.getBoundingClientRect(); return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}; };
            const out={imgs:[],leaves:[],borders:[],inputs:[],bigbg:[]};
            document.querySelectorAll('img').forEach(el=>{ const r=rectOf(el); if(r.w<4||r.h<4) return; out.imgs.push({...r,src:(el.currentSrc||el.src||'').slice(0,80)}); });
            document.querySelectorAll('input,select,textarea').forEach(el=>{ const r=rectOf(el); if(r.w<4||r.h<4) return; out.inputs.push({...r,tag:el.tagName.toLowerCase()}); });
            document.querySelectorAll('*').forEach(el=>{
                const tag=el.tagName; if(['SCRIPT','STYLE','NOSCRIPT','LINK','META'].includes(tag)) return;
                const r=rectOf(el); if(r.w<=0||r.h<=0) return;
                const cs=getComputedStyle(el);
                const bw=[cs.borderTopWidth,cs.borderRightWidth,cs.borderBottomWidth,cs.borderLeftWidth].map(v=>parseFloat(v)||0);
                if(bw.some(v=>v>0)&&cs.borderTopStyle!=='none'){ out.borders.push({...r,tag:tag.toLowerCase(),id:(el.id||'').slice(0,24),bw:Math.max(...bw),style:cs.borderTopStyle}); }
                const bg=cs.backgroundColor; if(bg&&bg!=='rgba(0, 0, 0, 0)'){ out.bigbg.push({...r,tag:tag.toLowerCase(),id:(el.id||'').slice(0,24),bg}); }
                if(el.childElementCount!==0) return;
                const t=norm(el.innerText||''); if(!t) return;
                const fs=parseFloat(cs.fontSize)||0; const fw=parseInt(cs.fontWeight,10)||400;
                out.leaves.push({...r,text:t.slice(0,200),fs:Math.round(fs*10)/10,fw,id:(el.id||'').slice(0,24),tag:tag.toLowerCase()});
            });
            return out;
        }""")
        with open(os.path.join(a.outdir, "_diag.json"), "w", encoding="utf-8") as f:
            json.dump({"docW":docW,"docH":docH,"menu":a.menu,**inv}, f, ensure_ascii=False)
        print("LEAVES", len(inv['leaves']), "IMGS", len(inv['imgs']), "BORDERS", len(inv['borders']), flush=True)
        browser.close()

if __name__ == "__main__":
    main()
