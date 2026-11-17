// lib_pt.js — 平台价格弹窗引擎（IIFE 包装防重声明，注入 window.__pt）
(()=>{
  if(window.__pt&&window.__pt.__v===19)return;
  window.__pt=null;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const ck=el=>{if(!el)return;
    if(el.tagName==='BUTTON'||(el.className&&el.className.toString().includes('el-button'))){el.click();return;}
    for(const t of ['mousedown','mouseup','click'])el.dispatchEvent(new MouseEvent(t,{bubbles:true}));};
  const setV=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};
  const dlg=()=>[...document.querySelectorAll('.el-dialog')].find(d=>d.offsetParent!==null&&d.offsetHeight>300);
  const sels=()=>dlg()?[...dlg().querySelectorAll('.el-select')].filter(s=>s.offsetParent!==null):[];
  const byPh=ph=>dlg()?[...dlg().querySelectorAll('input')].find(i=>i.offsetParent!==null&&i.placeholder===ph):null;
  window.__pt={__v:19,
    sleep,ck,setV,dlg,sels,byPh,
    text(ph,v){const i=byPh(ph);if(!i)return'no-ph';setV(i,v);return'ok';},
    async pickI(idx,kw){const s=sels()[idx];if(!s)return'no-sel'+idx;
      ck(s.querySelector('input'));await sleep(900);
      const li=[...document.querySelectorAll('.el-select-dropdown')].filter(d=>d.offsetParent!==null).flatMap(d=>[...d.querySelectorAll('li')]).find(l=>l.offsetParent!==null&&l.innerText.replace(/\s+/g,'').includes(kw.replace(/\s+/g,'')));
      if(!li){ck(document.body);return'no-li';}
      ck(li);await sleep(600);return'ok:'+kw.slice(0,10);},
    async pickDate(ph,ymd){
      const i0=byPh(ph);if(!i0)return'no-ph';
      const ed=i0.closest('[class*=el-date-editor]');
      const vis=e=>e.getBoundingClientRect().width>0||e.getBoundingClientRect().height>0;
      // 打开面板：优先点 prefix 日历 icon，失败再点 input
      let panel=null;
      for(let tr=0;tr<3&&!panel;tr++){
        const icon=ed.querySelector('[class*=prefix] .el-icon,[class*=prefix] i');
        if(icon)icon.click();else i0.click(); // v18: 原生click(合成序列致双开竞态假死)
        await sleep(1300);
        const pops=[...document.querySelectorAll('[class*=el-picker__popper],[class*=el-popper],[class*=el-date-picker]')].filter(e=>vis(e)&&e.querySelectorAll('[class*=date-table] td').length&&e.innerText.match(/\d{4}\s*年/));
        panel=pops.length?pops[pops.length-1]:null;
      }
      if(!panel)return'no-panel';
      const [Y,M,D]=ymd.split('-').map(Number);
      const seqOf=s=>{const y=s.match(/(\d{4})/),m=s.match(/(\d{1,2})\s*月/);return(y&&m)?(+y[1])*12+(+m[1]):null;};
      const hdrTxt=()=>[...panel.querySelectorAll('[class*=header-label]')].filter(vis).map(e=>e.innerText.trim()).join(' ');
      const curSeq=()=>seqOf(hdrTxt());
      const tgt=Y*12+M;let g=0;
      const btnsAll=()=>[...panel.querySelectorAll('button')].filter(vis);
      const bNext=()=>btnsAll().find(b=>/arrow-right/.test(b.className)&&!/d-arrow/.test(b.className));
      const bPrev=()=>btnsAll().find(b=>/arrow-left/.test(b.className)&&!/d-arrow/.test(b.className));
      const bDNext=()=>btnsAll().find(b=>/d-arrow-right/.test(b.className));
      const bDPrev=()=>btnsAll().find(b=>/d-arrow-left/.test(b.className));
      while(g++<80){const cs=curSeq();if(cs===null||cs===tgt)break;
        let used=null;
        if(cs<tgt){used=(cs+12<=tgt&&bDNext())?bDNext():bNext();}
        else{used=(cs-12>=tgt&&bDPrev())?bDPrev():bPrev();}
        if(!used)break;ck(used);await sleep(320);
      }
      const tds=[...panel.querySelectorAll('[class*=date-table] td')].filter(c=>vis(c)&&!c.className.includes('disabled')&&!/prev-month|next-month|other-month/.test(c.className));
      const cell=tds.find(c=>c.innerText.trim()==String(D));
      if(!cell)return'no-cell:'+hdrTxt();
      ck(cell);await sleep(600);
      return'ok:'+ymd;},
    async pickRange(startYmd,endYmd){
      const dlg0=dlg();
      const ed=[...dlg0.querySelectorAll('[class*=el-date-editor]')].find(e=>(e.getBoundingClientRect().width>0||e.getBoundingClientRect().height>0));
      if(!ed)return'no-editor';
      ck(ed);await sleep(1300);
      let panels=[];
      for(let tr=0;tr<3&&panels.length===0;tr++){
        panels=[...document.querySelectorAll('[class*=range-picker],[class*=el-picker-panel]')].filter(e=>(e.getBoundingClientRect().width>0||e.getBoundingClientRect().height>0)&&e.querySelectorAll('[class*=date-table]').length>=1);
        if(panels.length===0){const ii=ed.querySelector('input');if(ii){ck(ii);}await sleep(1200);}
      }
      const pn=panels[0]||document.body;
      const seqOf=s=>{const y=s.match(/(\d{4})/),m=s.match(/(\d{1,2})\s*月/);return(y&&m)?(+y[1])*12+(+m[1]):null;};
      const labels=()=>[...pn.querySelectorAll('[class*=header-label]')].filter(e=>(e.getBoundingClientRect().width>0||e.getBoundingClientRect().height>0)).map(e=>e.innerText.trim());
      const tables=()=>[...pn.querySelectorAll('[class*=date-table]')].filter(e=>(e.getBoundingClientRect().width>0||e.getBoundingClientRect().height>0));
      const seqs=()=>{const L=labels();return[seqOf(L[0]+' '+L[1]||''),seqOf(L[2]+' '+L[3]||'')];};
      const prev=()=>{const b=[...pn.querySelectorAll('button')].find(x=>(x.getBoundingClientRect().width>0)&&x.className.includes('prev'));if(b)ck(b);};
      const next=()=>{const b=[...pn.querySelectorAll('button')].find(x=>(x.getBoundingClientRect().width>0)&&x.className.includes('next'));if(b)ck(b);};
      const clickDay=(seq,D)=>{const S=seqs(),T=tables();for(let k=0;k<T.length;k++){if(S[k]===seq){const td=[...T[k].querySelectorAll('td')].filter(c=>(c.getBoundingClientRect().width>0)&&!c.className.includes('disabled')).find(c=>c.innerText.trim()==String(D));if(td){ck(td);return true;}}}return false;};
      const st={seq:(+startYmd.slice(0,4))*12+(+startYmd.slice(5,7)),D:+startYmd.slice(8)};
      const en={seq:(+endYmd.slice(0,4))*12+(+endYmd.slice(5,7)),D:+endYmd.slice(8)};
      let g=0;let L0=seqs()[0];
      while(g++<60&&L0!==null&&L0>st.seq){prev();await sleep(300);L0=seqs()[0];}
      while(g++<120&&L0!==null&&L0<st.seq){next();await sleep(300);L0=seqs()[0];}
      if(!clickDay(st.seq,st.D))return'no-start:'+seqs().join('/')+'want'+st.seq;
      await sleep(1000);
      g=0;let S1=seqs();
      while(g++<60&&!S1.includes(en.seq)){next();await sleep(300);S1=seqs();}
      if(!clickDay(en.seq,en.D))return'no-end:'+seqs().join('/')+'want'+en.seq;
      await sleep(800);
      const fb=[...document.querySelectorAll('[class*=picker] footer button,[class*=range] footer button')].filter(b=>(b.getBoundingClientRect().width>0)&&/确\s*定/.test(b.innerText||''));
      if(fb.length)ck(fb[fb.length-1]);
      await sleep(800);
      return'ok:'+ed.innerText.replace(/\s+/g,' ').slice(0,36);
    },
    async detail(end,price,min,max){
      const dl=dlg();const rows=[...dl.querySelectorAll('.el-table__row')].filter(r=>r.getBoundingClientRect().height>0);
      if(!rows.length)return'no-row';
      const ins=[...rows[0].querySelectorAll('input')].filter(i=>i.getBoundingClientRect().width>0&&i.type!=='checkbox');
      if(ins[0])setV(ins[0],String(end));await sleep(220);
      if(ins[1])setV(ins[1],String(price));await sleep(220);
      if(ins[2])setV(ins[2],String(min));await sleep(220);
      if(max!==null&&ins[3])setV(ins[3],String(max));await sleep(300);
      return'ok:'+ins.map(i=>i.value).join('/');},
    async queryName(kw){ // 名称模糊查询并回第1页，返回分页文本
      const vis=e=>e.getBoundingClientRect().width>0;
      const inps=[...document.querySelectorAll('input[placeholder="请输入"]')].filter(vis);
      const set2=(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
      set2(inps[0],'');set2(inps[1],kw);
      const qb=[...document.querySelectorAll('button')].find(b=>vis(b)&&/查\s*询/.test(b.innerText||''));ck(qb);await sleep(2400);
      const p1=[...(document.querySelector('.el-pagination')||{querySelectorAll:()=>[]}).querySelectorAll('.number')].find(b=>b.innerText.trim()==='1');
      if(p1&&p1.getBoundingClientRect().width>0&&+getComputedStyle(p1).opacity>=0){if(p1.className.includes('active')===false){ck(p1);await sleep(1800);}}
      return(document.querySelector('.el-pagination')||{innerText:''}).innerText.replace(/\s+/g,' ');},
    pickTblRows(){const t=[...document.querySelectorAll('.el-table__body-wrapper table')].filter(x=>x.getBoundingClientRect().height>0&&x.querySelectorAll('tbody tr').length);return t.length?[...t[t.length-1].querySelectorAll('tbody tr')].filter(r=>r.getBoundingClientRect().height>0):[];},
    async rowAction(name,btn){const rows=this.pickTblRows();
      const row=rows.find(r=>[...r.querySelectorAll('td')].some(c=>c.innerText.trim()===name));
      if(!row)return'no-row:'+name;
      const b=[...row.querySelectorAll('button,a,span')].find(x=>x.getBoundingClientRect().width>0&&x.innerText.trim()===btn);
      if(!b)return'no-btn:'+btn;
      ck(b);await sleep(1500);return'ok';},
    async delByName(name){ // 勾选指定名称行→删除→确认；返回结果
      const rows=this.pickTblRows();
      const row=rows.find(r=>[...r.querySelectorAll('td')].some(c=>c.innerText.trim()===name));
      if(!row)return'absent';
      const cb=row.querySelector('.el-checkbox');if(cb)ck(cb);await sleep(700);
      const del=[...document.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width>0&&b.innerText.trim()==='删除');ck(del);await sleep(1100);
      let cf=null;for(let w=0;w<6&&!cf;w++){cf=[...document.querySelectorAll('.el-message-box__btns button')].find(x=>x.getBoundingClientRect().width>0&&/确\s*认|确\s*定/.test(x.innerText||''));if(!cf)await sleep(500);}
      if(!cf)return'no-confirm';
      ck(cf);await sleep(2400);
      const still=this.pickTblRows().some(r=>[...r.querySelectorAll('td')].some(c=>c.innerText.trim()===name));
      return still?'still-present':'deleted';},
    netInstall(){ if(window.__ptnet)return; window.__ptnet=[];
      const of=window.fetch;
      window.fetch=function(u,o){return of.apply(this,arguments).then(async resp=>{try{const c=await resp.clone().text();window.__ptnet.push({k:'f',u:String(u).slice(0,90),s:resp.status,r:c.slice(0,160)});}catch(e){}return resp;});};
      const oo=XMLHttpRequest.prototype.open,os=XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open=function(m,u){this.__u=u;this.__m=m;return oo.apply(this,arguments);};
      XMLHttpRequest.prototype.send=function(b){this.addEventListener('load',()=>{try{window.__ptnet.push({k:'x',m:this.__m,u:String(this.__u).slice(0,90),s:this.status,r:(this.responseText||'').slice(0,200)});}catch(e){}});return os.apply(this,arguments);};},
    netGet(){return window.__ptnet||[];},
    netClear(){window.__ptnet=[];},
    async pickExact(idx,kw){ // 精确文本匹配（防 前缀包含 命中兄弟客户）
      const ss=sels();const s=ss[idx];if(!s)return'no-sel:'+idx;
      const inp=s.querySelector('input');ck(inp);await sleep(1000);
      const lis=[...document.querySelectorAll('.el-select-dropdown')].filter(d=>d.getBoundingClientRect().height>0).flatMap(d=>[...d.querySelectorAll('li')]).filter(l=>l.getBoundingClientRect().height>0);
      const norm=x=>x.replace(/\s+/g,'');
      const li=lis.find(l=>norm(l.innerText)===norm(kw))||lis.find(l=>norm(l.innerText)===norm(kw)+'十'||norm(l.innerText).startsWith(norm(kw))&&norm(l.innerText)===norm(kw));
      const li2=li||lis.find(l=>norm(l.innerText).replace(/（.*|\(.*$/,'')===norm(kw));
      if(!li2){ck(document.body);return'no-exact:'+kw;}
      ck(li2);await sleep(600);return'ok:'+kw;},
    okBtn(){const dl=dlg();if(!dl)return false;const b=[...dl.querySelectorAll('button')].find(x=>x.offsetParent&&x.innerText.trim()==='确定');if(b)ck(b);return!!b;},
    cancelBtn(){const dl=dlg();if(!dl)return false;const b=[...dl.querySelectorAll('button')].find(x=>x.offsetParent&&x.innerText.trim()==='取消');if(b)ck(b);return!!b;},
    async openAdd(){if(dlg())return true;const add=[...document.querySelectorAll('button')].find(b=>b.offsetParent&&b.innerText.trim()==='新增');ck(add);await sleep(1800);return!!dlg();},
    toasts(){return [...document.querySelectorAll('.el-message')].filter(m=>m.offsetParent!==null).map(m=>m.innerText.trim());},
    errs(){return [...document.querySelectorAll('[class*=form-item__error]')].filter(e=>e.offsetParent!==null).map(e=>e.innerText.trim());},
    selVals(){return sels().map(s=>(s.querySelector('.el-select__selected-item,.el-select__placeholder')||{innerText:''}).innerText.trim());}
  };
})();
