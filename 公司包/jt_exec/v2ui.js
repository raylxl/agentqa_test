// lib/v2ui.js — V2 两菜单（WarehouseBillV2/StorageBillV2）UI 操作与断言原语
// 通道：壳(/app/#) → 微应用 iframe(#/wbms/bill/...)；操作=原生setter+事件/真实点击
const path = require('path');
let chromium;
for (const p of ['playwright', path.join('d:', 'WorkBuddy-projects', 'testcase', 'node_modules', 'playwright')]) {
  try { chromium = require(p).chromium; if (chromium) break; } catch (_) {}
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MENU = {
  yz: { name: '仓链云仓-云仓账单(重构)', col: '仓链重构', shell: 'http://jt-ll.test.ztoeco.com/app/#/wbms/bill/WarehouseBillV2', kw: 'WarehouseBillV2' },
  cc: { name: '仓链云仓-存储账单(重构)', col: '仓链重构', shell: 'http://jt-ll.test.ztoeco.com/app/#/wbms/bill/StorageBillV2', kw: 'StorageBillV2' }
};

class V2UI {
  constructor(port) {
    this.port = port;
    this.browser = null;
    this.page = null;
  }
  async connect() {
    this.browser = await chromium.connectOverCDP('http://127.0.0.1:' + this.port);
    this.page = this.browser.contexts()[0].pages().find(p => p.url().includes('jt-ll.test.ztoeco.com')) || this.browser.contexts()[0].pages()[0];
    await this.page.bringToFront();
  }
  async open(menuKey) {
    const m = MENU[menuKey];
    await this.page.goto(m.shell, { waitUntil: 'domcontentloaded' });
    await sleep(3500);
    this.biz = this.page.frames().find(f => f.url().includes(m.kw) && !f.url().includes('/app/'));
    if (!this.biz) throw new Error('biz-frame-not-found:' + m.kw);
    await sleep(1200);
    return this.biz;
  }
  frame() { return this.biz; }

  // —— 查询区原语 ——
  // 定位 label 对应 el-select（祖先上溯+位置兜底；2026-11-21 R4A 增）
  async selRect(label) {
    const r = await this.biz.evaluate(`(() => {
      const els=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&e.innerText&&e.innerText.trim().startsWith('${label}')&&e.offsetParent!==null);
      const lab=els.find(e=>!e.closest('th'));
      if(!lab) return null;
      const lr=lab.getBoundingClientRect();
      let sel=null;
      let p=lab;
      for(let i=0;i<6&&p;i++){ if(p.classList&&p.classList.contains('el-select')){sel=p;break;} p=p.parentElement; }
      if(!sel){ p=lab.parentElement;
        for(let i=0;i<3&&p;i++){ const s=p.querySelector('.el-select'); if(s){sel=s;break;} p=p.parentElement; } }
      if(!sel){ let bd=1e9;
        for(const s of [...document.querySelectorAll('.el-select')]){
          if(s.offsetParent===null)continue;
          const rc=s.getBoundingClientRect();
          if(rc.y>420)continue;
          const d=Math.abs(rc.x-lr.x)+Math.abs(rc.y-lr.y)*0.5;
          if(d<bd){bd=d;sel=s;}
        }}
      if(!sel) return null;
      const rc=sel.getBoundingClientRect();
      return {x:rc.x+rc.width/2,y:rc.y+rc.height/2,sx:rc.x};
    })()`);
    if (!r) throw new Error('select-not-found:' + label);
    return r;
  }
  // 单号框（多行 textarea：placeholder=请输入单号…；多个单号换行分隔）
  async setOrderInput(_label, values) {
    const box = await this.biz.evaluate(`(() => {
      const ta = [...document.querySelectorAll('textarea')].find(t => (t.placeholder || '').includes('单号') && t.offsetParent !== null);
      if (!ta) return null;
      const r = ta.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + Math.min(15, r.height / 2), w: r.width, h: r.height };
    })()`);
    if (!box) throw new Error('order-textarea-not-found');
    await this.page.mouse.click(box.x, box.y);
    await sleep(250);
    const text = values.join('\n');
    await this.biz.evaluate(`(() => {
      const ta = [...document.querySelectorAll('textarea')].find(t => (t.placeholder || '').includes('单号') && t.offsetParent !== null);
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(400);
    // blur（主动 blur+Esc，避免误点其它控件开浮层——2026-11-21 R4A 改）
    await this.biz.evaluate(`(() => { const a=document.activeElement; if(a&&a.blur) a.blur(); })()`);
    await this.page.keyboard.press('Escape').catch(() => {});
    await sleep(250);
  }
  // 下拉选择（label→el-select，pick 文本匹配项；echo 校验+重试）
  async setSelect(label, value) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await this.selRect(label);
      await this.page.keyboard.press('Escape').catch(() => {}); await sleep(300);   // 清残留浮层防误点
      await this.page.mouse.click(r.x, r.y);
      await sleep(900);
      // 浮层在 body 下
      const opt = await this.biz.evaluate(`(() => {
        const ds=[...document.querySelectorAll('.el-select-dropdown')].filter(d=>d.offsetParent!==null||d.getBoundingClientRect().height>0);
        for(const d of ds){
          const lis=[...d.querySelectorAll('li,.el-select-dropdown__item')].filter(l=>l.offsetParent!==null);
          const hit=lis.find(l=>l.innerText.trim()==='${value}')||lis.find(l=>l.innerText.trim().includes('${value}'));
          if(hit){const rc=hit.getBoundingClientRect();return {x:rc.x+rc.width/2,y:rc.y+rc.height/2};}
        }
        return null;
      })()`);
      if (!opt) { await this.page.keyboard.press('Escape'); throw new Error('option-not-found:' + label + '=' + value); }
      await this.page.mouse.click(opt.x, opt.y);
      await sleep(600);
      const echo = await this.selEcho(label);
      if (echo && echo.includes(value)) return { echo };
      if (attempt === 2) return { echo, unstable: true };
      await sleep(400);
    }
  }
  // 日期范围（range editor 键盘法——2026-11-21 立：setter 法被 el-range-editor 月偏移吞值，键盘输入才进 v-model 请求体）
  async setDateRange(start, end) {
    const box = await this.biz.evaluate(`(() => {
      const inps=[...document.querySelectorAll('.el-date-editor input, .el-range-editor input')].filter(e=>e.offsetParent!==null);
      if(!inps.length) return null;
      const r=inps[0].getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2,count:inps.length};})()`);
    if (!box) throw new Error('date-editor-not-found');
    await this.page.mouse.click(box.x, box.y); await sleep(500);
    await this.page.keyboard.press('Control+a');
    await this.page.keyboard.type(start, { delay: 15 }); await sleep(250);
    await this.page.keyboard.press('Enter'); await sleep(700);
    if (end) {
      const box2 = await this.biz.evaluate(`(() => {
        const inps=[...document.querySelectorAll('.el-date-editor input, .el-range-editor input')].filter(e=>e.offsetParent!==null);
        const r=inps[Math.min(1,inps.length-1)].getBoundingClientRect();
        return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await this.page.mouse.click(box2.x, box2.y); await sleep(400);
      await this.page.keyboard.press('Control+a');
      await this.page.keyboard.type(end, { delay: 15 }); await sleep(250);
      await this.page.keyboard.press('Enter'); await sleep(700);
    }
  }
  // 过滤/长列表下拉（2026-11-21 R4A 增）：点开→(可过滤才)键盘输入→浮层中滚动定位目标项（支持编码）
  // value=目标选项文本或编码（如 Q20261107001）；keyword=过滤输入词（缺省=value，仅可过滤 select 生效）
  async setSelectSearch(label, value, keyword) {
    const kw = keyword || value;
    for (let attempt = 0; attempt < 3; attempt++) {
    const r = await this.selRect(label);
    await this.page.keyboard.press('Escape').catch(() => {}); await sleep(300);   // 清残留浮层防误点
    const editable = await this.biz.evaluate(`(() => {
      const els=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&e.innerText&&e.innerText.trim().startsWith('${label}')&&e.offsetParent!==null);
      const lab=els.find(e=>!e.closest('th'));
      if(!lab) return false;
      let sel=null; let p=lab;
      for(let i=0;i<6&&p;i++){ if(p.classList&&p.classList.contains('el-select')){sel=p;break;} p=p.parentElement; }
      if(!sel&&lab.parentElement){ sel=lab.parentElement.querySelector('.el-select'); }
      if(!sel) return false;
      const i=sel.querySelector('input');
      return !!(i && !i.readOnly && !i.disabled);
    })()`);
    await this.page.mouse.click(r.x, r.y);
    await sleep(1100);
    const isCode = /^[A-Za-z]{1,2}\d{6,}/.test(value);   // 编码值：过滤法不匹配（按名过滤），全列表滚动定位
    if (editable && !isCode) { await this.page.keyboard.type(kw, { delay: 30 }); await sleep(1500); }
    let opt = null;
    for (let attempt = 0; attempt < 3 && !opt; attempt++) {
      opt = await this.biz.evaluate(`(async () => {
      const sx=${r.sx};
      const want=${JSON.stringify(value)};
      const ds=[...document.querySelectorAll('.el-select-dropdown')].filter(d=>d.getBoundingClientRect().height>0);
      const cand=ds.filter(d=>Math.abs(d.getBoundingClientRect().x-sx)<=250);
      for(const d of (cand.length?cand:ds)){
        const lis=[...d.querySelectorAll('li,.el-select-dropdown__item')].filter(l=>l.offsetParent!==null);
        const norm=t=>t.replace(/\\s+/g,'');
        const hit=lis.find(l=>norm(l.innerText)===norm(want))||lis.find(l=>norm(l.innerText).includes(norm(want)));
        if(hit){hit.scrollIntoView({block:'nearest'});await new Promise(q=>setTimeout(q,350));const rc=hit.getBoundingClientRect();return {x:rc.x+rc.width/2,y:rc.y+rc.height/2,t:hit.innerText.trim().replace(/\\n/g,'/')};}
      }
      return null;
    })()`);
      if (!opt) await sleep(900);
    }
    if (!opt) { await this.page.keyboard.press('Escape'); throw new Error('option-not-found:' + label + '=' + value + '(kw=' + kw + ')'); }
    await this.page.mouse.click(opt.x, opt.y);
    await sleep(800);
    const echo = await this.selEcho(label);
    const nameTok = (opt.t.split('/')[0] || opt.t).slice(0, 6);
    if (echo && (echo.includes(nameTok) || echo.includes(value))) return { picked: opt.t, echo };
    if (attempt === 2) return { picked: opt.t, echo, unstable: true };
    await sleep(500);
    }
  }
  // 时间枚举（业务时间/出库时间）：daterange 旁窄 select（echo=业务时间|出库时间, 宽<160）
  async setTimeEnum(value) {
    const r = await this.biz.evaluate(`(() => {
      for (const s of [...document.querySelectorAll('.el-select')]) {
        if (s.offsetParent === null) continue;
        const rc = s.getBoundingClientRect();
        const t = s.innerText.trim();
        if (rc.width > 160 || rc.y > 400) continue;
        if (t === '业务时间' || t === '出库时间') return { x: rc.x + rc.width / 2, y: rc.y + rc.height / 2, echo: t };
      }
      return null;
    })()`);
    if (!r) throw new Error('time-enum-select-not-found');
    if (r.echo !== value) {
      await this.page.keyboard.press('Escape').catch(() => {}); await sleep(300);
      await this.page.mouse.click(r.x, r.y);
      await sleep(800);
      const opt = await this.biz.evaluate(`(() => {
        const ds=[...document.querySelectorAll('.el-select-dropdown')].filter(d=>d.getBoundingClientRect().height>0);
        for(const d of ds){
          const lis=[...d.querySelectorAll('li,.el-select-dropdown__item')].filter(l=>l.offsetParent!==null);
          const hit=lis.find(l=>l.innerText.trim()==='${value}');
          if(hit){const rc=hit.getBoundingClientRect();return {x:rc.x+rc.width/2,y:rc.y+rc.height/2};}
        }
        return null;
      })()`);
      if (!opt) { await this.page.keyboard.press('Escape'); throw new Error('time-enum-option-not-found:' + value); }
      await this.page.mouse.click(opt.x, opt.y);
      await sleep(600);
    }
    return { echo: value };
  }
  // 单号维度（订单号/运单号）：textarea 左侧窄 select（echo=订单号|运单号）
  async setOrderDim(value) {
    const r = await this.biz.evaluate(`(() => {
      for (const s of [...document.querySelectorAll('.el-select')]) {
        if (s.offsetParent === null) continue;
        const rc = s.getBoundingClientRect();
        const t = s.innerText.trim();
        if (rc.x > 480 || rc.width > 260 || rc.y < 100) continue;
        if (t === '订单号' || t === '运单号') return { x: rc.x + rc.width / 2, y: rc.y + rc.height / 2, echo: t };
      }
      return null;
    })()`);
    if (!r) throw new Error('dim-select-not-found');
    if (r.echo !== value) {
      await this.page.keyboard.press('Escape').catch(() => {}); await sleep(300);
      await this.page.mouse.click(r.x, r.y);
      await sleep(800);
      const opt = await this.biz.evaluate(`(() => {
        const ds=[...document.querySelectorAll('.el-select-dropdown')].filter(d=>d.getBoundingClientRect().height>0);
        for(const d of ds){
          const lis=[...d.querySelectorAll('li,.el-select-dropdown__item')].filter(l=>l.offsetParent!==null);
          const hit=lis.find(l=>l.innerText.trim()==='${value}');
          if(hit){const rc=hit.getBoundingClientRect();return {x:rc.x+rc.width/2,y:rc.y+rc.height/2};}
        }
        return null;
      })()`);
      if (!opt) { await this.page.keyboard.press('Escape'); throw new Error('dim-option-not-found:' + value); }
      await this.page.mouse.click(opt.x, opt.y);
      await sleep(600);
    }
    return { echo: value };
  }
  // 分页每页条数（.el-pagination 内 size 下拉）
  async setPageSize(n) {
    const r = await this.biz.evaluate(`(() => {
      const pag=[...document.querySelectorAll('.el-pagination')].filter(p=>p.offsetParent!==null);
      const p=pag[pag.length-1];
      if(!p) return null;
      const sel=p.querySelector('.el-select');
      if(!sel) return null;
      const rc=sel.getBoundingClientRect();
      return {x:rc.x+rc.width/2,y:rc.y+rc.height/2};
    })()`);
    if (!r) return { ok: false, why: 'pagination-not-found' };
    await this.page.mouse.click(r.x, r.y);
    await sleep(700);
    const opt = await this.biz.evaluate(`(() => {
      const ds=[...document.querySelectorAll('.el-select-dropdown')].filter(d=>d.getBoundingClientRect().height>0);
      for(const d of ds){
        const lis=[...d.querySelectorAll('li,.el-select-dropdown__item')].filter(l=>l.offsetParent!==null);
        const hit=lis.find(l=>l.innerText.trim().replace(/\\s|条\\/页/g,'')==='${n}'||l.innerText.includes('${n}'));
        if(hit){const rc=hit.getBoundingClientRect();return {x:rc.x+rc.width/2,y:rc.y+rc.height/2};}
      }
      return null;
    })()`);
    if (!opt) { await this.page.keyboard.press('Escape'); return { ok: false, why: 'size-option-not-found:' + n }; }
    await this.page.mouse.click(opt.x, opt.y);
    await sleep(1500);
    return { ok: true };
  }
  async clickQuery() {
    await this.biz.evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent!==null&&x.innerText.trim()==='查询'); if(b) b.click(); })()`);
    await sleep(2800);
  }
  async clickReset() {
    await this.biz.evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent!==null&&x.innerText.trim()==='重置'); if(b) b.click(); })()`);
    await sleep(2500);
  }
  // 读结果集（当前页行→对象数组；含总条数）
  async readResult() {
    return await this.biz.evaluate(`(() => {
      const t = document.body.innerText;
      const total = (t.match(/共\\s*(\\d+)\\s*条/) || [null, null])[1];
      // 表头列名（首个可见表格）
      const headerTable = [...document.querySelectorAll('.el-table__header')].find(h => h.offsetParent !== null);
      let cols = [];
      if (headerTable) {
        cols = [...headerTable.querySelectorAll('th')].map(th => th.innerText.trim());
      }
      const rows = [...document.querySelectorAll('.el-table__body tr')].filter(r => r.offsetParent !== null);
      const data = rows.map(r => {
        const cells = [...r.querySelectorAll('td')].map(td => td.innerText.trim());
        const o = {};
        cells.forEach((c, i) => { o['c' + i] = c; });
        return o;
      });
      return { total: total ? Number(total) : data.length, cols, rowCount: data.length, rows: data.slice(0, 120) };
    })()`);
  }
  // 行文本匹配（跨列拼接找关键词）
  async findRow(kw) {
    const r = await this.readResult();
    const hit = r.rows.filter(row => Object.values(row).some(v => String(v).includes(kw)));
    return { total: r.total, rowCount: r.rowCount, cols: r.cols, hit };
  }
  // —— PWD 弹窗链原语（2026-11-21 R4A 增）——
  // 点行内费用格：tdIndex=目标列 td 下标（与 readResult c 键同轴）；rowKw=行定位关键词（空=首行）
  // expect=点击前格文本核对（null=不核对）；返回点击前样式+弹窗态
  async clickFeeCell(tdIndex, rowKw, expect) {
    return await this.biz.evaluate(`(async () => {
      const rs=[...document.querySelectorAll('.el-table__body tr')].filter(x=>x.offsetParent!==null);
      let tr=null;
      if (${JSON.stringify(rowKw || '')}) tr=rs.find(x=>x.innerText.includes(${JSON.stringify(rowKw || '')}));
      else tr=rs[0];
      if(!tr) return {hit:false,why:'row-not-found'};
      const tds=[...tr.querySelectorAll('td')];
      const td=tds[${tdIndex}];
      if(!td) return {hit:false,why:'td-not-found:'+${tdIndex}};
      const actual=td.innerText.trim();
      td.scrollIntoView({block:'nearest',inline:'center'});
      await new Promise(q=>setTimeout(q,800));
      const btn=td.querySelector('button');
      const target=btn||td;
      const st=getComputedStyle(target);
      const pre={actual, tag:target.tagName, color:st.color, cursor:st.cursor, btn:!!btn, txt:target.innerText.trim()};
      const before=document.querySelectorAll('.el-dialog').length;
      btn?btn.click():td.click();
      await new Promise(q=>setTimeout(q,1400));
      const dlgs=[...document.querySelectorAll('.el-dialog')].filter(d=>d.getBoundingClientRect().width>0);
      return {hit:true, pre, before, dlgOpen:dlgs.length>0, dlgCount:dlgs.length};
    })()`);
  }
  // 读可见弹窗（全部按 z-index 排序；title 匹配优先，否则取最顶层）
  async readDialogs() {
    return await this.biz.evaluate(`(() => {
      const dlgs=[...document.querySelectorAll('.el-dialog')].filter(d=>d.getBoundingClientRect().width>0)
        .map(d=>{
          const title=(d.querySelector('.el-dialog__title')||{}).innerText||'';
          const heads=[...d.querySelectorAll('.el-table__header th')].map(t=>t.innerText.trim());
          const rows=[...d.querySelectorAll('.el-table__body tr')].filter(t=>t.offsetParent!==null).map(t=>[...t.querySelectorAll('td')].map(c=>c.innerText.trim()));
          let z=0; let e=d; while(e&&e!==document){const v=+getComputedStyle(e).zIndex;if(v>0){z=v;break;}e=e.parentElement;}
          return {title,heads,rows,z,text:d.innerText.slice(0,600)};
        }).sort((a,b)=>a.z-b.z);
      return {count:dlgs.length, dialogs:dlgs};
    })()`);
  }
  async readDialog(title) {
    const r = await this.readDialogs();
    if (!r.count) return { open: false, dlgCount: 0 };
    let d = title ? r.dialogs.find(x => x.title.includes(title)) : null;
    if (!d) d = r.dialogs[r.dialogs.length - 1];
    return Object.assign({ open: true, dlgCount: r.count }, d);
  }
  // 清场：关闭所有可见弹窗
  async closeAllDialogs() {
    for (let i = 0; i < 6; i++) {
      const n = await this.dialogCount();
      if (!n) return { remain: 0 };
      await this.closeTopDialog();
    }
    return { remain: await this.dialogCount() };
  }
  async dialogCount() {
    return await this.biz.evaluate(`(() => [...document.querySelectorAll('.el-dialog')].filter(d=>d.getBoundingClientRect().width>0).length)()`);
  }
  // 点顶层弹窗操作列"详情"→返回二级弹窗内容
  async clickDetailInDialog() {
    return await this.biz.evaluate(`(async () => {
      const top=()=>{const ds=[...document.querySelectorAll('.el-dialog')].filter(d=>d.getBoundingClientRect().width>0);
        let best=null,bz=-1;for(const d of ds){let z=0,e=d;while(e&&e!==document){const v=+getComputedStyle(e).zIndex;if(v>0){z=v;break;}e=e.parentElement;}if(z>bz){bz=z;best=d;}}
        return best;};
      const d=top();
      if(!d) return {ok:false,why:'no-dialog'};
      const btn=[...d.querySelectorAll('button')].find(b=>b.offsetParent!==null&&b.innerText.trim()==='详情');
      if(!btn) return {ok:false,why:'no-detail-btn'};
      btn.click();
      await new Promise(q=>setTimeout(q,1800));
      const d2=top();
      const title=(d2.querySelector('.el-dialog__title')||{}).innerText||'';
      const heads=[...d2.querySelectorAll('.el-table__header th')].map(t=>t.innerText.trim());
      const rows=[...d2.querySelectorAll('.el-table__body tr')].filter(t=>t.offsetParent!==null).map(t=>[...t.querySelectorAll('td')].map(c=>c.innerText.trim()));
      return {ok:true, title, heads, rows, text:d2.innerText.slice(0,600)};
    })()`);
  }
  // 关顶层弹窗（.el-dialog__headerbtn）→返回剩余可见弹窗数
  async closeTopDialog() {
    return await this.biz.evaluate(`(async () => {
      const ds=[...document.querySelectorAll('.el-dialog')].filter(d=>d.getBoundingClientRect().width>0);
      if(!ds.length) return {closed:false, remain:0};
      let best=null,bz=-1;for(const d of ds){let z=0,e=d;while(e&&e!==document){const v=+getComputedStyle(e).zIndex;if(v>0){z=v;break;}e=e.parentElement;}if(z>bz){bz=z;best=d;}}
      const x=best.querySelector('.el-dialog__headerbtn');
      if(x) x.click();
      await new Promise(q=>setTimeout(q,700));
      const remain=[...document.querySelectorAll('.el-dialog')].filter(v=>v.getBoundingClientRect().width>0).length;
      const mask=document.querySelector('.el-overlay,.v-modal');
      return {closed:true, remain, maskVisible:!!(mask&&getComputedStyle(mask).display!=='none'&&mask.getBoundingClientRect().height>0)};
    })()`);
  }
  // 翻下一页（.btn-next；到尾页返回 false）
  async pageNext() {
    const more = await this.biz.evaluate(`(() => {
      const pgs=[...document.querySelectorAll('.el-pagination')].filter(p=>p.offsetParent!==null);
      const p=pgs[pgs.length-1];
      if(!p) return false;
      const b=p.querySelector('.btn-next');
      if(!b||b.disabled||(b.className||'').includes('disabled')) return false;
      b.click(); return true;
    })()`);
    if (more) await sleep(1600);
    return more;
  }
  // 回第一页
  async pageFirst() {
    for (let i = 0; i < 30; i++) {
      const more = await this.biz.evaluate(`(() => {
        const pgs=[...document.querySelectorAll('.el-pagination')].filter(p=>p.offsetParent!==null);
        const p=pgs[pgs.length-1];
        if(!p) return false;
        const b=p.querySelector('.btn-prev');
        if(!b||b.disabled||(b.className||'').includes('disabled')) return false;
        b.click(); return true;
      })()`);
      if (!more) break;
      await sleep(600);
    }
    await sleep(400);
  }
  // 读 select 回显（选中标签文本）
  async selEcho(label) {
    const r = await this.selRect(label);
    return await this.biz.evaluate(`(() => {
      const els=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&e.innerText&&e.innerText.trim().startsWith('${label}')&&e.offsetParent!==null);
      const lab=els.find(e=>!e.closest('th'));
      if(!lab) return null;
      let sel=null; let p=lab;
      for(let i=0;i<6&&p;i++){ if(p.classList&&p.classList.contains('el-select')){sel=p;break;} p=p.parentElement; }
      if(!sel&&lab.parentElement){ sel=lab.parentElement.querySelector('.el-select'); }
      return sel?sel.innerText.trim().replace(/\\n/g,'/').slice(0,60):null;
    })()`);
  }
  // 整页截图（证据）
  async snap(p) { await this.page.screenshot({ path: p }); return p; }
  // 弹窗等表格中按列头取值（helper：从 readDialog rows 取第 r 行第 c 列头对应值）
  dlgCell(d, head, r = 0) {
    const i = (d.heads || []).indexOf(head);
    if (i < 0 || !(d.rows || [])[r]) return undefined;
    return d.rows[r][i];
  }
  async close() { try { await this.browser.close(); } catch (_) {} }
}

module.exports = { V2UI, MENU };
