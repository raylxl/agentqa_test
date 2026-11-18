/**
 * 配置加载器（蓝湖地址四层解析）
 * 解析优先级：① --url 参数（本次任务，产品发谁的链接就用谁的）
 *            ② LANHU_URL 环境变量
 *            ③ 本机 lanhu_config.json（记住的默认；因人而异永不入 git/包）
 *            ④ 都没有 → 返回 null，由调用方报错并提示参照 example 模板
 * 配置文件缺失/读失败一律返回 null，不内置任何硬编码 sid。
 */

const fs = require('fs');
const path = require('path');

// 配置文件路径（本机实配；模板见 lanhu_config.example.json）
const CONFIG_PATH = path.join(__dirname, 'lanhu_config.json');
const EXAMPLE_PATH = path.join(__dirname, 'lanhu_config.example.json');

// 缓存配置
let _config = null;

function loadConfig() {
    if (_config) return _config;
    try {
        _config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch (e) {
        _config = null; // 本机未配置属正常态（等 --url / env / 提示填模板）
    }
    return _config;
}

/** 本机配置的默认地址（第③层）；未配置返回 null */
function getLanhuUrl() {
    const config = loadConfig();
    return config && config.lanhu && config.lanhu.fullUrl ? config.lanhu.fullUrl : null;
}

/** 本机配置的 sid（仅记录用）；未配置返回 null */
function getLanhuSid() {
    const url = getLanhuUrl();
    if (!url) return null;
    const m = String(url).match(/sid=([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
}

/**
 * 四层解析出本次使用的蓝湖地址（核心入口）
 * @param {string[]} argv - 命令行参数（process.argv.slice(2) 即可，支持 --url <u> 与 --url=<u>）
 * @param {Object} env - 环境变量（默认 process.env）
 * @returns {string|null} 地址；null=四层皆未提供
 */
function resolveLanhuUrl(argv = process.argv.slice(2), env = process.env) {
    const args = Array.isArray(argv) ? argv : [];
    let cliUrl = null;
    const i = args.indexOf('--url');
    if (i >= 0 && args[i + 1]) cliUrl = args[i + 1];
    if (!cliUrl) {
        const eq = args.find(a => typeof a === 'string' && a.startsWith('--url='));
        if (eq) cliUrl = eq.slice(6);
    }
    if (cliUrl && /^https?:\/\//.test(cliUrl)) return cliUrl;      // ① 本次任务参数
    if (env.LANHU_URL && /^https?:\/\//.test(env.LANHU_URL)) return env.LANHU_URL; // ② env
    const cfgUrl = getLanhuUrl();                                   // ③ 本机配置
    if (cfgUrl) return cfgUrl;
    return null;                                                    // ④ 兜底：调用方报错
}

/** 缺地址时的标准报错文案（各脚本复用，口径一致） */
function missingUrlHelp() {
    return [
        '未获得蓝湖地址（四层解析全空）：',
        '  ① 在命令加 --url "https://lanhuapp.com/link/#/invite?sid=xxx"（产品分享给你的链接）',
        '  ② 或设环境变量 LANHU_URL',
        `  ③ 或复制 ${EXAMPLE_PATH} 为 lanhu_config.json 填入你的常用链接（本机文件，不入 git/包）`
    ].join('\n');
}

/** 把给定地址写入本机 config（记住默认；"给过就记住"） */
function saveDefaultUrl(url) {
    if (!url || !/^https?:\/\//.test(url)) return false;
    const cfg = loadConfig() || {};
    cfg.lanhu = cfg.lanhu || {};
    cfg.lanhu.fullUrl = url;
    const m = String(url).match(/sid=([A-Za-z0-9_-]+)/);
    if (m) cfg.lanhu.sid = m[1];
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
    _config = null; // 清缓存
    return true;
}

function reloadConfig() {
    _config = null;
    return loadConfig();
}

module.exports = {
    loadConfig, getLanhuUrl, getLanhuSid,
    resolveLanhuUrl, missingUrlHelp, saveDefaultUrl,
    reloadConfig,
    CONFIG_PATH, EXAMPLE_PATH
};
