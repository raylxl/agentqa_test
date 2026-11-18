"""
配置加载器 - Python 版本（蓝湖地址四层解析，与 config_loader.js 同口径）
解析优先级：① --url 命令行参数 → ② LANHU_URL 环境变量 → ③ 本机 lanhu_config.json → ④ None（调用方报错）
蓝湖地址因人而异（产品分享给谁就是谁的），本模块不内置任何硬编码 sid。
"""

import json
import os
import re

# 配置文件路径（本机实配；模板见 lanhu_config.example.json）
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lanhu_config.json')
EXAMPLE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lanhu_config.example.json')

_config = None


def load_config():
    """加载本机配置；缺失/读失败返回 None（未配置属正常态）"""
    global _config
    if _config is not None:
        return _config
    try:
        with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
            _config = json.load(f)
    except Exception:
        _config = None
    return _config


def get_lanhu_url():
    """本机配置的默认地址（第③层）；未配置返回 None"""
    config = load_config()
    try:
        url = (config.get('lanhu') or {}).get('fullUrl') or ''
        return url if url.startswith(('http://', 'https://')) else None
    except Exception:
        return None


def get_lanhu_sid():
    url = get_lanhu_url()
    if not url:
        return None
    m = re.search(r'sid=([A-Za-z0-9_-]+)', url)
    return m.group(1) if m else None


def resolve_lanhu_url(argv=None, env=None):
    """四层解析出本次使用的蓝湖地址；全空返回 None"""
    import sys
    args = list(sys.argv[1:]) if argv is None else list(argv)
    e = os.environ if env is None else env
    cli = None
    if '--url' in args:
        i = args.index('--url')
        if i + 1 < len(args):
            cli = args[i + 1]
    if not cli:
        for a in args:
            if a.startswith('--url='):
                cli = a[len('--url='):]
    if cli and cli.startswith(('http://', 'https://')):
        return cli                                                    # ①
    env_url = (e.get('LANHU_URL') or '').strip()
    if env_url.startswith(('http://', 'https://')):
        return env_url                                                 # ②
    cfg = get_lanhu_url()
    if cfg:
        return cfg                                                     # ③
    return None                                                        # ④


def missing_url_help():
    return (
        '未获得蓝湖地址（四层解析全空）：\n'
        '  ① 命令加 --url "https://lanhuapp.com/link/#/invite?sid=xxx"（产品分享给你的链接）\n'
        '  ② 或设环境变量 LANHU_URL\n'
        '  ③ 或复制 %s 为 lanhu_config.json 填入你的常用链接（本机文件，不入 git/包）' % EXAMPLE_PATH
    )


def save_default_url(url):
    """把给定地址写入本机 config 记住默认；格式非法返回 False"""
    if not url or not url.startswith(('http://', 'https://')):
        return False
    cfg = load_config() or {}
    cfg.setdefault('lanhu', {})['fullUrl'] = url
    m = re.search(r'sid=([A-Za-z0-9_-]+)', url)
    if m:
        cfg['lanhu']['sid'] = m.group(1)
    with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
        f.write('\n')
    global _config
    _config = None
    return True


def reload_config():
    global _config
    _config = None
    return load_config()


if __name__ == '__main__':
    print('蓝湖地址:', resolve_lanhu_url() or missing_url_help())
