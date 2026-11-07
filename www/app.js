(async()=>{
'use strict';
/* ================= داده‌ها ================= */
const KEY='acc_mgr_v1',CK='acc_cfg_v1';
const COLL=['cats','products','invoices','lots','outs','imgs','log','returns'];
const fix=d=>{if(!d||typeof d!=='object')d={};COLL.forEach(k=>{if(!Array.isArray(d[k]))d[k]=[]});if(!d.tomb||typeof d.tomb!=='object')d.tomb={};return d};
/* ذخیره‌سازی اصلی اطلاعات در IndexedDB (سقف بسیار بزرگ‌تر از localStorage که حدود ۵ میلیون کاراکتر بود) */
const store=(()=>{
  let p;
  const open=()=>p||(p=new Promise((res,rej)=>{
    if(!window.indexedDB)return rej(new Error('no idb'));
    const r=indexedDB.open('accdb',1);
    r.onupgradeneeded=()=>r.result.createObjectStore('d');
    r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);r.onblocked=()=>rej(new Error('blocked'));
  }));
  const tx=async(m,f)=>{const d=await open();return new Promise((res,rej)=>{const t=d.transaction('d',m);const r=f(t.objectStore('d'));t.oncomplete=()=>res(r.result);t.onerror=()=>rej(t.error);t.onabort=()=>rej(t.error)})};
  return {get:k=>tx('readonly',s=>s.get(k)),put:(k,v)=>tx('readwrite',s=>s.put(v,k))};
})();
let idbOK=true,wBusy=false,wNext=null;
async function loadDB(){
  let raw=null;
  try{raw=await store.get('db')}catch(e){idbOK=false}
  const ls=localStorage.getItem(KEY);
  /* نسخه‌ی قدیمی در localStorage: یک‌بار به IndexedDB منتقل می‌شود (یا اگر ذخیره‌ی اضطراری بوده، جایگزین می‌شود) */
  if(ls!=null&&(raw==null||localStorage.getItem('acc_ls_newer')==='1')){
    const d=JSON.parse(ls);
    if(idbOK){try{await store.put('db',ls);if(await store.get('db')===ls){localStorage.removeItem(KEY);localStorage.removeItem('acc_ls_newer')}}catch(e){}}
    return d;
  }
  if(raw==null)return null;
  try{return JSON.parse(raw)}catch(e){try{await store.put('db_broken_'+Date.now(),raw)}catch(_){}throw e}
}
/* هر ذخیره فوراً شروع می‌شود؛ اگر ذخیره‌ی قبلی هنوز تمام نشده باشد، آخرین وضعیت پشت‌سرش نوشته می‌شود */
function persist(){
  wNext=JSON.stringify(DB);
  if(wBusy)return;
  wBusy=true;
  (async()=>{
    while(wNext!==null){
      const str=wNext;wNext=null;
      let ok=false;
      if(idbOK){try{await store.put('db',str);ok=true}catch(e){}}
      if(!ok){
        try{localStorage.setItem(KEY,str);if(idbOK)localStorage.setItem('acc_ls_newer','1')}
        catch(e){toast('خطا در ذخیره‌سازی',1)}
      }
    }
    wBusy=false;
  })();
}
try{navigator.storage&&navigator.storage.persist&&navigator.storage.persist()}catch(e){}
let DB;try{DB=fix(await loadDB())}catch(e){DB=fix(null)}
let CFG={url:'',key:'',user:''};
try{CFG=Object.assign(CFG,JSON.parse(localStorage.getItem(CK)))}catch(e){}
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);
const touch=o=>{o.u=Date.now();return o};
const $=(s,r)=>(r||document).querySelector(s);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function merge(a,b){
  const r={tomb:Object.assign({},a.tomb||{},b.tomb||{})};
  for(const k of COLL){
    const m=new Map();
    for(const x of [].concat(a[k]||[],b[k]||[])){
      if(!x||!x.id||r.tomb[x.id])continue;
      const o=m.get(x.id);
      if(!o||(x.u||0)>(o.u||0))m.set(x.id,x);
    }
    r[k]=[...m.values()];
  }
  return r;
}
function migrate(){
  COLL.forEach(k=>DB[k].forEach(x=>{if(x.u==null)x.u=0}));
  DB.invoices.forEach(v=>{
    const used=new Set(v.items.map(i=>i.lotId).filter(Boolean));
    v.items.forEach(i=>{if(!i.lotId){const l=DB.lots.find(x=>x.invId===v.id&&x.pid===i.pid&&!used.has(x.id));if(l){i.lotId=l.id;used.add(l.id)}}});
  });
}
/* موجودی هر فاکتور و بهای تمام‌شده هر خروج، همیشه از روی «اول‌وارد اول‌خارج» محاسبه می‌شود */
function recompute(){
  const by={};
  DB.lots.forEach(l=>{l.rem=l.qty;(by[l.pid]=by[l.pid]||[]).push(l)});
  for(const k in by)by[k].sort((a,b)=>a.dk-b.dk||a.ts-b.ts||(a.id<b.id?-1:1));
  const returnAlloc=new Map(),events=[...DB.outs.map(x=>({type:'out',x,at:x.ts||0})),...(DB.returns||[]).flatMap(x=>[{type:'returnOut',x,at:x.ts||0},...(x.status==='restored'?[{type:'returnIn',x,at:x.actionAt||x.ts||0}]:[])])].sort((a,b)=>a.at-b.at||(a.type==='returnOut'?-1:1));
  for(const ev of events){
    const x=ev.x,L=by[x.pid]||[];
    if(ev.type==='out'){
      let need=x.q,cost=0;
      for(const l of L){if(!need)break;if(l.rem<=0)continue;const take=Math.min(l.rem,need);l.rem-=take;need-=take;cost+=take*l.buy}
      if(need){cost+=need*(L.length?L[L.length-1].buy:0);x.over=need}else delete x.over;x.cost=cost;
    }else if(ev.type==='returnOut'){
      let need=x.qty;const alloc=[];const newest=[...L].sort((a,b)=>b.dk-a.dk||b.ts-a.ts);
      for(const l of newest){if(!need)break;const take=Math.min(Math.max(0,l.rem),need);if(take){l.rem-=take;need-=take;alloc.push({lot:l,qty:take})}}
      returnAlloc.set(x.id,alloc);
    }else{
      (returnAlloc.get(x.id)||[]).forEach(a=>a.lot.rem+=a.qty);
    }
  }
}
migrate();recompute();
function del(coll,id){DB[coll]=DB[coll].filter(x=>x.id!==id);DB.tomb[id]=Date.now()}
function save(){
  recompute();
  persist();
  scheduleSync();
}

/* ================= آیکن‌ها ================= */
const IC={
 stock:'<path class="f" d="M3.5 7.8L12 3l8.5 4.8v8.4L12 21l-8.5-4.8z"/><path d="M3.5 7.8L12 3l8.5 4.8v8.4L12 21l-8.5-4.8z"/><path d="M3.5 7.8L12 12.6l8.5-4.8M12 12.6V21"/>',
 in:'<rect class="f" x="3.5" y="14" width="17" height="6.5" rx="2.5"/><path d="M3.5 16.5V18a2.5 2.5 0 0 0 2.5 2.5h12a2.5 2.5 0 0 0 2.5-2.5v-1.5"/><path d="M12 3.5v10M8.2 9.8l3.8 3.8 3.8-3.8"/>',
 out:'<rect class="f" x="3.5" y="14" width="17" height="6.5" rx="2.5"/><path d="M3.5 16.5V18a2.5 2.5 0 0 0 2.5 2.5h12a2.5 2.5 0 0 0 2.5-2.5v-1.5"/><path d="M12 13.5v-10M8.2 7.2L12 3.4l3.8 3.8"/>',
 def:'<path class="f" d="M3.5 5.2A1.7 1.7 0 0 1 5.2 3.5h6.1a1.7 1.7 0 0 1 1.2.5l7.5 7.5a1.7 1.7 0 0 1 0 2.4l-5.6 5.6a1.7 1.7 0 0 1-2.4 0L4 12.5a1.7 1.7 0 0 1-.5-1.2z"/><path d="M3.5 5.2A1.7 1.7 0 0 1 5.2 3.5h6.1a1.7 1.7 0 0 1 1.2.5l7.5 7.5a1.7 1.7 0 0 1 0 2.4l-5.6 5.6a1.7 1.7 0 0 1-2.4 0L4 12.5a1.7 1.7 0 0 1-.5-1.2z"/><circle cx="8.2" cy="8.2" r="1.3" fill="currentColor" stroke="none"/>',
 rep:'<rect class="f" x="3.5" y="11.5" width="4.2" height="9" rx="1.6"/><rect class="f" x="9.9" y="4" width="4.2" height="16.5" rx="1.6"/><rect class="f" x="16.3" y="8" width="4.2" height="12.5" rx="1.6"/><rect x="3.5" y="11.5" width="4.2" height="9" rx="1.6"/><rect x="9.9" y="4" width="4.2" height="16.5" rx="1.6"/><rect x="16.3" y="8" width="4.2" height="12.5" rx="1.6"/>',
 returns:'<path d="M4 7h10a5 5 0 0 1 0 10H8M8 17l-4-4 4-4"/><path d="M4 13v4"/>',
 back:'<path d="M4.5 12h15M13.5 6l6 6-6 6"/>',
 set:'<path d="M4 7h8M18 7h2M4 17h2M12 17h8"/><circle class="f" cx="15" cy="7" r="3"/><circle cx="15" cy="7" r="3"/><circle class="f" cx="9" cy="17" r="3"/><circle cx="9" cy="17" r="3"/>',
 scan:'<path d="M4 8.5V6a2 2 0 0 1 2-2h2.5M15.5 4H18a2 2 0 0 1 2 2v2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5M8.5 20H6a2 2 0 0 1-2-2v-2.5"/><rect class="f" x="7.5" y="8" width="9" height="8" rx="2"/><path d="M10 12h4"/>',
 copy:'<rect class="f" x="8.5" y="8.5" width="12" height="12" rx="3"/><rect x="8.5" y="8.5" width="12" height="12" rx="3"/><path d="M15.5 5.5v-.3A1.7 1.7 0 0 0 13.8 3.5H6A2.5 2.5 0 0 0 3.5 6v7.8a1.7 1.7 0 0 0 1.7 1.7h.3"/>',
 search:'<circle class="f" cx="11" cy="11" r="7"/><circle cx="11" cy="11" r="7"/><path d="M20.5 20.5l-4.5-4.5"/>',
 trash:'<path class="f" d="M6 7.5l.9 11.2A2 2 0 0 0 8.9 20.5h6.2a2 2 0 0 0 2-1.8L18 7.5z"/><path d="M4.5 7.5h15M9.5 7.5V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2.5M10 11.5v5M14 11.5v5"/>',
 edit:'<path class="f" d="M4 20l.9-4.2L16.3 4.4a2.1 2.1 0 0 1 3 0l.3.3a2.1 2.1 0 0 1 0 3L8.2 19.1z"/><path d="M4 20l.9-4.2L16.3 4.4a2.1 2.1 0 0 1 3 0l.3.3a2.1 2.1 0 0 1 0 3L8.2 19.1zM14.5 6.2l3.3 3.3"/>',
 plus:'<rect class="f" x="3.5" y="3.5" width="17" height="17" rx="6"/><rect x="3.5" y="3.5" width="17" height="17" rx="6"/><path d="M12 8v8M8 12h8"/>',
 undo:'<path d="M8.5 13.5L4 9l4.5-4.5"/><path d="M4 9h9.5a6 6 0 0 1 0 12H10"/>',
 pct:'<circle class="f" cx="7.5" cy="7.5" r="3"/><circle cx="7.5" cy="7.5" r="3"/><circle class="f" cx="16.5" cy="16.5" r="3"/><circle cx="16.5" cy="16.5" r="3"/><path d="M19 5L5 19"/>',
 img:'<rect class="f" x="3.5" y="4" width="17" height="16" rx="4"/><rect x="3.5" y="4" width="17" height="16" rx="4"/><circle cx="9" cy="9.8" r="1.7"/><path d="M20.5 15.5l-4.5-4.5L7 20"/>',
 cloud:'<path class="f" d="M7 18.5a4.3 4.3 0 0 1-.6-8.5A6 6 0 0 1 18 10a4.3 4.3 0 0 1-.5 8.5z"/><path d="M7 18.5a4.3 4.3 0 0 1-.6-8.5A6 6 0 0 1 18 10a4.3 4.3 0 0 1-.5 8.5z"/>',
 chev:'<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>',
 chevUp:'<path d="M6.5 14.5l5.5-5.5 5.5 5.5"/>',
 share:'<circle class="f" cx="6" cy="12" r="2.8"/><circle cx="6" cy="12" r="2.8"/><circle class="f" cx="17.5" cy="5.8" r="2.8"/><circle cx="17.5" cy="5.8" r="2.8"/><circle class="f" cx="17.5" cy="18.2" r="2.8"/><circle cx="17.5" cy="18.2" r="2.8"/><path d="M8.5 10.7l6.5-3.6M8.5 13.3l6.5 3.6"/>',
 log:'<rect class="f" x="5" y="3.5" width="14" height="17.5" rx="3"/><rect x="5" y="3.5" width="14" height="17.5" rx="3"/><path d="M9 9h6M9 13h6M9 17h3.5"/>',
 pdf:'<path class="f" d="M7 3.5h6.5L19 9v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5.5a2 2 0 0 1 2-2z"/><path d="M7 3.5h6.5L19 9v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5.5a2 2 0 0 1 2-2zM13.5 3.5V9H19M9 14h6M9 17h4"/>',
 gen:'<path d="M20 11.5a8 8 0 0 0-14.2-4.5M4.5 4.5v3.5H8M4 12.5a8 8 0 0 0 14.2 4.5M19.5 19.5V16H16"/>'
};
IC.xls='<rect class="f" x="4" y="3.5" width="16" height="17" rx="3"/><rect x="4" y="3.5" width="16" height="17" rx="3"/><path d="M4 9.5h16M4 14.5h16M10 3.5v17"/>';
const ico=(n,s)=>`<svg class="i" viewBox="0 0 24 24"${s?` style="width:${s}px;height:${s}px"`:''}>${IC[n]}</svg>`;

/* ================= ارقام و تاریخ شمسی ================= */
const P='۰۱۲۳۴۵۶۷۸۹',AR='٠١٢٣٤٥٦٧٨٩';
const fa=s=>String(s).replace(/\d/g,d=>P[d]);
const digits=s=>String(s==null?'':s).replace(/[۰-۹]/g,d=>P.indexOf(d)).replace(/[٠-٩]/g,d=>AR.indexOf(d));
const en=s=>digits(s).replace(/٫/g,'.').replace(/[−–]/g,'-').replace(/[,٬،\s]/g,'');
const num=v=>{const t=en(v);if(t==='')return NaN;const n=Number(t);return isFinite(n)?n:NaN};
const nf=n=>Math.round(n).toLocaleString('en-US');
const fmt=n=>fa(nf(n));
const norm=s=>digits(s).toLowerCase().replace(/ي/g,'ی').replace(/ك/g,'ک').trim();
const MN=['فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور','مهر','آبان','آذر','دی','بهمن','اسفند'];
const pad=n=>String(n).padStart(2,'0');
function g2j(gy,gm,gd){
  const gdm=[0,31,59,90,120,151,181,212,243,273,304,334];
  const gy2=gm>2?gy+1:gy;
  let days=355666+365*gy+~~((gy2+3)/4)-~~((gy2+99)/100)+~~((gy2+399)/400)+gd+gdm[gm-1];
  let jy=-1595+33*~~(days/12053);days%=12053;
  jy+=4*~~(days/1461);days%=1461;
  if(days>365){jy+=~~((days-1)/365);days=(days-1)%365}
  const jm=days<186?1+~~(days/31):7+~~((days-186)/30);
  const jd=1+(days<186?days%31:(days-186)%30);
  return [jy,jm,jd];
}
const today=()=>{const d=new Date();const [y,m,dd]=g2j(d.getFullYear(),d.getMonth()+1,d.getDate());return y*10000+m*100+dd};
const dY=k=>Math.floor(k/10000),dM=k=>Math.floor(k/100)%100,dD=k=>k%100;
const dstr=k=>fa(dY(k)+'/'+pad(dM(k))+'/'+pad(dD(k)));
const tsDay=ts=>{const d=new Date(ts||Date.now());const [y,m,dd]=g2j(d.getFullYear(),d.getMonth()+1,d.getDate());return y*10000+m*100+dd};
function parseD(s){
  const m=digits(s).trim().match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if(!m)return null;
  const y=+m[1],mo=+m[2],d=+m[3];
  if(mo<1||mo>12||d<1||d>(mo<=6?31:30))return null;
  return y*10000+mo*100+d;
}

/* ================= ابزارهای داده ================= */
const cat=id=>DB.cats.find(c=>c.id===id);
const prod=id=>DB.products.find(p=>p.id===id);
const lotsOf=pid=>DB.lots.filter(l=>l.pid===pid);
const stock=pid=>lotsOf(pid).reduce((s,l)=>s+l.rem,0);
const byNew=(a,b)=>b.dk-a.dk||b.ts-a.ts;
let PL={};try{PL=JSON.parse(localStorage.getItem('acc_pct2'))||{}}catch(e){}
const savePL=()=>localStorage.setItem('acc_pct2',JSON.stringify(PL));
const roundUp=n=>{n=Math.ceil(Number(n.toFixed(6)));const d=String(Math.abs(n)).length;if(d<3)return n;const st=Math.pow(10,d-2);return Math.ceil(n/st)*st};
const SEC={def:'تعریف',in:'ورود',stock:'موجودی',returns:'مرجوعی',out:'خروجی',rep:'گزارش'};
const logBtn=s=>`<button class="btn sm" data-a="showLog" data-s="${s}">${ico('log',20)} ثبت فعالیت‌ها</button>`;
const payTag=x=>`<span class="tag ${x.pay==='credit'?'':'cash'}">${x.pay==='credit'?'نسیه':'نقد'}</span>`;
function fdt(ts){const d=new Date(ts);const [y,m,dd]=g2j(d.getFullYear(),d.getMonth()+1,d.getDate());return fa(y+'/'+pad(m)+'/'+pad(dd)+'  '+pad(d.getHours())+':'+pad(d.getMinutes()))}
const lastCard=(key,what)=>{const r=PL[key];return r&&r.items&&r.items.length?`<div class="card"><h4>آخرین تغییر ${what}</h4><div class="m"><span>درصد</span><b>${fa(r.pct)}٪</b></div><div class="m"><span>تعداد کالا</span><b>${fa(r.items.length)}</b></div><small>${fdt(r.at)}${r.by?' — '+esc(r.by):''}</small><div class="row"><button class="btn pink" data-a="pctDel" data-k="${key}">${ico('trash',20)} حذف تغییر</button><button class="btn yellow" data-a="pctEdit" data-k="${key}">${ico('edit',20)} اصلاح درصد</button></div></div>`:''};
function setSell(p,v){if(p.sell!==v){p.sell=v;(p.sellHist=p.sellHist||[]).unshift({p:v,dk:today()});if(p.disc)delete p.disc}touch(p)}
function logAct(sec,txt){DB.log.push(touch({id:uid(),sec,txt,ts:Date.now(),by:CFG.user||'کاربر نامشخص'}))}
function findP(q){
  const s=norm(q);if(!s)return [];
  return DB.products.filter(p=>norm(p.name).includes(s)||norm(p.code).includes(s)||(p.barcode&&norm(p.barcode).includes(s)));
}
function nextCode(){
  const n=DB.products.map(p=>+p.code).filter(x=>Number.isInteger(x)&&x>0);
  return String(n.length?Math.max(...n)+1:1001);
}
function allYears(){
  const s=new Set([dY(today())]);
  DB.lots.forEach(l=>s.add(dY(l.dk)));DB.outs.forEach(o=>s.add(dY(o.dk)));
  return [...s].sort((a,b)=>b-a);
}
function agg(lo,hi){
  let i=0,o=0,c=0,ni=0,no=0;
  for(const l of DB.lots)if(l.dk>=lo&&l.dk<=hi){i+=l.qty*l.buy;ni+=l.qty}
  for(const x of DB.outs)if(x.dk>=lo&&x.dk<=hi){o+=x.q*x.unit;c+=x.cost;no+=x.q}
  return {i,o,p:o-c,ni,no};
}
const outCode=o=>o.code||((prod(o.pid)||{}).code)||'';

/* ---------- درصد سود و تخفیف ---------- */
const fp=x=>fa(String(Math.round(Math.abs(x)*10)/10).replace('.','٫'));
const pTxt=v=>(v>0?'+':v<0?'−':'')+fp(v)+'٪';
const lastBuy=pid=>{const L=lotsOf(pid).sort(byNew);return L.length?L[0].buy:null};
const markup=p=>{const b=lastBuy(p.id);return p.sell!=null&&b?(p.sell-b)/b*100:null};
const pinfo=p=>{const m=markup(p);return (m!=null?' | سود '+pTxt(m):'')+(p.disc?` <span class="tag off">تخفیف ${fa(p.disc.pct)}٪</span>`:'')};
const discRound=n=>n<1000?Math.ceil(n):Math.ceil(Number(n.toFixed(6))/100)*100;
const remainTxt=ms=>{if(ms<=0)return 'پایان یافته';const m=Math.ceil(ms/60000);if(m<60)return fa(m)+' دقیقه';const h=Math.floor(m/60);if(h<48)return fa(h)+' ساعت'+(m%60?' و '+fa(m%60)+' دقیقه':'');const d=Math.floor(h/24);return fa(d)+' روز'+(h%24?' و '+fa(h%24)+' ساعت':'')};
/* برگرداندن قیمت به حالت قبل از تخفیف (اگر قیمت در این فاصله دستی عوض شده باشد، دست نمی‌خورد) */
function undisc(p){const d=p.disc;if(!d)return false;if(p.sell===d.price)setSell(p,d.orig);delete p.disc;touch(p);return true}
function expireDiscs(){
  const now=Date.now();let n=0;
  DB.products.forEach(p=>{if(p.disc&&p.disc.end<=now&&undisc(p))n++});
  if(n){logAct('stock',`پایان مدت تخفیف: قیمت فروش ${fa(n)} کالا به حالت قبل برگشت`);save()}
  return n;
}
function discGroups(filter){
  const m=new Map();
  DB.products.forEach(p=>{const d=p.disc;if(!d||(filter&&!filter(d)))return;let g=m.get(d.gid);if(!g){g={gid:d.gid,key:d.key,pct:d.pct,end:d.end,by:d.by,ids:[]};m.set(d.gid,g)}g.ids.push(p.id)});
  return [...m.values()].sort((a,b)=>a.end-b.end);
}
const discCard=g=>`<div class="card"><h4>تخفیف فعال — ${esc(scopeLabel(g.key))}</h4><div class="m"><span>درصد تخفیف</span><b>${fa(g.pct)}٪</b></div><div class="m"><span>تعداد کالا</span><b>${fa(g.ids.length)}</b></div><div class="m"><span>زمان باقی‌مانده</span><b>${remainTxt(g.end-Date.now())}</b></div><small>تا ${fdt(g.end)}${g.by?' — '+esc(g.by):''}</small><div class="row"><button class="btn pink" data-a="discDel" data-g="${g.gid}">${ico('trash',20)} حذف تخفیف</button><button class="btn yellow" data-a="discEdit" data-g="${g.gid}">${ico('edit',20)} اصلاح تخفیف</button></div></div>`;
function priceInfo(p,L,sells){
  if(p.sell==null)return '';
  let h='';const d=p.disc;
  if(d)h+=`<div class="m"><span>تخفیف فعال</span><b>${fa(d.pct)}٪</b></div><div class="m"><span>قیمت قبل از تخفیف</span><b>${fmt(d.orig)}</b></div><small>تا ${fdt(d.end)} — ${remainTxt(d.end-Date.now())} مانده</small><button class="btn sm pink" data-a="discOne" data-id="${p.id}" style="margin:6px 0">${ico('trash',18)} حذف تخفیف</button>`;
  const b=L.length?L[0].buy:null;
  if(b){const c=p.sell<b?'rd':'gr';h+=`<div class="m"><span>سود نسبت به قیمت خرید</span><b class="${c}">${pTxt((p.sell-b)/b*100)}</b></div>`+(p.sell?`<div class="m"><span>سود نسبت به قیمت فروش</span><b class="${c}">${pTxt((p.sell-b)/p.sell*100)}</b></div>`:'')}
  const pv=sells&&sells.length>1?sells[1].p:null;
  if(pv)h+=`<div class="m"><span>تغییر نسبت به قیمت قبلی (${fmt(pv)})</span><b>${pTxt((p.sell-pv)/pv*100)}</b></div>`;
  return h;
}


/* ================= پیام، پنجره، اسکن ================= */
let tt;
function toast(m,err){const t=$('#toast');t.textContent=m;t.className='show'+(err?' err':'');clearTimeout(tt);tt=setTimeout(()=>t.className='',2400)}
const MD=$('#modal');
function modal(html){
  const o=document.createElement('div');o.className='ov';
  const b=document.createElement('div');b.className='box';b.innerHTML=html;
  o.appendChild(b);MD.appendChild(o);
  o.addEventListener('click',e=>{if(e.target===o)o.remove()});
  return b;
}
const closeModal=b=>{const o=b?b.parentElement:MD.lastElementChild;if(o)o.remove()};
const ask=msg=>new Promise(res=>{
  const b=modal(`<p class="q">${msg}</p><div class="row"><button class="btn pink" data-r="0">خیر</button><button class="btn cyan" data-r="1">بلی</button></div>`);
  b._cancel=()=>res(false);
  b.addEventListener('click',e=>{const t=e.target.closest('[data-r]');if(t){closeModal(b);res(t.dataset.r==='1')}});
  b.parentElement.addEventListener('click',e=>{if(e.target===b.parentElement)res(false)});
});
function copyText(t){
  const fb=()=>{const x=document.createElement('textarea');x.value=t;document.body.appendChild(x);x.select();try{document.execCommand('copy');toast('کپی شد')}catch(e){toast('کپی ممکن نشد',1)}x.remove()};
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(t).then(()=>toast('کپی شد'),fb);else fb();
}
let stopScanFn=null;
async function scan(cb){
  const C=window.Capacitor&&window.Capacitor.Plugins;
  if(C&&C.BarcodeScanner)return nativeScan(C.BarcodeScanner,cb);
  return webScan(cb);
}
async function nativeScan(BS,cb){
  try{const pm=await BS.requestPermissions();if(pm.camera!=='granted'&&pm.camera!=='limited'){toast('اجازه دوربین داده نشده است',1);return}}catch(e){}
  document.documentElement.classList.add('scanning');
  const ov=document.createElement('div');ov.id='scanov';
  ov.innerHTML='<div class="frame"></div><p>بارکد را داخل کادر بگیرید</p><button class="btn pink" id="scc">بستن</button>';
  document.body.appendChild(ov);
  let done=false;
  const stop=async()=>{stopScanFn=null;try{await BS.removeAllListeners()}catch(e){}try{await BS.stopScan()}catch(e){}document.documentElement.classList.remove('scanning');ov.remove()};
  stopScanFn=stop;$('#scc',ov).onclick=stop;
  try{
    await BS.addListener('barcodesScanned',async ev=>{
      if(done)return;const b=ev.barcodes&&ev.barcodes[0];if(!b)return;
      done=true;await stop();cb(String(b.rawValue||b.displayValue||''));
    });
    await BS.startScan({lensFacing:'BACK'});
  }catch(e){await stop();toast('بارکدخوان باز نشد',1)}
}
async function webScan(cb){
  if(typeof Html5Qrcode==='undefined'){toast('بارکدخوان در دسترس نیست',1);return}
  const b=modal('<h3>اسکن بارکد</h3><div id="reader"></div><button class="btn pink wide" id="scx">بستن</button>');
  const h=new Html5Qrcode('reader');let done=false;
  const stop=async()=>{try{await h.stop();h.clear()}catch(e){}};
  b._cancel=stop;
  $('#scx',b).onclick=async()=>{await stop();closeModal(b)};
  try{
    await h.start({facingMode:'environment'},{fps:10,qrbox:{width:280,height:160}},async txt=>{
      if(done)return;done=true;await stop();closeModal(b);cb(txt);
    },()=>{});
  }catch(e){closeModal(b);toast('دسترسی به دوربین ممکن نشد',1)}
}

/* ================= عکس فاکتور (IndexedDB) ================= */
const idb=(()=>{
  let p;
  const open=()=>p||(p=new Promise((res,rej)=>{const r=indexedDB.open('accimg',1);r.onupgradeneeded=()=>r.result.createObjectStore('i');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)}));
  const tx=async(m,f)=>{const d=await open();return new Promise((res,rej)=>{const t=d.transaction('i',m);const r=f(t.objectStore('i'));t.oncomplete=()=>res(r.result);t.onerror=()=>rej(t.error)})};
  return {get:k=>tx('readonly',s=>s.get(k)),put:(k,v)=>tx('readwrite',s=>s.put(v,k)),del:k=>tx('readwrite',s=>s.delete(k)),keys:()=>tx('readonly',s=>s.getAllKeys())};
})();
function shrink(file){
  return new Promise((res,rej)=>{
    const fr=new FileReader();
    fr.onload=()=>{const im=new Image();im.onload=()=>{
      const s=Math.min(1,1600/Math.max(im.width,im.height));
      const c=document.createElement('canvas');c.width=Math.round(im.width*s);c.height=Math.round(im.height*s);
      c.getContext('2d').drawImage(im,0,0,c.width,c.height);res(c.toDataURL('image/jpeg',.75));
    };im.onerror=rej;im.src=fr.result};
    fr.onerror=rej;fr.readAsDataURL(file);
  });
}
async function addPhotos(files,inv){
  let n=0;
  for(const f of files){
    try{const data=await shrink(f);const id=uid();await idb.put(id,data);DB.imgs.push(touch({id,inv,ts:Date.now()}));n++}catch(e){}
  }
  if(n){logAct('rep',`افزودن ${fa(n)} عکس فاکتور`);save();toast(fa(n)+' عکس اضافه شد')}else toast('عکس خوانده نشد',1);
}
function fillThumbs(root){
  root.querySelectorAll('img[data-img]').forEach(im=>{idb.get(im.dataset.img).then(d=>{if(d)im.src=d}).catch(()=>{})});
}

/* ================= همگام‌سازی با سرور ================= */
let syncing=false,pending=false,tmr;
const setSt=s=>{const d=$('#sd');if(d)d.className='sd '+s};
const normUrl=u=>{u=u.trim().replace(/\/+$/,'');return u&&!/^https?:\/\//i.test(u)?'http://'+u:u};
async function api(method,path,body){
  const f=fetch(CFG.url+path,{method,headers:{'Content-Type':'application/json','x-key':CFG.key},body:body?JSON.stringify(body):undefined})
    .then(r=>{if(r.status===401)throw new Error('کلید دسترسی اشتباه است');if(!r.ok)throw new Error('خطای سرور '+r.status);return r.json()});
  const to=new Promise((_,rej)=>setTimeout(()=>rej(new Error('پاسخی از سرور نیامد')),25000));
  return Promise.race([f,to]);
}
function scheduleSync(){if(!CFG.url)return;clearTimeout(tmr);tmr=setTimeout(()=>syncNow(),1200)}
async function syncImgs(){
  const have=new Set(await idb.keys());
  const srv=new Set((await api('GET','/api/imgs')).ids);
  const meta=new Set(DB.imgs.map(m=>m.id));
  for(const k of have)if(!meta.has(k))await idb.del(k);
  for(const m of DB.imgs){
    if(!have.has(m.id)&&srv.has(m.id)){const r=await api('GET','/api/img/'+m.id);if(r&&r.data)await idb.put(m.id,r.data)}
    else if(have.has(m.id)&&!srv.has(m.id)){await api('PUT','/api/img/'+m.id,{data:await idb.get(m.id)})}
  }
}
async function syncNow(manual){
  if(!CFG.url)return;
  if(syncing){pending=true;return}
  syncing=true;setSt('busy');
  try{
    const r=await api('POST','/api/sync',{db:DB,user:CFG.user});
    const before=JSON.stringify(DB);
    DB=fix(merge(DB,r.db));migrate();recompute();
    const changed=JSON.stringify(DB)!==before;
    const exp=expireDiscs();
    persist();
    await syncImgs();
    setSt('ok');
    if(changed||exp)softRender();
    if(manual)toast('همگام‌سازی انجام شد');
  }catch(e){setSt('err');if(manual)toast('خطا: '+e.message,1)}
  syncing=false;
  if(pending){pending=false;scheduleSync()}
}
function softRender(){
  const a=document.activeElement;
  if(MD.children.length||(a&&/INPUT|SELECT|TEXTAREA/.test(a.tagName)))return;
  render(true);
}
setInterval(()=>{if(document.visibilityState==='visible')syncNow()},25000);
setInterval(()=>{if(expireDiscs())softRender()},30000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&expireDiscs())softRender()});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')syncNow()});

/* ================= نماها ================= */
const S={catsOpen:false,iq:'',pq:'',q:'',rt:'all',ry:null,rm:null,rf:null,rto:null,draft:null,editPid:null,defCat:null};
const route=()=>location.hash.replace(/^#\/?/,'').split('/').filter(Boolean);
const empty=t=>`<p class="empty">${t}</p>`;

function prow(p){
  return `<div class="item" data-a="open" data-id="${p.id}"><div class="grow"><b>${esc(p.name)}</b><small>کد: ${esc(fa(p.code))}${cat(p.cat)?' | '+esc(cat(p.cat).name):''}</small></div><div class="st">${fa(stock(p.id))} عدد</div></div>`;
}
function stockBody(q){
  if(q.trim()){const l=findP(q);return l.length?l.map(prow).join(''):empty('کالایی پیدا نشد')}
  if(!DB.cats.length)return empty('ابتدا از بخش «تعریف» دسته‌بندی بسازید');
  return `<div class="grid">${DB.cats.map((c,i)=>{
    const ps=DB.products.filter(p=>p.cat===c.id);
    const tot=ps.reduce((s,p)=>s+stock(p.id),0);
    return `<div class="sq c${i%4}" data-a="openCat" data-id="${c.id}"><b>${esc(c.name)}</b><small>${fa(ps.length)} کالا</small><small>${fa(tot)} موجودی</small></div>`;
  }).join('')}</div>`;
}
const vStock=()=>`<div class="rowend">${logBtn('stock')}</div><div class="sbar"><input id="sq" placeholder="جستجو: نام کالا یا کد کالا" value="${esc(S.q)}"><button class="ic" data-a="scanSearch">${ico('scan')}</button></div>
<button class="btn wide yellow" data-a="goPrice">${ico('pct')} تغییر قیمت فروش</button>
<button class="btn wide pink" data-a="go" data-h="#/disc">${ico('pct')} تخفیف قیمت فروش</button>
<div id="sres" style="margin-top:12px">${stockBody(S.q)}</div>`;

function vCat(id){
  const c=cat(id);if(!c)return empty('دسته‌بندی پیدا نشد');
  const ps=DB.products.filter(p=>p.cat===id);
  if(!ps.length)return empty('در این دسته‌بندی کالایی تعریف نشده');
  return ps.map(p=>`<div class="item" data-a="open" data-id="${p.id}"><div class="grow"><b>${esc(p.name)}</b><small>کد: ${esc(fa(p.code))} | فروش: ${p.sell!=null?fmt(p.sell):'—'}${pinfo(p)}</small></div><div class="st">${fa(stock(p.id))} عدد</div></div>`).join('');
}
function vPrice(r){
  const sub=r[1],cid=r[2];
  if(!sub)return `<button class="btn wide cyan" data-a="go" data-h="#/price/cats">${ico('stock',20)} تغییر قیمت دسته‌بندی‌ها</button><button class="btn wide yellow" data-a="go" data-h="#/price/items">${ico('pct',20)} تغییر قیمت کالای انتخابی</button>
  <p class="empty">قیمت‌های جدید همیشه به سمت بالا رند می‌شوند؛ مثلاً ۵۸٬۵۵۰ می‌شود ۵۹٬۰۰۰ و ۷۲۹٬۰۰۰ می‌شود ۷۳۰٬۰۰۰.</p>`;
  if(!DB.cats.length)return empty('دسته‌بندی وجود ندارد');
  if(sub==='cats')return DB.cats.map(c=>{const l=PL['cat:'+c.id];return `<div class="item" data-a="catPct" data-id="${c.id}"><div class="grow"><b>${esc(c.name)}</b><small>${fa(DB.products.filter(p=>p.cat===c.id).length)} کالا${l?' | آخرین تغییر: '+fa(l.pct)+'٪':''}</small></div>${ico('pct',22)}</div>`}).join('');
  if(sub==='items'&&!cid)return DB.cats.map(c=>{const l=PL['sel:'+c.id];return `<div class="item" data-a="go" data-h="#/price/items/${c.id}"><div class="grow"><b>${esc(c.name)}</b><small>${fa(DB.products.filter(p=>p.cat===c.id).length)} کالا${l?' | آخرین تغییر: '+fa(l.pct)+'٪':''}</small></div></div>`}).join('');
  const c=cat(cid);if(!c)return empty('دسته‌بندی پیدا نشد');
  const ps=DB.products.filter(p=>p.cat===cid);
  return lastCard('sel:'+cid,'کالاهای انتخابی این دسته')+(ps.length?`<div class="row"><button class="btn pink" data-a="selAll">انتخاب همه</button><button class="btn yellow" data-a="pctSel" data-c="${cid}">${ico('pct',20)} تغییر قیمت انتخابی‌ها</button></div>`+
  ps.map(p=>`<div class="item"><input type="checkbox" class="ck" value="${p.id}"><div class="grow"><b>${esc(p.name)}</b><small>کد: ${esc(fa(p.code))} | فروش: ${p.sell!=null?fmt(p.sell):'—'}${pinfo(p)}</small></div></div>`).join(''):empty('در این دسته‌بندی کالایی نیست'));
}

function vProd(id){
  const p=prod(id);if(!p)return empty('کالا پیدا نشد');
  const L=lotsOf(id).sort(byNew);
  const dates=[...new Set(L.map(l=>l.dk))];
  const sells=p.sellHist||[];
  const more=(arr,f)=>arr.length>1?`<details><summary>بیشتر</summary><div>${arr.slice(1).map(f).join('')}</div></details>`:'';
  const box=(t,main,extra)=>`<div class="card"><h4>${t}</h4><div class="val">${main}</div>${extra||''}</div>`;
  const lotRow=l=>`<div class="${l.rem?'':'lot z'}"><b>فاکتور ${esc(fa(l.inv))}</b> <small style="display:inline">${dstr(l.dk)}</small><small>ورودی ${fa(l.qty)} عدد | باقی‌مانده ${fa(l.rem)} عدد${l.rem?'':' (تمام شده)'}</small><small>قیمت خرید: ${fmt(l.buy)} تومان</small></div>`;
  return `<div class="card"><div class="item" style="border:0;box-shadow:none;padding:0;margin:0;background:none"><div class="grow"><b style="font-size:19px">${esc(p.name)}</b><small>کد: ${esc(fa(p.code))}${p.barcode?' | بارکد: '+esc(fa(p.barcode)):''}</small></div>
  <button class="ic sm" data-a="copy" data-t="${esc(p.name)}">${ico('copy')}</button><button class="ic sm" data-a="google" data-t="${esc(p.name)}">${ico('search')}</button></div></div>`+
  box('تاریخ ورود',dates.length?dstr(dates[0]):'—',more(dates,d=>`<div>${dstr(d)}</div>`))+
  box('تعداد موجودی',fa(stock(id))+' عدد')+
  `<div class="card"><h4>قیمت خرید (به تفکیک فاکتور)</h4>${L.length?lotRow(L[0]):'—'}${more(L,lotRow)}</div>`+
  box('قیمت فروش',p.sell!=null?fmt(p.sell)+' تومان':'—',priceInfo(p,L,sells)+`<small class="price-date">تاریخ آخرین تغییر: ${sells.length?dstr(sells[0].dk):p.u?dstr(tsDay(p.u)):'—'}</small>`+more(sells,s=>`<div>${fmt(s.p)} تومان — ${dstr(s.dk)}</div>`))+
  `<div class="row"><button class="btn yellow" data-a="returnP" data-id="${id}" ${stock(id)?'':'disabled'}>مرجوع کالا</button><button class="btn pink" data-a="exitP" data-id="${id}" ${stock(id)?'':'disabled'}>خروج کالا</button><button class="btn cyan" data-a="editSell" data-id="${id}" ${p.sell!=null?'':'disabled'}>اصلاح قیمت فروش</button></div>`;
}


function vReturns(){
  const pending=(DB.returns||[]).filter(x=>x.status==='pending').sort((a,b)=>b.ts-a.ts);
  const history=(DB.returns||[]).filter(x=>x.status!=='pending').sort((a,b)=>b.ts-a.ts);
  const card=x=>`<div class="card"><h4>${esc(x.name)}</h4><div class="m"><span>کد کالا</span><b>${esc(fa(x.code||''))}</b></div><div class="m"><span>تعداد مرجوعی</span><b>${fa(x.qty)} عدد</b></div><small>تاریخ: ${fdt(x.ts)}</small><p>${esc(x.note||'بدون توضیحات')}</p>${x.status==='pending'?`<div class="row"><button class="btn green" data-a="resolveReturn" data-id="${x.id}" data-mode="restore">بازگشت به موجودی</button><button class="btn pink" data-a="resolveReturn" data-id="${x.id}" data-mode="delete">حذف کالا</button></div>`:`<small>وضعیت: ${x.status==='restored'?'بازگشت به موجودی':'حذف کالا'}${x.actionNote?' | توضیحات: '+esc(x.actionNote):''}</small>`}</div>`;
  return `<h4>مرجوعی‌های در انتظار اقدام</h4>${pending.length?pending.map(card).join(''):empty('مورد مرجوعی در انتظار وجود ندارد')}<h4 style="margin-top:18px">سوابق مرجوعی</h4>${history.length?history.map(card).join(''):empty('هنوز سابقه‌ای ثبت نشده')}`;
}

const invFilter=q=>[...DB.invoices].sort(byNew).filter(v=>!q.trim()||norm(v.num).includes(norm(q)));
function invRows(q){
  const inv=invFilter(q);
  return inv.length?inv.map(v=>`<div class="item" data-a="invView" data-id="${v.id}"><div class="grow"><b>فاکتور ${esc(fa(v.num))}</b><small>${dstr(v.dk)} | ${fa(v.items.length)} قلم</small></div><div class="st"><small>جمع خرید</small>${fmt(v.items.reduce((s,i)=>s+i.qty*i.buy,0))}</div></div>`).join(''):empty(q.trim()?'فاکتوری با این شماره پیدا نشد':'هنوز فاکتوری ثبت نشده');
}
function vIn(){
  return `<div class="rowend">${logBtn('in')}</div><button class="btn wide green" data-a="newInv">${ico('plus')} افزودن فاکتور</button><button class="btn wide cyan" data-a="excelTemplate" data-kind="incoming">دریافت قالب اکسل ورود کالا</button><label class="btn wide yellow">ورود فاکتور از اکسل<input type="file" data-excel="incoming" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" style="display:none"></label>
  <div class="sbar" style="margin-top:8px"><input id="invq" inputmode="numeric" placeholder="جستجو با شماره فاکتور" value="${esc(S.iq)}"></div><div id="invlist">${invRows(S.iq)}</div>`;
}
function vDraft(){
  const d=S.draft,ed=!!d.edit;
  const tot=d.items.reduce((s,i)=>s+i.qty*i.buy,0);
  return `<div class="card"><div class="item" style="border:0;box-shadow:none;padding:0;margin:0;background:none"><div class="grow"><h4 style="margin:0">${ed?'اصلاح فاکتور':'فاکتور'} شماره ${esc(fa(d.num))}</h4><small>تاریخ ورود: ${dstr(d.dk)}${d.supplier?' | خرید از پخش: '+esc(d.supplier):''}</small></div><button class="ic sm" data-a="editHead">${ico('edit')}</button></div></div>
  <button class="btn wide cyan" data-a="addItem">${ico('plus')} اضافه کردن کالا</button>`+
  (d.items.length?d.items.map((i,n)=>`<div class="item"><div class="grow" data-a="editItem" data-i="${n}"><b>${esc(i.name)}</b><small>${fa(i.qty)} عدد | خرید ${fmt(i.buy)} | فروش ${fmt(i.sell)}</small></div><button class="ic sm" data-a="editItem" data-i="${n}">${ico('edit')}</button><button class="ic sm" data-a="delItem" data-i="${n}">${ico('trash')}</button></div>`).join('')+`<div class="card"><div class="m"><span>جمع خرید فاکتور</span><b class="cy">${fmt(tot)} تومان</b></div></div>`:empty('کالایی به فاکتور اضافه نشده'))+
  `<div class="row"><button class="btn pink" data-a="cancelInv">${ed?'انصراف':'لغو فاکتور'}</button><button class="btn green" data-a="commitInv">${ed?'ثبت اصلاحات':'ورود فاکتور'}</button></div>`;
}

function vDef(){
  const NC=4,shown=S.catsOpen?DB.cats:DB.cats.slice(0,NC);
  let chips=shown.map(c=>`<span class="chip">${esc(c.name)}</span>`).join('');
  if(DB.cats.length>NC)chips+=`<button class="chipbtn" data-a="toggleCats">${S.catsOpen?ico('chevUp',20):ico('chev',20)+'<span>'+fa(DB.cats.length-NC)+'+</span>'}</button>`;
  const ep=S.editPid?prod(S.editPid):null;
  const dc=S.defCat&&cat(S.defCat)?S.defCat:'';
  let form=`<select id="fc" ${ep?'disabled':''}><option value="">انتخاب دسته‌بندی...</option>${DB.cats.map(c=>`<option value="${c.id}" ${c.id===dc?'selected':''}>${esc(c.name)}</option>`).join('')}</select>`;
  if(dc){
    form+=`<label>کد کالا</label><div class="sbar"><input id="fcode" value="${esc(ep?ep.code:nextCode())}"><button class="ic" data-a="autoCode">${ico('gen')}</button></div>
    <label>بارکد کالا</label><div class="sbar"><input id="fbar" inputmode="numeric" value="${esc(ep&&ep.barcode||'')}"><button class="ic" data-a="scanBar">${ico('scan')}</button></div>
    <label>نام کالا</label><input id="fname" value="${esc(ep?ep.name:'')}">
    <div class="row">${ep?'<button class="btn pink" data-a="cancelEdit">انصراف</button>':''}<button class="btn cyan" data-a="saveProd">${ep?'ذخیره تغییرات':'ثبت کالا'}</button></div>`;
  }
  const list=dc?DB.products.filter(p=>p.cat===dc).map(p=>`<div class="item"><div class="grow"><b>${esc(p.name)}</b><small>کد: ${esc(fa(p.code))}${p.barcode?' | بارکد: '+esc(fa(p.barcode)):''}</small></div><button class="ic sm" data-a="editProd" data-id="${p.id}">${ico('edit')}</button><button class="ic sm" data-a="delProd" data-id="${p.id}">${ico('trash')}</button></div>`).join(''):'';
  return `<div class="rowend">${logBtn('def')}</div><button class="btn wide cyan" data-a="excelTemplate" data-kind="products">دریافت قالب اکسل تعریف کالا</button><label class="btn wide yellow">تعریف کالا از اکسل<input type="file" data-excel="products" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" style="display:none"></label><div class="card"><h4>دسته‌بندی‌ها</h4>${chips||empty('هنوز دسته‌بندی ندارید')}
  <label style="margin-top:10px">نام دسته‌بندی جدید</label>
  <div class="sbar"><input id="ncat" placeholder="مثلاً کابل"><button class="ic" data-a="addCat">${ico('plus')}</button></div>
  <button class="btn wide pink" data-a="delCats">${ico('trash',20)} حذف دسته‌بندی</button></div>
  <div class="card"><h4>${ep?'ویرایش کالا':'تعریف کالا'}</h4>${form}</div>
  ${list?`<h4 style="margin:16px 4px 8px;color:var(--acd)">کالاهای این دسته</h4>${list}`:''}`;
}

function vOut(r){
  const y=+r[1],m=+r[2],d=+r[3];
  const sumO=a=>a.reduce((s,o)=>s+o.q*o.unit,0);
  const st=a=>`<div class="st"><small>جمع خروجی</small>${fmt(sumO(a))}</div>`;
  if(!y){
    const ys=[...new Set(DB.outs.map(o=>dY(o.dk)))].sort((a,b)=>b-a);
    let h=ys.length?ys.map(v=>{const a=DB.outs.filter(o=>dY(o.dk)===v);return `<div class="item" data-a="go" data-h="#/out/${v}"><div class="grow"><b>سال ${fa(v)}</b><small>${fa(a.length)} خروج</small></div>${st(a)}</div>`}).join(''):empty('هنوز خروجی ثبت نشده');
    h=`<div class="rowend">${logBtn('out')}</div>`+h;
    const t=today(),to=DB.outs.filter(o=>o.dk===t).sort((a,b)=>b.ts-a.ts);
    h+=`<div class="card" style="margin-top:16px"><h4>فروش امروز — ${dstr(t)}</h4>`+(to.length?`<div class="m"><span>جمع خروجی امروز</span><b class="cy">${fmt(sumO(to))} تومان</b></div>`+to.map(x=>`<div class="lot"><b>${esc(x.name)}</b><small>کد ${esc(fa(outCode(x)))} | ${fa(x.q)} عدد × ${fmt(x.unit)} | ${esc(x.cust||'مشتری آزاد')} ${payTag(x)}</small></div>`).join(''):`<small>امروز هنوز فروشی ثبت نشده</small>`)+`</div>`;
    return h;
  }
  if(!m){
    const o=DB.outs.filter(x=>dY(x.dk)===y);let h='';
    for(let i=1;i<=12;i++){const a=o.filter(x=>dM(x.dk)===i);if(a.length)h+=`<div class="item" data-a="go" data-h="#/out/${y}/${i}"><div class="grow"><b>${MN[i-1]}</b><small>${fa(a.length)} خروج</small></div>${st(a)}</div>`}
    return h||empty('خروجی‌ای در این سال نیست');
  }
  if(!d){
    const o=DB.outs.filter(x=>dY(x.dk)===y&&dM(x.dk)===m);let h='';
    for(let i=31;i>=1;i--){const a=o.filter(x=>dD(x.dk)===i);if(a.length)h+=`<div class="item" data-a="go" data-h="#/out/${y}/${m}/${i}"><div class="grow"><b>${fa(i)} ${MN[m-1]}</b><small>${fa(a.length)} خروج</small></div>${st(a)}</div>`}
    return h||empty('خروجی‌ای در این ماه نیست');
  }
  const k=y*10000+m*100+d;
  const o=DB.outs.filter(x=>x.dk===k).sort((a,b)=>b.ts-a.ts);
  return o.length?`<div class="card"><div class="m"><span>جمع خروجی این روز</span><b class="cy">${fmt(sumO(o))} تومان</b></div></div>`+o.map(x=>`<div class="item"><div class="grow"><b>${esc(x.name)}</b><small>کد کالا: ${esc(fa(outCode(x)))}</small><small>${fa(x.q)} عدد × ${fmt(x.unit)} | مشتری: ${esc(x.cust||'مشتری آزاد')} ${payTag(x)}</small></div><div class="st"><small>جمع</small>${fmt(x.q*x.unit)}</div><button class="ic sm" data-a="undoOut" data-id="${x.id}">${ico('undo')}</button></div>`).join('')+`<small class="empty" style="display:block">دکمه برگشت، خروج را لغو و کالا را به موجودی برمی‌گرداند</small>`:empty('خروجی‌ای در این روز نیست');
}

function photRows(q){
  const inv=invFilter(q);
  return inv.length?inv.map(v=>{const n=DB.imgs.filter(m=>m.inv===v.id).length;return `<div class="item" data-a="photos" data-id="${v.id}"><div class="grow"><b>فاکتور ${esc(fa(v.num))}</b><small>${dstr(v.dk)}</small></div><div class="st">${ico('img',20)}<small>${fa(n)} عکس</small></div></div>`}).join(''):empty(q.trim()?'فاکتوری با این شماره پیدا نشد':'ابتدا یک فاکتور ورود ثبت کنید');
}
function vRep(){
  const ys=allYears();
  if(!S.ry)S.ry=dY(today());if(!S.rm)S.rm=dM(today());
  if(!S.rf)S.rf=dstr(today());if(!S.rto)S.rto=dstr(today());
  const mc=(t,a,showIn)=>`<div class="card"><h4>${t}</h4>${showIn?`<div class="m"><span>جمع ورودی (خرید)</span><b class="cy">${fmt(a.i)}</b></div>`:''}<div class="m"><span>جمع خروجی (فروش)</span><b class="pk">${fmt(a.o)}</b></div><div class="m"><span>سود فروش</span><b class="${a.p<0?'rd':'gr'}">${fmt(a.p)}</b></div></div>`;
  const ysel=`<select id="ry">${ys.map(y=>`<option value="${y}" ${y===S.ry?'selected':''}>${fa(y)}</option>`).join('')}</select>`;
  const msel=`<select id="rm">${MN.map((n,i)=>`<option value="${i+1}" ${i+1===S.rm?'selected':''}>${n}</option>`).join('')}</select>`;
  const tab=(k,t)=>`<button class="${S.rt===k?'on':''}" data-a="rtab" data-k="${k}">${t}</button>`;
  let h=`<div class="rowend">${logBtn('rep')}</div><div class="tabs">${tab('all','از ابتدا')}${tab('y','سالیانه')}${tab('m','ماهانه')}${tab('d','روزانه')}${tab('r','بازه زمانی')}${tab('f','فاکتور فیزیکی')}</div>`;
  if(S.rt==='all'){
    const a=agg(0,99999999),stV=DB.lots.reduce((s,l)=>s+l.rem*l.buy,0),stQ=a.ni-a.no;
    h+=`<div class="card"><h4>گزارش از ابتدا تاکنون</h4>
    <div class="m"><span>جمع ورود</span><b class="cy">${fa(a.ni)} عدد</b></div><div class="m"><span>مبلغ خرید</span><b>${fmt(a.i)}</b></div>
    <div class="m" style="margin-top:8px"><span>جمع خروج</span><b class="pk">${fa(a.no)} عدد</b></div><div class="m"><span>مبلغ فروش</span><b>${fmt(a.o)}</b></div>
    <div class="m" style="margin-top:8px"><span>جمع موجودی (ورود − خروج)</span><b class="cy">${fa(stQ)} عدد</b></div><div class="m"><span>ارزش موجودی به قیمت خرید</span><b>${fmt(stV)}</b></div>
    <div class="m" style="margin-top:8px"><span>جمع سود</span><b class="${a.p<0?'rd':'gr'}">${fmt(a.p)}</b></div></div>`;
  }else if(S.rt==='y'){
    h+=ys.map(y=>mc('سال '+fa(y),agg(y*10000+101,y*10000+1231),true)).join('');
  }else if(S.rt==='m'){
    h+=ysel;let n=0;
    for(let m=1;m<=12;m++){const a=agg(S.ry*10000+m*100+1,S.ry*10000+m*100+31);if(a.i||a.o){n++;h+=mc(MN[m-1]+' '+fa(S.ry),a,false)}}
    if(!n)h+=empty('گزارشی برای این سال نیست');
  }else if(S.rt==='d'){
    h+=`<div class="row">${ysel}${msel}</div>`;let n=0;
    for(let d=31;d>=1;d--){const k=S.ry*10000+S.rm*100+d;const a=agg(k,k);if(a.o){n++;h+=mc(fa(d)+' '+MN[S.rm-1],a,false)}}
    if(!n)h+=empty('گزارشی برای این ماه نیست');
  }else if(S.rt==='r'){
    h+=`<label>از تاریخ</label><input id="rf" value="${esc(S.rf)}" inputmode="numeric"><label>تا تاریخ</label><input id="rto" value="${esc(S.rto)}" inputmode="numeric"><button class="btn wide cyan" data-a="rrange">نمایش گزارش</button>`;
    const lo=parseD(S.rf),hi=parseD(S.rto);
    if(lo&&hi)h+=mc('از '+dstr(lo)+' تا '+dstr(hi),agg(lo,hi),true);
  }else{
    h+=`<div class="sbar"><input id="photq" inputmode="numeric" placeholder="جستجو با شماره فاکتور" value="${esc(S.pq)}"></div><div id="photlist">${photRows(S.pq)}</div>`;
  }
  return h;
}

/* ================= مسیریابی ================= */
function render(keep){
  const r=route(),k=r[0]||'stock';let h='',t='',tab=k;
  const y0=window.scrollY;
  if(k==='in'&&r[1]==='new'&&!S.draft){location.replace('#/in');return}
  if(k==='stock'){t='موجودی';h=vStock()}
  else if(k==='cat'){const c=cat(r[1]);t=c?c.name:'دسته‌بندی';h=vCat(r[1]);tab='stock'}
  else if(k==='p'){t='جزئیات کالا';h=vProd(r[1]);tab='stock'}
  else if(k==='in'){if(r[1]==='new'){t=S.draft.edit?'اصلاح فاکتور':'فاکتور جدید';h=vDraft()}else{t='ورود کالا';h=vIn()}}
  else if(k==='returns'){t='مرجوعی کالا';h=vReturns()}
  else if(k==='price'){t=r[2]&&cat(r[2])?cat(r[2]).name:r[1]==='cats'?'قیمت دسته‌بندی‌ها':r[1]==='items'?'کالای انتخابی':'تغییر قیمت فروش';h=vPrice(r);tab='stock'}
  else if(k==='disc'){t=r[2]&&cat(r[2])?cat(r[2]).name:r[1]==='cats'?'تخفیف دسته‌بندی‌ها':r[1]==='items'?'تخفیف کالای انتخابی':'تخفیف';h=vDisc(r);tab='stock'}
  else if(k==='def'){t='تعریف کالا';h=vDef()}
  else if(k==='out'){t=r[3]?`خروجی ${fa(r[3])} ${MN[r[2]-1]||''}`:r[2]?`خروجی ${MN[r[2]-1]||''} ${fa(r[1])}`:r[1]?`خروجی سال ${fa(r[1])}`:'خروجی';h=vOut(r)}
  else if(k==='rep'){t='گزارش مالی';h=vRep()}
  else{location.replace('#/stock');return}
  $('#title').textContent=t;$('#view').innerHTML=h;
  document.body.dataset.t=tab;try{const SC={def:'#2fc3cb',in:'#3aa57f',stock:'#ffd650',returns:'#dcc18b',out:'#ee1388',rep:'#d02c5e'};const C=window.Capacitor&&window.Capacitor.Plugins;if(C&&C.StatusBar)C.StatusBar.setBackgroundColor({color:SC[tab]||'#ffd66b'});const m=document.querySelector('meta[name=theme-color]');if(m)m.content=SC[tab]||'#ffd66b'}catch(e){}
  $('#shb').style.display=['def','in','stock','out','rep'].includes(tab)?'flex':'none';
  document.querySelectorAll('#nav a').forEach(a=>a.classList.toggle('on',a.dataset.t===tab));
  const b=$('#back');
  if(r.length>1){b.innerHTML=`<button class="ic" data-a="back">${ico('back')}</button>`}else b.innerHTML='<img src="logo.png" alt="">';
  window.scrollTo(0,keep===true?y0:0);
}

/* ================= عملیات ================= */
function scopeLabel(key){const [k,id]=key.split(':');const c=cat(id);return (k==='cat'?'دسته ':'کالاهای انتخابی دسته ')+(c?c.name:'')}
function pctApply(ids,v,key){
  const rec=[];
  ids.forEach(id=>{const p=prod(id);if(p&&p.disc)undisc(p);if(p&&p.sell!=null){const prev=p.sell,hl=(p.sellHist||[]).length,nw=roundUp(prev*(1+v/100));setSell(p,nw);rec.push({id,prev,nw,added:(p.sellHist||[]).length>hl})}});
  if(!rec.length){toast('کالایی با قیمت فروش در این بخش نیست',1);return 0}
  PL[key]={pct:v,at:Date.now(),by:CFG.user||'',items:rec};savePL();
  logAct('stock',`تغییر قیمت فروش ${scopeLabel(key)}: ${fa(v)}٪ روی ${fa(rec.length)} کالا`);
  save();return rec.length;
}
function revertScope(key){
  const r=PL[key];if(!r)return null;
  let n=0,sk=0;const ids=[];
  r.items.forEach(it=>{const p=prod(it.id);if(!p)return;if(p.sell!==it.nw){sk++;return}p.sell=it.prev;if(it.added&&p.sellHist&&p.sellHist[0]&&p.sellHist[0].p===it.nw)p.sellHist.shift();touch(p);n++;ids.push(it.id)});
  delete PL[key];savePL();return {n,sk,ids};
}
function pctModal(o){
  const b=modal(`<h3>${o.title}</h3>${o.pre||''}<p class="q">${o.label}</p><input id="pv" inputmode="decimal" placeholder="مثلاً ۱۰   (برای کاهش: -۱۰)"><small>قیمت‌های جدید به سمت بالا رند می‌شوند.</small><div class="row"><button class="btn pink" data-a="close">انصراف</button><button class="btn cyan" id="pok">تایید</button></div>`);
  $('#pok',b).onclick=async()=>{
    const v=num($('#pv',b).value);
    if(isNaN(v)||v<=-100){toast('درصد نامعتبر است',1);return}
    if(!await ask(`قیمت فروش ${fa(o.ids.length)} کالا ${fa(v)} درصد تغییر کند؟ آیا مطمئن هستید؟`))return;
    const n=pctApply(o.ids,v,o.key);
    if(n){closeModal(b);render(true);toast(`قیمت فروش ${fa(n)} کالا تغییر کرد`)}
  };
}
function delCatsModal(){
  const b=modal(`<h3>حذف دسته‌بندی</h3>${DB.cats.length?DB.cats.map(c=>`<div class="item"><div class="grow"><b>${esc(c.name)}</b><small>${fa(DB.products.filter(p=>p.cat===c.id).length)} کالا</small></div><button class="ic sm" data-a="delCat" data-id="${c.id}">${ico('trash')}</button></div>`).join(''):empty('دسته‌بندی‌ای وجود ندارد')}<button class="btn pink wide" data-a="close">بستن</button>`);
  return b;
}
function itemForm(box,p,init,onOk){
  box.innerHTML=`<h3>${esc(p.name)}</h3><small>کد: ${esc(fa(p.code))}</small>
  <label>تعداد کالا</label><input id="iq" inputmode="numeric" value="${init.qty}">
  <label>قیمت خرید (تومان)</label><input class="money" id="ib" inputmode="numeric" value="${init.buy!==''?nf(init.buy):''}">
  <label>قیمت فروش (تومان)</label><input class="money" id="is" inputmode="numeric" value="${init.sell!==''?nf(init.sell):''}">
  <div class="row"><button class="btn pink" data-a="close">انصراف</button><button class="btn cyan" id="iok">تایید</button></div>`;
  $('#iok',box).onclick=()=>{
    const q=num($('#iq',box).value),b=num($('#ib',box).value),s=num($('#is',box).value);
    if(!(q>0)||!Number.isInteger(q)){toast('تعداد نامعتبر است',1);return}
    if(isNaN(b)||b<0||isNaN(s)||s<0){toast('قیمت خرید و فروش را وارد کنید',1);return}
    onOk(q,b,s);closeModal(box);render();
  };
}
function fillA(){
  const q=$('#aq').value,box=$('#ares');
  const l=q.trim()?findP(q):[];
  box.innerHTML=q.trim()?(l.length?l.map(p=>`<div class="item" data-a="pickItem" data-id="${p.id}"><div class="grow"><b>${esc(p.name)}</b><small>کد: ${esc(fa(p.code))}</small></div></div>`).join(''):empty('کالایی پیدا نشد؛ ابتدا در بخش «تعریف» آن را بسازید')):'';
}
async function saveToGallery(data,name){
  const C=window.Capacitor&&window.Capacitor.Plugins,ALB='AccessoryInvoices';
  if(!C||!C.Filesystem){toast('ذخیره در گالری فقط داخل برنامه موبایل ممکن است',1);return}
  try{
    const w=await C.Filesystem.writeFile({path:name+'.jpg',data:data.split(',')[1],directory:'CACHE'});
    if(C.Media){
      try{
        const find=async()=>((await C.Media.getAlbums()).albums||[]).find(a=>a.name===ALB);
        let al=await find();
        if(!al){await C.Media.createAlbum({name:ALB});al=await find()}
        await C.Media.savePhoto({path:w.uri,albumIdentifier:al&&al.identifier,fileName:name});
        toast('در گالری ذخیره شد (آلبوم '+ALB+')');return;
      }catch(e){}
    }
    if(C.Share){await C.Share.share({title:'عکس فاکتور',url:w.uri,dialogTitle:'ذخیره یا ارسال عکس'});return}
  }catch(e){}
  toast('ذخیره عکس ممکن نشد',1);
}
async function exportData(){
  const s=JSON.stringify(DB),name='backup-'+today()+'.json';
  const C=window.Capacitor&&window.Capacitor.Plugins;
  try{
    if(C&&C.Filesystem&&C.Share){
      const r=await C.Filesystem.writeFile({path:name,data:s,directory:'CACHE',encoding:'utf8'});
      await C.Share.share({title:'پشتیبان اطلاعات',url:r.uri,dialogTitle:'ذخیره یا ارسال فایل پشتیبان'});
      return;
    }
  }catch(e){}
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([s],{type:'application/json'}));a.download=name;a.click();
}

function parseCSV(text){
  text=String(text||'').replace(/^\ufeff/,'');const rows=[];let row=[],cell='',q=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(q){if(c==='"'&&text[i+1]==='"'){cell+='"';i++}else if(c==='"')q=false;else cell+=c}else if(c==='"')q=true;else if(c===','){row.push(cell);cell=''}else if(c==='\n'){row.push(cell);rows.push(row);row=[];cell=''}else if(c!=='\r')cell+=c}
  if(cell!==''||row.length){row.push(cell);rows.push(row)}return rows.filter(r=>r.some(x=>String(x).trim()));
}
async function parseXlsxFile(file){
  const b=await file.arrayBuffer(),v=new DataView(b),u16=o=>v.getUint16(o,true),u32=o=>v.getUint32(o,true);let eocd=-1;
  for(let i=b.byteLength-22;i>=Math.max(0,b.byteLength-65558);i--){if(u32(i)===0x06054b50){eocd=i;break}}
  if(eocd<0)throw Error('zip');const count=u16(eocd+10),start=u32(eocd+16),files={};let off=start;
  for(let n=0;n<count;n++){if(u32(off)!==0x02014b50)throw Error('central');const method=u16(off+10),csize=u32(off+20),nlen=u16(off+28),elen=u16(off+30),clen=u16(off+32),local=u32(off+42),name=new TextDecoder().decode(new Uint8Array(b,off+46,nlen));const lo=u16(local+26),le=u16(local+28),dataOff=local+30+lo+le,comp=b.slice(dataOff,dataOff+csize);let raw;
    if(method===0)raw=comp;else if(method===8){if(!('DecompressionStream'in window))throw Error('inflate unsupported');const ds=new DecompressionStream('deflate-raw');raw=await new Response(new Blob([comp]).stream().pipeThrough(ds)).arrayBuffer()}else throw Error('compression');files[name]=new TextDecoder().decode(raw);off+=46+nlen+elen+clen;}
  const xml=s=>new DOMParser().parseFromString(s,'application/xml'),wb=xml(files['xl/workbook.xml']),rels=xml(files['xl/_rels/workbook.xml.rels']);let target='worksheets/sheet1.xml';const rid=wb.getElementsByTagName('sheet')[0]?.getAttribute('r:id');if(rid){for(const r of rels.getElementsByTagName('Relationship'))if(r.getAttribute('Id')===rid)target='xl/'+r.getAttribute('Target').replace(/^\//,'').replace(/^xl\//,'')}
  const shared=files['xl/sharedStrings.xml']?Array.from(xml(files['xl/sharedStrings.xml']).getElementsByTagName('si')).map(si=>Array.from(si.getElementsByTagName('t')).map(t=>t.textContent).join('')):[];
  const sheet=xml(files[target]);const rows=[];for(const row of sheet.getElementsByTagName('row')){const cells=[];for(const c of row.children){if(c.localName!=='c')continue;const ref=c.getAttribute('r')||'',letters=ref.match(/[A-Z]+/),col=letters?letters[0].split('').reduce((n,ch)=>n*26+ch.charCodeAt(0)-64,0)-1:cells.length;let val='';const typ=c.getAttribute('t'),vv=c.getElementsByTagName('v')[0];if(typ==='inlineStr')val=Array.from(c.getElementsByTagName('t')).map(t=>t.textContent).join('');else if(vv)val=typ==='s'?(shared[+vv.textContent]||''):vv.textContent;cells[col]=val}rows.push(cells.map(x=>x??''))}return rows;
}
async function importExcelCSV(file,kind){
  try{const rows=/\.xlsx$/i.test(file.name)?await parseXlsxFile(file):parseCSV(await file.text());if(rows.length<2)throw Error('empty');const heads=rows[0].map(x=>norm(x));const ix=(...names)=>heads.findIndex(h=>names.some(n=>h===norm(n)));
    const get=(r,...names)=>{const i=ix(...names);return i<0?'':String(r[i]??'').trim()};let done=0;
    for(const r of rows.slice(1)){
      const category=get(r,'دسته‌بندی'),code=digits(get(r,'کد کالا')),barcode=digits(get(r,'بارکد کالا')),name=get(r,'نام کالا');if(!category||!code||!name)continue;
      let invnum='',dk=0,qty=0,buy=0,sell=0,supplier='';
      if(kind==='incoming'){invnum=get(r,'شماره فاکتور');dk=parseD(get(r,'تاریخ ورود (شمسی)','تاریخ ورود'));qty=num(get(r,'تعداد'));buy=num(get(r,'قیمت خرید'));sell=num(get(r,'قیمت فروش'));supplier=get(r,'خرید از پخش');if(!invnum||!dk||!Number.isInteger(qty)||qty<=0||isNaN(buy)||buy<0||isNaN(sell)||sell<0)continue}
      let c=DB.cats.find(x=>norm(x.name)===norm(category));if(!c){c=touch({id:uid(),name:category});DB.cats.push(c)}
      let p=DB.products.find(x=>norm(x.code)===norm(code));if(!p){p=touch({id:uid(),cat:c.id,code,barcode,name,sell:null,sellHist:[]});DB.products.push(p)}else{p.cat=c.id;p.name=name;if(barcode)p.barcode=barcode;touch(p)}
      if(kind==='incoming'){
        let v=DB.invoices.find(x=>x.num===invnum&&x.dk===dk&&(x.supplier||'')===supplier);if(!v){v=touch({id:uid(),num:invnum,dk,supplier,ts:Date.now(),items:[],by:CFG.user||''});DB.invoices.push(v)}
        const lotId=uid();v.items.push({pid:p.id,name:p.name,qty,buy,sell,lotId});DB.lots.push(touch({id:lotId,pid:p.id,invId:v.id,inv:v.num,dk:v.dk,ts:v.ts,qty,rem:qty,buy,sell}));setSell(p,sell);done++;
      }else done++;
    }
    if(!done)throw Error('no rows');logAct(kind==='incoming'?'in':'def',`ورود ${fa(done)} ردیف از فایل اکسل`);save();render();toast(`${fa(done)} ردیف از اکسل ثبت شد`);
  }catch(e){toast('ساختار فایل معتبر نیست؛ از قالب دانلودشده استفاده کنید',1)}
}

function importFile(f){
  if(!f)return;
  const r=new FileReader();
  r.onload=async()=>{
    try{
      const d=JSON.parse(r.result);
      if(!d||!Array.isArray(d.cats)||!Array.isArray(d.products)||!Array.isArray(d.lots)||!Array.isArray(d.outs)||!Array.isArray(d.invoices))throw 0;
      if(!await ask('تمام اطلاعات فعلی با فایل پشتیبان جایگزین می‌شود. مطمئن هستید؟'))return;
      DB=fix(d);migrate();save();MD.innerHTML='';render();toast('اطلاعات بازیابی شد');
    }catch(e){toast('فایل پشتیبان معتبر نیست',1)}
  };
  r.readAsText(f);
}
function photosModal(id){
  const v=DB.invoices.find(x=>x.id===id);if(!v)return;
  const ims=DB.imgs.filter(m=>m.inv===id).sort((a,b)=>a.ts-b.ts);
  const b=modal(`<h3>فاکتور ${esc(fa(v.num))}</h3><small>${dstr(v.dk)}</small>
  ${ims.length?`<div class="thumbs">${ims.map(m=>`<img data-img="${m.id}" data-a="viewImg" data-id="${m.id}" data-inv="${id}" alt="">`).join('')}</div>`:empty('هنوز عکسی از فاکتور فیزیکی اضافه نشده')}
  <label class="btn wide green">${ico('img')} افزودن عکس فاکتور<input type="file" id="pfile" data-inv="${id}" accept="image/*" multiple style="display:none"></label>
  <button class="btn wide pink" data-a="close">بستن</button>`);
  fillThumbs(b);
}

let lastBack=0;
function parentHash(){
  const r=route(),k=r[0]||'stock';
  if(k==='p'){const p=prod(r[1]);return p&&cat(p.cat)?'#/cat/'+p.cat:'#/stock'}
  if(k==='cat')return '#/stock';
  if(r.length>1){r.pop();return '#/'+r.join('/')}
  return k!=='stock'?'#/stock':null;
}
async function onBack(){
  if(document.documentElement.classList.contains('scanning')){if(stopScanFn)stopScanFn();return}
  const top=MD.lastElementChild;
  if(top){const bx=top.firstChild;if(bx&&bx._cancel)bx._cancel();top.remove();return}
  const r=route();
  if(r[0]==='in'&&r[1]==='new'&&S.draft){if(await ask('فاکتور هنوز ذخیره نشده است. خارج می‌شوید؟')){S.draft=null;location.hash='#/in'}return}
  const h=parentHash();
  if(h){location.hash=h;return}
  const now=Date.now();
  if(now-lastBack<2200){const A=window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.App;if(A&&A.exitApp)A.exitApp()}
  else{lastBack=now;toast('برای خروج، یک بار دیگر دکمه بازگشت را بزنید')}
}
/* ---------- اشتراک‌گذاری ---------- */
function textOf(el){
  let s='';
  el.childNodes.forEach(n=>{
    if(n.nodeType===3){s+=n.textContent;return}
    if(n.nodeType!==1||n.matches('button,input,select,svg,.sbar,.tabs,.rowend,summary,label.btn,textarea,img'))return;
    if(n.matches('.m')){s+='\n'+[...n.children].map(c=>c.textContent.trim()).join(': ')+'\n';return}
    const t=textOf(n);
    if(n.matches('.item,.card,.sq'))s+='\n\n'+t+'\n\n';
    else if(n.matches('div,b,small,p,h4,.lot'))s+='\n'+t+'\n';
    else s+=t;
  });
  return s;
}
function viewLines(){
  const title=$('#title').textContent;
  const raw=textOf($('#view')).split('\n').map(x=>x.replace(/\s+/g,' ').trim());
  const L=[];raw.forEach(x=>{if(x||(L.length&&L[L.length-1]))L.push(x)});
  while(L.length&&!L[L.length-1])L.pop();
  return {title:'مدیریت کالای جانبی — '+title,lines:['تاریخ: '+fdt(Date.now()),(CFG.user?'کاربر: '+CFG.user:''),'',...L].filter((x,i,a)=>x||(i>0&&a[i-1]))};
}
/* ---------- اکسل (xlsx) ---------- */
const CRC=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0}return b=>{let c=0xFFFFFFFF;for(let i=0;i<b.length;i++)c=t[(c^b[i])&255]^(c>>>8);return (c^0xFFFFFFFF)>>>0}})();
function zipStore(files){
  const enc=new TextEncoder(),parts=[],cen=[];let off=0;
  const u16=n=>[n&255,(n>>8)&255],u32=n=>[n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255];
  for(const f of files){
    const nm=enc.encode(f.name),crc=CRC(f.data),sz=f.data.length;
    const lh=new Uint8Array([0x50,0x4b,3,4,...u16(20),...u16(0x0800),...u16(0),...u16(0),...u16(0x21),...u32(crc),...u32(sz),...u32(sz),...u16(nm.length),...u16(0)]);
    parts.push(lh,nm,f.data);
    cen.push(new Uint8Array([0x50,0x4b,1,2,...u16(20),...u16(20),...u16(0x0800),...u16(0),...u16(0),...u16(0x21),...u32(crc),...u32(sz),...u32(sz),...u16(nm.length),...u16(0),...u16(0),...u16(0),...u16(0),...u32(0),...u32(off)]),nm);
    off+=lh.length+nm.length+sz;
  }
  let cl=0;cen.forEach(c=>cl+=c.length);
  const end=new Uint8Array([0x50,0x4b,5,6,0,0,0,0,...u16(files.length),...u16(files.length),...u32(cl),...u32(off),0,0]);
  const all=[...parts,...cen,end];let tot=0;all.forEach(a=>tot+=a.length);
  const out=new Uint8Array(tot);let q=0;all.forEach(a=>{out.set(a,q);q+=a.length});return out;
}
const xe=v=>String(v==null?'':v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const colL=i=>{let t='';i++;while(i>0){const m=(i-1)%26;t=String.fromCharCode(65+m)+t;i=Math.floor((i-1)/26)}return t};
function makeXlsx(sheet,head,rows,widths,color){
  const enc=new TextEncoder(),X='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const C=(v,r,c,st)=>{const ref=colL(c)+r;
    if(v==null||v==='')return `<c r="${ref}" s="${st}"/>`;
    if(typeof v==='number'&&isFinite(v))return `<c r="${ref}" s="2"><v>${v}</v></c>`;
    return `<c r="${ref}" s="${st}" t="inlineStr"><is><t xml:space="preserve">${xe(v)}</t></is></c>`};
  let sd=`<row r="1" ht="26" customHeight="1">${head.map((h,c)=>C(h,1,c,1)).join('')}</row>`;
  rows.forEach((row,i)=>{sd+=`<row r="${i+2}">${row.map((v,c)=>C(v,i+2,c,0)).join('')}</row>`});
  const last=colL(head.length-1)+(rows.length+1),ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const ws=X+`<worksheet xmlns="${ns}"><sheetViews><sheetView rightToLeft="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>${widths.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${sd}</sheetData><autoFilter ref="A1:${last}"/></worksheet>`;
  const bd='<border><left style="thin"><color rgb="FFBBBBBB"/></left><right style="thin"><color rgb="FFBBBBBB"/></right><top style="thin"><color rgb="FFBBBBBB"/></top><bottom style="thin"><color rgb="FFBBBBBB"/></bottom><diagonal/></border>';
  const styles=X+`<styleSheet xmlns="${ns}"><fonts count="2"><font><sz val="11"/><name val="Tahoma"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Tahoma"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="${color||'FF3A8FB0'}"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>${bd}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const nm=String(sheet).replace(/[\[\]:*?\/\\]/g,' ').slice(0,31)||'Sheet1';
  const R='http://schemas.openxmlformats.org/officeDocument/2006/relationships',PK='http://schemas.openxmlformats.org/package/2006/relationships';
  const files=[
    ['[Content_Types].xml',X+'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels',X+`<Relationships xmlns="${PK}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml',X+`<workbook xmlns="${ns}" xmlns:r="${R}"><bookViews><workbookView/></bookViews><sheets><sheet name="${xe(nm)}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels',X+`<Relationships xmlns="${PK}"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${R}/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml',styles],
    ['xl/worksheets/sheet1.xml',ws]
  ];
  return zipStore(files.map(([name,t])=>({name,data:enc.encode(t)})));
}
const dasc=k=>dY(k)+'/'+pad(dM(k))+'/'+pad(dD(k));
function curSec(){const k=route()[0]||'stock';return {def:'def',in:'in',out:'out',stock:'stock',cat:'stock',p:'stock',price:'stock',disc:'stock'}[k]||null}
function xlsBuild(sec,o){
  const ci=new Map(DB.cats.map((c,i)=>[c.id,i])),cn=id=>{const c=cat(id);return c?c.name:''};
  const ps=[...DB.products].sort((a,b)=>(ci.has(a.cat)?ci.get(a.cat):999)-(ci.has(b.cat)?ci.get(b.cat):999)||((+a.code)-(+b.code))||String(a.code).localeCompare(String(b.code)));
  if(sec==='def')return {title:'تعریف کالا',sheet:'تعریف کالا',file:'products',color:'FF3A8FB0',head:['دسته‌بندی','کد کالا','بارکد کالا','نام کالا'],widths:[22,16,24,46],
    rows:ps.map(p=>[cn(p.cat),String(p.code),p.barcode?String(p.barcode):'',p.name])};
  if(sec==='stock')return {title:'موجودی کالا',sheet:'موجودی',file:'stock',color:'FFE89A2E',head:['کد کالا','بارکد کالا','نام کالا','تعداد','قیمت خرید','قیمت فروش'],widths:[16,24,46,10,16,16],
    rows:ps.map(p=>[String(p.code),p.barcode?String(p.barcode):'',p.name,stock(p.id),lastBuy(p.id)==null?'':lastBuy(p.id),p.sell!=null?p.sell:''])};
  if(sec==='in'){
    const rows=[];
    [...DB.invoices].sort(byNew).forEach(v=>v.items.forEach(i=>{const pr=prod(i.pid);rows.push([String(v.num),dasc(v.dk),v.supplier||'',pr?String(pr.code):'',i.name,i.qty,i.buy,i.sell,i.qty*i.buy])}));
    return {title:'ورود کالا',sheet:'ورود کالا',file:'incoming',color:'FF3AA57F',head:['شماره فاکتور','تاریخ ورود','خرید از پخش','کد کالا','نام کالا','تعداد','قیمت خرید','قیمت فروش','جمع خرید'],widths:[14,14,22,14,44,10,16,16,18],rows};
  }
  const y=o&&o.year||dY(today());
  const a=DB.outs.filter(x=>dY(x.dk)===y).sort((p,q)=>p.dk-q.dk||p.ts-q.ts);
  return {title:'خروجی سال '+fa(y),sheet:'خروجی '+y,file:'outgoing-'+y,color:'FFEE1388',head:['تاریخ','کد کالا','نام کالا','دسته‌بندی','تعداد','قیمت فروش (هر عدد)','جمع فروش','مشتری','نوع پرداخت','ثبت‌کننده'],widths:[14,14,44,20,10,18,18,24,12,16],
    rows:a.map(x=>[dasc(x.dk),String(outCode(x)),x.name,x.cat||'',x.q,x.unit,x.q*x.unit,x.cust||'مشتری آزاد',x.pay==='credit'?'نسیه':'نقد',x.by||''])};
}
async function shareXlsx(x){
  const C=window.Capacitor&&window.Capacitor.Plugins;
  try{
    toast('در حال ساخت فایل اکسل...');
    await new Promise(r=>setTimeout(r,30));
    const u=makeXlsx(x.sheet,x.head,x.rows,x.widths,x.color),name=x.file+'-'+today()+'.xlsx';
    if(C&&C.Filesystem&&C.Share){
      let b='';for(let i=0;i<u.length;i+=0x8000)b+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));
      const w=await C.Filesystem.writeFile({path:name,data:btoa(b),directory:'CACHE'});
      await C.Share.share({title:x.title,url:w.uri,dialogTitle:'ارسال فایل اکسل'});
    }else{
      const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([u],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));a.download=name;a.click();
    }
  }catch(e){if(!(e&&/cancel|abort/i.test(String(e.message||e))))toast('ساخت فایل اکسل ممکن نشد',1)}
}
function shareModal(){
  const onOut=(route()[0]==='out');
  const year=route()[1]&&/^\d{4}$/.test(route()[1])?+route()[1]:dY(today());
  modal(`<h3>اشتراک‌گذاری</h3><p class="q" style="font-size:15px">${onOut?'نوع گزارش خروجی را انتخاب کنید.':'محتوای همین صفحه ارسال می‌شود.'}</p>
  ${onOut?`<label>سال موردنظر</label><select id="outShareYear">${allYears().map(y=>`<option value="${y}" ${y===year?'selected':''}>${fa(y)}</option>`).join('')}</select><button class="btn wide cyan" data-a="shYear">${ico('share',20)} اشتراک‌گذاری خروجی سال انتخابی</button><button class="btn wide yellow" data-a="shToday">${ico('share',20)} اشتراک‌گذاری فروش امروز</button>`:''}
  ${curSec()?`<button class="btn wide green" data-a="shXlsx">${ico('xls',20)} ${onOut?'اشتراک‌گذاری اکسل خروجی سال انتخابی':'اشتراک‌گذاری اکسل'}</button>`:''}
  <button class="btn wide cyan" data-a="shMsg">${ico('share',20)} ارسال محتوای همین صفحه</button>
  <button class="btn wide yellow" data-a="shPdf">${ico('pdf',20)} تبدیل به PDF و ارسال</button>
  <button class="btn wide pink" data-a="shCopy">${ico('copy',20)} کپی متن</button>
  <button class="btn wide pink" data-a="close">بستن</button>`);
}
function makePdf(title,lines){
  const W=1240,H=1754,M=80,LH=46,font='Vz,"Noto Sans Arabic",Tahoma,system-ui,sans-serif';
  const pages=[];let cv,cx,y;
  const np=()=>{cv=document.createElement('canvas');cv.width=W;cv.height=H;cx=cv.getContext('2d');cx.fillStyle='#fff';cx.fillRect(0,0,W,H);cx.direction='rtl';cx.textAlign='right';pages.push(cv);y=M+20};
  np();
  cx.fillStyle='#bfb1f5';cx.fillRect(0,0,W,16);
  cx.font='700 40px '+font;cx.fillStyle='#5c4aa8';cx.fillText(title,W-M,y+20);y+=80;
  cx.fillStyle='#3a3550';
  for(const line of lines){
    if(!line){y+=LH*.6;continue}
    cx.font='400 30px '+font;
    const words=line.split(' ');let cur='';const out=[];
    for(const w of words){const t=cur?cur+' '+w:w;if(cx.measureText(t).width>W-2*M&&cur){out.push(cur);cur=w}else cur=t}
    if(cur)out.push(cur);
    for(const o of out){if(y>H-M){np();cx.fillStyle='#3a3550';cx.font='400 30px '+font}cx.fillText(o,W-M,y);y+=LH}
  }
  return pages.map(c=>{const d=atob(c.toDataURL('image/jpeg',.9).split(',')[1]);const b=new Uint8Array(d.length);for(let i=0;i<d.length;i++)b[i]=d.charCodeAt(i);return {w:W,h:H,bytes:b}});
}
function buildPdf(jp){
  const enc=new TextEncoder(),chunks=[],offs=[];let len=0;
  const push=b=>{const u=typeof b==='string'?enc.encode(b):b;chunks.push(u);len+=u.length};
  const obj=(id,fn)=>{offs[id]=len;push(id+' 0 obj\n');fn();push('\nendobj\n')};
  push('%PDF-1.4\n');
  const n=jp.length;
  obj(1,()=>push('<</Type/Catalog/Pages 2 0 R>>'));
  obj(2,()=>push('<</Type/Pages/Kids ['+jp.map((_,i)=>(3+3*i)+' 0 R').join(' ')+']/Count '+n+'>>'));
  jp.forEach((j,i)=>{
    const pg=3+3*i,ct=pg+1,im=pg+2,cs='q 595 0 0 842 0 0 cm /Im0 Do Q';
    obj(pg,()=>push('<</Type/Page/Parent 2 0 R/MediaBox [0 0 595 842]/Resources<</XObject<</Im0 '+im+' 0 R>>>>/Contents '+ct+' 0 R>>'));
    obj(ct,()=>push('<</Length '+cs.length+'>>\nstream\n'+cs+'\nendstream'));
    obj(im,()=>{push('<</Type/XObject/Subtype/Image/Width '+j.w+'/Height '+j.h+'/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length '+j.bytes.length+'>>\nstream\n');push(j.bytes);push('\nendstream')});
  });
  const xs=len,total=3+3*n;
  push('xref\n0 '+total+'\n0000000000 65535 f \n');
  for(let i=1;i<total;i++)push(String(offs[i]).padStart(10,'0')+' 00000 n \n');
  push('trailer\n<</Size '+total+'/Root 1 0 R>>\nstartxref\n'+xs+'\n%%EOF');
  const out=new Uint8Array(len);let p=0;chunks.forEach(c=>{out.set(c,p);p+=c.length});return out;
}
async function doShare(kind,custom){
  const {title,lines}=custom||viewLines(),text=title+'\n'+lines.join('\n');
  const C=window.Capacitor&&window.Capacitor.Plugins;
  closeModal();
  if(kind==='copy'){copyText(text);return}
  if(kind==='msg'){
    try{if(C&&C.Share){await C.Share.share({title,text,dialogTitle:'ارسال با...'});return}if(navigator.share){await navigator.share({title,text});return}}catch(e){if(e&&/cancel|abort/i.test(String(e.message||e)))return}
    copyText(text);toast('اشتراک‌گذاری در دسترس نیست؛ متن کپی شد');return;
  }
  try{
    toast('در حال ساخت PDF...');
    await new Promise(r=>setTimeout(r,50));
    const u=buildPdf(makePdf(title,lines)),name='report-'+Date.now()+'.pdf';
    if(C&&C.Filesystem&&C.Share){
      let b='';for(let i=0;i<u.length;i+=0x8000)b+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));
      const w=await C.Filesystem.writeFile({path:name,data:btoa(b),directory:'CACHE'});
      await C.Share.share({title,url:w.uri,dialogTitle:'ذخیره یا ارسال PDF'});
    }else{
      const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([u],{type:'application/pdf'}));a.download=name;a.click();
    }
  }catch(e){if(!(e&&/cancel|abort/i.test(String(e.message||e))))toast('ساخت PDF ممکن نشد',1)}
}

/* ---------- تخفیف قیمت فروش ---------- */
function vDisc(r){
  const sub=r[1],cid=r[2];
  if(!sub)return discGroups().map(discCard).join('')+`<button class="btn wide cyan" data-a="go" data-h="#/disc/cats">${ico('stock',20)} تخفیف دسته‌بندی‌ها</button><button class="btn wide yellow" data-a="go" data-h="#/disc/items">${ico('pct',20)} تخفیف کالای انتخابی</button>
  <p class="empty">پس از پایان مدت تخفیف، قیمت‌ها خودکار به حالت قبل برمی‌گردد و هر زمان بخواهید می‌توانید تخفیف را حذف کنید.</p>`;
  if(!DB.cats.length)return empty('دسته‌بندی وجود ندارد');
  const cnt=id=>DB.products.filter(p=>p.cat===id).length,dn=id=>DB.products.filter(p=>p.cat===id&&p.disc).length;
  if(sub==='cats')return discGroups(d=>/^cat:/.test(d.key)).map(discCard).join('')+DB.cats.map(c=>`<div class="item" data-a="catDisc" data-id="${c.id}"><div class="grow"><b>${esc(c.name)}</b><small>${fa(cnt(c.id))} کالا${dn(c.id)?' | '+fa(dn(c.id))+' کالا دارای تخفیف':''}</small></div>${ico('pct',22)}</div>`).join('');
  if(sub==='items'&&!cid)return DB.cats.map(c=>`<div class="item" data-a="go" data-h="#/disc/items/${c.id}"><div class="grow"><b>${esc(c.name)}</b><small>${fa(cnt(c.id))} کالا${dn(c.id)?' | '+fa(dn(c.id))+' کالا دارای تخفیف':''}</small></div></div>`).join('');
  const c=cat(cid);if(!c)return empty('دسته‌بندی پیدا نشد');
  const ps=DB.products.filter(p=>p.cat===cid);
  return discGroups(d=>d.key==='sel:'+cid).map(discCard).join('')+(ps.length?`<div class="row"><button class="btn pink" data-a="selAll">انتخاب همه</button><button class="btn yellow" data-a="discSel" data-c="${cid}">${ico('pct',20)} تخفیف انتخابی‌ها</button></div>`+
  ps.map(p=>`<div class="item"><input type="checkbox" class="ck" value="${p.id}"><div class="grow"><b>${esc(p.name)}</b><small>کد: ${esc(fa(p.code))} | فروش: ${p.sell!=null?fmt(p.sell):'—'}${pinfo(p)}</small></div></div>`).join(''):empty('در این دسته‌بندی کالایی نیست'));
}
function discApply(ids,pct,ms,key){
  const gid=uid(),now=Date.now(),end=now+ms;let n=0;
  ids.forEach(id=>{
    const p=prod(id);if(!p||p.sell==null)return;
    const base=p.disc?p.disc.orig:p.sell,price=discRound(base*(1-pct/100));
    if(!(price<base))return;
    setSell(p,price);
    p.disc={gid,key,pct,orig:base,price,end,at:now,by:CFG.user||''};touch(p);n++;
  });
  if(!n){toast('کالایی با قیمت فروش مناسب در این بخش نیست',1);return 0}
  logAct('stock',`تخفیف ${fa(pct)}٪ ${scopeLabel(key)} روی ${fa(n)} کالا تا ${fdt(end)}`);
  save();return n;
}
function discModal(o){
  const b=modal(`<h3>${o.title}</h3><p class="q">${o.label}</p>
  <label>درصد تخفیف</label><input id="dv" inputmode="decimal" placeholder="مثلاً ۱۰" value="${o.pct0!=null?fa(o.pct0):''}">
  <label>مدت تخفیف</label><div class="row"><input id="dn" inputmode="numeric" placeholder="مثلاً ۳"><select id="du"><option value="d">روز</option><option value="h">ساعت</option></select></div>
  <small>بعد از پایان مدت، قیمت‌ها خودکار به حالت قبل برمی‌گردد. قیمت جدید به نزدیک‌ترین ۱۰۰ تومان به بالا رند می‌شود.</small>
  <div class="row"><button class="btn pink" data-a="close">انصراف</button><button class="btn cyan" id="dok">تایید</button></div>`);
  $('#dok',b).onclick=async()=>{
    const v=num($('#dv',b).value),n=num($('#dn',b).value),u=$('#du',b).value;
    if(isNaN(v)||v<=0||v>=100){toast('درصد تخفیف باید بین ۰ تا ۱۰۰ باشد',1);return}
    if(isNaN(n)||n<=0){toast('مدت تخفیف را وارد کنید',1);return}
    const ms=n*(u==='h'?3600000:86400000);
    if(!await ask(`${fa(v)} درصد تخفیف روی ${fa(o.ids.length)} کالا تا ${fdt(Date.now()+ms)} اعمال شود؟ آیا مطمئن هستید؟`))return;
    const k=o.onOk?o.onOk(v,ms):discApply(o.ids,v,ms,o.key);
    if(k){closeModal(b);render(true);toast(`تخفیف روی ${fa(k)} کالا اعمال شد`)}
  };
}

const ACT={
  back(){onBack()},
  share(){shareModal()},
  shMsg(){doShare('msg')},
  shYear(){const y=+$('#outShareYear').value;const a=DB.outs.filter(o=>dY(o.dk)===y).sort((x,z)=>x.dk-z.dk||x.ts-z.ts);const total=a.reduce((v,o)=>v+o.q*o.unit,0);const lines=['سال '+fa(y),'تعداد فروش: '+fa(a.length),'جمع فروش: '+fmt(total)+' تومان','',...a.map(o=>`${dstr(o.dk)} | ${o.name} | ${fa(o.q)} عدد × ${fmt(o.unit)} = ${fmt(o.q*o.unit)} تومان | ${o.cust||'مشتری آزاد'} | ${o.pay==='credit'?'نسیه':'نقد'}`)];closeModal();doShare('msg',{title:'گزارش خروجی سال '+fa(y),lines})},
  shToday(){const t=today(),a=DB.outs.filter(o=>o.dk===t).sort((x,z)=>x.ts-z.ts);const total=a.reduce((v,o)=>v+o.q*o.unit,0);const lines=['فروش امروز — '+dstr(t),'تعداد فروش: '+fa(a.length),'جمع فروش: '+fmt(total)+' تومان','',...a.map(o=>`${o.name} | ${fa(o.q)} عدد × ${fmt(o.unit)} = ${fmt(o.q*o.unit)} تومان | ${o.cust||'مشتری آزاد'} | ${o.pay==='credit'?'نسیه':'نقد'}`)];closeModal();doShare('msg',{title:'گزارش فروش امروز',lines})},
  shPdf(){doShare('pdf')},
  shCopy(){doShare('copy')},
  shXlsx(){const sec=curSec();if(!sec)return;const yr=$('#outShareYear')?+$('#outShareYear').value:0;closeModal();shareXlsx(xlsBuild(sec,{year:yr}))},
  catDisc(d){
    const c=cat(d.id),ids=DB.products.filter(p=>p.cat===d.id).map(p=>p.id);
    if(!ids.length){toast('در این دسته‌بندی کالایی نیست',1);return}
    discModal({ids,key:'cat:'+d.id,title:`تخفیف دسته «${esc(c.name)}»`,label:`تخفیف روی قیمت فروش همه ${fa(ids.length)} کالای این دسته اعمال می‌شود.`});
  },
  discSel(d){
    const ids=[...document.querySelectorAll('.ck:checked')].map(x=>x.value);
    if(!ids.length){toast('ابتدا کالاها را انتخاب کنید',1);return}
    discModal({ids,key:'sel:'+d.c,title:'تخفیف کالاهای انتخابی',label:`${fa(ids.length)} کالای انتخاب‌شده`});
  },
  async discDel(d){
    if(!await ask('این تخفیف حذف شود و قیمت‌ها همین حالا به حالت قبل برگردند؟'))return;
    let n=0;DB.products.filter(p=>p.disc&&p.disc.gid===d.g).forEach(p=>{if(undisc(p))n++});
    logAct('stock',`حذف تخفیف ${fa(n)} کالا؛ قیمت‌ها به حالت قبل برگشت`);save();MD.innerHTML='';render(true);
    toast(`تخفیف ${fa(n)} کالا حذف شد`);
  },
  discEdit(d){
    const ps=DB.products.filter(p=>p.disc&&p.disc.gid===d.g);if(!ps.length)return;
    const g=ps[0].disc,ids=ps.map(p=>p.id);
    discModal({ids,key:g.key,title:'اصلاح تخفیف',label:`${fa(ids.length)} کالا — درصد و مدت جدید از همین لحظه اعمال می‌شود.`,pct0:g.pct,
      onOk:(v,ms)=>{ids.forEach(id=>{const p=prod(id);if(p&&p.disc&&p.disc.gid===d.g)undisc(p)});return discApply(ids,v,ms,g.key)}});
  },
  async discOne(d){
    const p=prod(d.id);if(!p||!p.disc)return;
    if(!await ask('تخفیف این کالا حذف شود و قیمت به حالت قبل برگردد؟'))return;
    undisc(p);logAct('stock',`حذف تخفیف ${p.name}`);save();render(true);toast('تخفیف حذف شد');
  },
  close(d,t){closeModal(t.closest('.box'))},
  go(d){location.hash=d.h},
  open(d){location.hash='#/p/'+d.id},
  openCat(d){location.hash='#/cat/'+d.id},
  copy(d){copyText(d.t)},
  google(d){window.open('https://www.google.com/search?q='+encodeURIComponent(d.t),'_blank')},
  scanSearch(){scan(t=>{S.q=t;$('#sq').value=t;$('#sres').innerHTML=stockBody(t)})},
  goPrice(){location.hash='#/price'},
  catPct(d){
    const c=cat(d.id),ids=DB.products.filter(p=>p.cat===d.id).map(p=>p.id);
    if(!ids.length){toast('در این دسته‌بندی کالایی نیست',1);return}
    pctModal({ids,key:'cat:'+d.id,title:`تغییر قیمت دسته «${esc(c.name)}»`,label:`قیمت فروش همه ${fa(ids.length)} کالای این دسته تغییر می‌کند.`,pre:lastCard('cat:'+d.id,'این دسته')});
  },
  selAll(){const c=[...document.querySelectorAll('.ck')],on=c.some(x=>!x.checked);c.forEach(x=>x.checked=on)},
  pctSel(d){
    const ids=[...document.querySelectorAll('.ck:checked')].map(x=>x.value);
    if(!ids.length){toast('ابتدا کالاها را انتخاب کنید',1);return}
    pctModal({ids,key:'sel:'+d.c,title:'تغییر قیمت کالاهای انتخابی',label:`${fa(ids.length)} کالای انتخاب‌شده`});
  },
  async pctDel(d){
    if(!await ask('آخرین تغییر قیمت حذف شود و قیمت‌ها به حالت قبل برگردند؟'))return;
    const r=revertScope(d.k);if(!r)return;
    logAct('stock',`حذف آخرین تغییر قیمت ${scopeLabel(d.k)}`);save();MD.innerHTML='';render(true);
    toast(`قیمت ${fa(r.n)} کالا برگشت`+(r.sk?` (${fa(r.sk)} کالا بعداً تغییر کرده بود و دست نخورد)`:''));
  },
  pctEdit(d){
    const b=modal(`<h3>اصلاح درصد آخرین تغییر</h3><p class="q">درصد جدید را وارد کنید؛ تغییر قبلی برداشته و درصد جدید اعمال می‌شود.</p><input id="pv" inputmode="decimal" placeholder="مثلاً ۸"><div class="row"><button class="btn pink" data-a="close">انصراف</button><button class="btn cyan" id="pok">تایید</button></div>`);
    $('#pok',b).onclick=async()=>{
      const v=num($('#pv',b).value);
      if(isNaN(v)||v<=-100){toast('درصد نامعتبر است',1);return}
      if(!await ask('درصد آخرین تغییر اصلاح شود؟'))return;
      const r=revertScope(d.k);if(!r||!r.ids.length){toast('کالایی برای اصلاح نیست',1);return}
      pctApply(r.ids,v,d.k);MD.innerHTML='';render(true);toast('درصد اصلاح شد');
    };
  },
  showLog(d){
    const L=DB.log.filter(x=>x.sec===d.s).sort((a,b)=>b.ts-a.ts).slice(0,150);
    modal(`<h3>ثبت فعالیت‌ها — بخش ${SEC[d.s]}</h3>${L.length?L.map(x=>`<div class="lot"><b style="font-weight:500">${esc(x.txt)}</b><small>${esc(x.by)} — ${fdt(x.ts)}</small></div>`).join(''):empty('هنوز فعالیتی ثبت نشده')}<button class="btn wide pink" data-a="close" style="margin-top:10px">بستن</button>`);
  },
  exitP(d){
    const p=prod(d.id),st=stock(d.id);
    const b=modal(`<h3>خروج کالا</h3><b>${esc(p.name)}</b><small>موجودی: ${fa(st)} عدد</small>
    <label>تعداد خروج</label><input id="eq" inputmode="numeric" value="1">
    <label>قیمت نهایی فروش (هر عدد - تومان)</label><input class="money" id="ep" inputmode="numeric" value="${p.sell!=null?nf(p.sell):''}">
    <label>تاریخ خروج</label><input id="ed" inputmode="numeric" value="${dstr(today())}">
    <label>نام و نام خانوادگی مشتری</label><input id="ec" value="مشتری آزاد">
    <label>نوع پرداخت</label><div class="row"><button class="btn cyan" data-p="cash">نقد</button><button class="btn pink" data-p="credit">نسیه</button></div>
    <div class="row"><button class="btn pink" data-a="close">انصراف</button><button class="btn cyan" id="eok">تایید</button></div>`);
    b._pay='cash';
    b.querySelectorAll('[data-p]').forEach(x=>x.onclick=()=>{b._pay=x.dataset.p;b.querySelectorAll('[data-p]').forEach(y=>{y.classList.toggle('cyan',y===x);y.classList.toggle('pink',y!==x)})});
    $('#eok',b).onclick=()=>{
      const q=num($('#eq',b).value),u=num($('#ep',b).value),dk=parseD($('#ed',b).value);
      if(!(q>0)||!Number.isInteger(q)||q>st){toast('تعداد خروج نامعتبر است',1);return}
      if(isNaN(u)||u<0){toast('قیمت فروش را وارد کنید',1);return}
      if(!dk){toast('تاریخ را مثل ۱۴۰۵/۰۸/۰۱ وارد کنید',1);return}
      const cust=$('#ec',b).value.trim()||'مشتری آزاد';
      DB.outs.push(touch({id:uid(),pid:d.id,name:p.name,code:p.code,cat:cat(p.cat)?cat(p.cat).name:'',q,unit:u,cost:0,dk,ts:Date.now(),cust,pay:b._pay,by:CFG.user||''}));
      logAct('out',`خروج ${fa(q)} عدد ${p.name} — مشتری: ${cust} (${b._pay==='credit'?'نسیه':'نقد'})`);
      save();closeModal(b);render();toast('کالا به بخش خروجی رفت');
    };
  },
  editSell(d){
    const p=prod(d.id);
    const b=modal(`<h3>اصلاح قیمت فروش</h3><b>${esc(p.name)}</b><label>قیمت فروش جدید (تومان)</label><input class="money" id="np" inputmode="numeric" value="${nf(p.sell)}">
    <div class="row"><button class="btn pink" data-a="close">انصراف</button><button class="btn cyan" id="nok">تایید</button></div>`);
    $('#nok',b).onclick=async()=>{
      const v=num($('#np',b).value);
      if(isNaN(v)||v<0){toast('قیمت نامعتبر است',1);return}
      if(!await ask('آیا از تغییر قیمت مطمئن هستید؟'))return;
      const old=p.sell;setSell(p,v);logAct('stock',`اصلاح قیمت فروش ${p.name}: ${fmt(old)} ← ${fmt(v)}`);save();closeModal(b);render();toast('قیمت فروش تغییر کرد');
    };
  },
  returnP(d){
    const p=prod(d.id),st=stock(d.id);if(!p||st<=0)return;
    const b=modal(`<h3>مرجوع کردن کالا</h3><b>${esc(p.name)}</b><small>موجودی فعلی: ${fa(st)} عدد</small><label>تعداد مرجوعی</label><input id="retq" inputmode="numeric" value="1"><label>توضیحات مرجوعی</label><textarea id="retnote" placeholder="علت یا توضیحات مرجوعی"></textarea><div class="row"><button class="btn pink" data-a="close">انصراف</button><button class="btn cyan" id="retok">تایید مرجوعی</button></div>`);
    $('#retok',b).onclick=async()=>{const q=num($('#retq',b).value),note=$('#retnote',b).value.trim();if(!Number.isInteger(q)||q<=0||q>stock(p.id)){toast('تعداد مرجوعی نامعتبر است',1);return}if(!note){toast('توضیحات مرجوعی را وارد کنید',1);return}if(!await ask(`${fa(q)} عدد از «${p.name}» به بخش مرجوعی منتقل شود؟`))return;DB.returns.push(touch({id:uid(),pid:p.id,name:p.name,code:p.code,qty:q,note,status:'pending',ts:Date.now()}));logAct('stock',`مرجوعی ${fa(q)} عدد ${p.name}`);save();closeModal(b);location.hash='#/returns';toast('کالا به بخش مرجوعی منتقل شد')};
  },
  async resolveReturn(d){
    const r=(DB.returns||[]).find(x=>x.id===d.id);if(!r||r.status!=='pending')return;
    const restore=d.mode==='restore',title=restore?'بازگشت به موجودی':'حذف کالا';
    const b=modal(`<h3>${title}</h3><b>${esc(r.name)} — ${fa(r.qty)} عدد</b><label>توضیحات اقدام</label><textarea id="raction" placeholder="توضیح درباره ${title}"></textarea><div class="row"><button class="btn pink" data-a="close">انصراف</button><button class="btn cyan" id="ractionok">تایید</button></div>`);
    $('#ractionok',b).onclick=async()=>{const note=$('#raction',b).value.trim();if(!note){toast('توضیحات را وارد کنید',1);return}if(!await ask(`اقدام «${title}» برای ${r.name} انجام شود؟`))return;r.status=restore?'restored':'deleted';r.actionNote=note;r.actionAt=Date.now();touch(r);logAct('returns',`${title}: ${r.name} (${fa(r.qty)} عدد) — ${note}`);save();closeModal(b);render();toast('وضعیت مرجوعی ثبت شد')};
  },
  excelTemplate(d){
    const incoming=d.kind==='incoming';const head=incoming?['دسته‌بندی','کد کالا','بارکد کالا','نام کالا','شماره فاکتور','تاریخ ورود (شمسی)','تعداد','قیمت خرید','قیمت فروش','خرید از پخش']:['دسته‌بندی','کد کالا','بارکد کالا','نام کالا'];
    const sample=incoming?[['لوازم جانبی','1001','626000000001','کابل شارژ','F-100','۱۴۰۵/۰۸/۱۴',10,120000,180000,'پخش نمونه']]:[['لوازم جانبی','1001','626000000001','کابل شارژ']];
    const x=makeXlsx(incoming?'ورود کالا':'تعریف کالا',head,sample,incoming?[22,14,22,34,18,20,12,16,16,22]:[22,14,22,34],'FF278F9F');
    const blob=new Blob([x],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=incoming?'قالب-ورود-کالا.xlsx':'قالب-تعریف-کالا.xlsx';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('قالب استاندارد اکسل دانلود شد');
  },
    newInv(){
    const b=modal(`<h3>افزودن فاکتور</h3><label>شماره فاکتور</label><input id="inum" inputmode="numeric"><label>خرید از پخش</label><input id="isupplier" placeholder="نام پخش یا تأمین‌کننده"><label>تاریخ ورود</label><input id="idate" inputmode="numeric" value="${dstr(today())}">
    <div class="row"><button class="btn pink" data-a="close">انصراف</button><button class="btn cyan" id="iok">ادامه</button></div>`);
    $('#iok',b).onclick=()=>{
      const n=digits($('#inum',b).value).trim(),dk=parseD($('#idate',b).value);
      if(!n){toast('شماره فاکتور را وارد کنید',1);return}
      if(!dk){toast('تاریخ را مثل ۱۴۰۵/۰۸/۰۱ وارد کنید',1);return}
      S.draft={num:n,dk,supplier:$('#isupplier',b).value.trim(),items:[]};closeModal(b);location.hash='#/in/new';
    };
  },
  editHead(){
    const d=S.draft;
    const b=modal(`<h3>شماره و تاریخ فاکتور</h3><label>شماره فاکتور</label><input id="inum" inputmode="numeric" value="${esc(d.num)}"><label>خرید از پخش</label><input id="isupplier" value="${esc(d.supplier||'')}"><label>تاریخ ورود</label><input id="idate" inputmode="numeric" value="${dstr(d.dk)}">
    <div class="row"><button class="btn pink" data-a="close">انصراف</button><button class="btn cyan" id="iok">تایید</button></div>`);
    $('#iok',b).onclick=()=>{
      const n=digits($('#inum',b).value).trim(),dk=parseD($('#idate',b).value);
      if(!n||!dk){toast('شماره یا تاریخ نامعتبر است',1);return}
      d.num=n;d.dk=dk;d.supplier=$('#isupplier',b).value.trim();closeModal(b);render();
    };
  },
  invView(d){
    const v=DB.invoices.find(x=>x.id===d.id);if(!v)return;
    const lots=DB.lots.filter(l=>l.invId===v.id);recompute();const canDelete=lots.every(l=>l.rem===l.qty);
    modal(`<h3>فاکتور ${esc(fa(v.num))}</h3><small>${dstr(v.dk)}${v.supplier?' | خرید از پخش: '+esc(v.supplier):''}</small>`+v.items.map(i=>`<div class="item"><div class="grow"><b>${esc(i.name)}</b><small>${fa(i.qty)} عدد | خرید ${fmt(i.buy)} | فروش ${fmt(i.sell)}</small></div></div>`).join('')+`<button class="btn wide cyan" data-a="editInv" data-id="${v.id}">${ico('edit',20)} اصلاح فاکتور</button>${canDelete?`<button class="btn pink wide" data-a="delInvoice" data-id="${v.id}">${ico('trash',20)} حذف فاکتور (بدون خروجی)</button>`:`<small class="delete-hint">به دلیل ثبت خروج کالا از این فاکتور، امکان حذف آن وجود ندارد.</small>`}<button class="btn pink wide" data-a="close">بستن</button>`);
  },
  async delInvoice(d,t){
    const v=DB.invoices.find(x=>x.id===d.id);if(!v)return;recompute();
    const lots=DB.lots.filter(l=>l.invId===v.id);
    if(lots.some(l=>l.rem!==l.qty)){toast('از این فاکتور خروج ثبت شده و حذف آن ممکن نیست',1);return}
    if(!await ask(`فاکتور ${fa(v.num)} و اطلاعات ورودی آن حذف شود؟ این عملیات قابل بازگشت نیست.`))return;
    const imgs=DB.imgs.filter(x=>x.inv===v.id);for(const im of imgs){try{await idb.del(im.id)}catch(e){}del('imgs',im.id)}
    lots.forEach(l=>del('lots',l.id));del('invoices',v.id);logAct('in',`حذف فاکتور ${fa(v.num)} (بدون خروجی)`);save();MD.innerHTML='';render();toast('فاکتور حذف شد');
  },
  editInv(d,t){
    const v=DB.invoices.find(x=>x.id===d.id);if(!v)return;
    S.draft={edit:v.id,num:v.num,dk:v.dk,supplier:v.supplier||'',items:v.items.map(i=>Object.assign({},i))};
    closeModal(t.closest('.box'));location.hash='#/in/new';
  },
  addItem(){
    modal(`<h3>اضافه کردن کالا</h3><div class="sbar"><input id="aq" placeholder="نام کالا یا کد کالا"><button class="ic" data-a="scanAdd">${ico('scan')}</button></div><div id="ares"></div><button class="btn pink wide" data-a="close">بستن</button>`);
    $('#aq').focus();
  },
  scanAdd(){
    scan(t=>{
      $('#aq').value=t;fillA();
      const ex=DB.products.filter(p=>p.barcode&&norm(p.barcode)===norm(t));
      if(ex.length===1)ACT.pickItem({id:ex[0].id},$('#aq'));
      else if(!findP(t).length)toast('کالایی با این بارکد تعریف نشده',1);
    });
  },
  pickItem(d,t){
    const p=prod(d.id),L=lotsOf(d.id).sort(byNew);
    itemForm(t.closest('.box'),p,{qty:1,buy:L.length?L[0].buy:'',sell:p.sell!=null?p.sell:''},
      (q,b,s)=>S.draft.items.push({pid:d.id,name:p.name,qty:q,buy:b,sell:s}));
  },
  editItem(d){
    const i=S.draft.items[+d.i],p=prod(i.pid)||{name:i.name,code:''};
    const b=modal('');
    itemForm(b,p,{qty:i.qty,buy:i.buy,sell:i.sell},(q,bb,s)=>{i.qty=q;i.buy=bb;i.sell=s});
  },
  delItem(d){S.draft.items.splice(+d.i,1);render()},
  async cancelInv(){if(await ask(S.draft.edit?'از اصلاح فاکتور انصراف می‌دهید؟':'فاکتور لغو شود؟ اطلاعات واردشده حذف می‌شود.')){S.draft=null;location.hash='#/in'}},
  async commitInv(){
    const d=S.draft;
    if(!d.items.length){toast('ابتدا کالا اضافه کنید',1);return}
    if(!await ask(d.edit?'آیا از اصلاح فاکتور مطمئن هستید؟':'آیا از ورود فاکتور مطمئن هستید؟'))return;
    if(!d.edit){
      const id=uid(),ts=Date.now(),items=d.items.map(i=>Object.assign({},i,{lotId:uid()}));
      DB.invoices.push(touch({id,num:d.num,dk:d.dk,supplier:d.supplier||'',ts,items,by:CFG.user||''}));
      items.forEach(i=>{
        DB.lots.push(touch({id:i.lotId,pid:i.pid,invId:id,inv:d.num,dk:d.dk,ts,qty:i.qty,rem:i.qty,buy:i.buy,sell:i.sell}));
        const p=prod(i.pid);if(p)setSell(p,i.sell);
      });
      logAct('in',`ثبت فاکتور ${fa(d.num)} با ${fa(items.length)} قلم`);
      save();S.draft=null;toast('فاکتور وارد شد');location.hash='#/in';return;
    }
    const v=DB.invoices.find(x=>x.id===d.edit);
    const keep=new Set(d.items.filter(i=>i.lotId).map(i=>i.lotId));
    const mine=DB.lots.filter(l=>l.invId===v.id);
    const pids=new Set([...mine.map(l=>l.pid),...d.items.map(i=>i.pid)]);
    for(const pid of pids){
      const others=DB.lots.filter(l=>l.pid===pid&&l.invId!==v.id).reduce((s,l)=>s+l.qty,0);
      const mineQ=d.items.filter(i=>i.pid===pid).reduce((s,i)=>s+i.qty,0);
      const outQ=DB.outs.filter(o=>o.pid===pid).reduce((s,o)=>s+o.q,0);
      if(others+mineQ<outQ){const p=prod(pid);toast(`تعداد «${p?p.name:''}» کمتر از تعداد خروج‌شده می‌شود؛ این تغییر ممکن نیست`,1);return}
    }
    mine.filter(l=>!keep.has(l.id)).forEach(l=>del('lots',l.id));
    d.items.forEach(i=>{
      const l=i.lotId&&DB.lots.find(x=>x.id===i.lotId);
      if(l){l.qty=i.qty;l.buy=i.buy;l.sell=i.sell;l.dk=d.dk;l.inv=d.num;touch(l)}
      else{i.lotId=uid();DB.lots.push(touch({id:i.lotId,pid:i.pid,invId:v.id,inv:d.num,dk:d.dk,ts:v.ts,qty:i.qty,rem:i.qty,buy:i.buy,sell:i.sell}))}
    });
    v.num=d.num;v.dk=d.dk;v.supplier=d.supplier||'';v.items=d.items.map(i=>Object.assign({},i));touch(v);
    logAct('in',`اصلاح فاکتور ${fa(d.num)}`);
    save();S.draft=null;toast('فاکتور اصلاح شد');location.hash='#/in';
  },
  addCat(){
    const n=$('#ncat').value.trim();
    if(!n){toast('نام دسته‌بندی را وارد کنید',1);return}
    if(DB.cats.some(c=>norm(c.name)===norm(n))){toast('این دسته‌بندی وجود دارد',1);return}
    const c=touch({id:uid(),name:n});DB.cats.push(c);logAct('def',`افزودن دسته‌بندی ${n}`);S.defCat=c.id;S.editPid=null;save();render();
  },
  delCats(){delCatsModal()},
  toggleCats(){S.catsOpen=!S.catsOpen;render(true)},
  async delCat(d){
    const ps=DB.products.filter(p=>p.cat===d.id);
    if(ps.some(p=>stock(p.id)>0)){toast('این دسته‌بندی موجودی دارد و قابل حذف نیست',1);return}
    if(!await ask(`دسته‌بندی «${esc(cat(d.id).name)}»${ps.length?' و '+fa(ps.length)+' کالای بدون موجودی آن':''} حذف شود؟`))return;
    const cn=cat(d.id).name;ps.forEach(p=>del('products',p.id));del('cats',d.id);logAct('def',`حذف دسته‌بندی ${cn}`);
    if(S.defCat===d.id)S.defCat=null;
    save();closeModal();delCatsModal();render();
  },
  autoCode(){$('#fcode').value=nextCode()},
  scanBar(){scan(t=>{$('#fbar').value=t})},
  saveProd(){
    const code=digits($('#fcode').value).trim(),bar=digits($('#fbar').value).trim(),name=$('#fname').value.trim();
    if(!code||!name){toast('کد و نام کالا الزامی است',1);return}
    const me=S.editPid;
    if(DB.products.some(p=>p.id!==me&&norm(p.code)===norm(code))){toast('این کد قبلاً استفاده شده',1);return}
    if(bar&&DB.products.some(p=>p.id!==me&&p.barcode&&norm(p.barcode)===norm(bar))){toast('این بارکد قبلاً استفاده شده',1);return}
    if(me){const p=prod(me);p.code=code;p.barcode=bar;p.name=name;touch(p);logAct('def',`ویرایش کالا ${name}`);toast('تغییرات ذخیره شد')}
    else{DB.products.push(touch({id:uid(),cat:S.defCat,code,barcode:bar,name,sell:null,sellHist:[]}));logAct('def',`تعریف کالا ${name} (کد ${code})`);toast('کالا ثبت شد')}
    S.editPid=null;save();render();
  },
  editProd(d){const p=prod(d.id);S.editPid=d.id;S.defCat=p.cat;render()},
  cancelEdit(){S.editPid=null;render()},
  async delProd(d){
    if(stock(d.id)>0){toast('این کالا موجودی دارد و قابل حذف نیست',1);return}
    if(!await ask('این کالا حذف شود؟'))return;
    const pn=(prod(d.id)||{}).name;del('products',d.id);logAct('def',`حذف کالا ${pn}`);save();render();
  },
  async undoOut(d){
    if(!await ask('این خروج لغو شود و کالا به موجودی برگردد؟'))return;
    const o=DB.outs.find(x=>x.id===d.id);del('outs',d.id);logAct('out',`لغو خروج ${o?fa(o.q)+' عدد '+o.name:''}`);save();render();toast('خروج لغو شد');
  },
  rtab(d){S.rt=d.k;render()},
  rrange(){S.rf=$('#rf').value;S.rto=$('#rto').value;if(!parseD(S.rf)||!parseD(S.rto))toast('تاریخ‌ها را مثل ۱۴۰۵/۰۸/۰۱ وارد کنید',1);render()},
  photos(d){photosModal(d.id)},
  async viewImg(d){
    const data=await idb.get(d.id);
    const b=modal(`${data?`<img class="full" src="${data}" alt="">`:empty('این عکس هنوز از سرور دریافت نشده')}${data?`<button class="btn wide cyan" id="simg">${ico('img',20)} ذخیره در گالری</button>`:''}<div class="row"><button class="btn pink" data-a="close">بستن</button><button class="btn pink" id="dimg">${ico('trash',20)} حذف عکس</button></div>`);
    if(data)$('#simg',b).onclick=()=>saveToGallery(data,'invoice-'+d.id);
    $('#dimg',b).onclick=async()=>{
      if(!await ask('این عکس حذف شود؟'))return;
      del('imgs',d.id);logAct('rep','حذف عکس فاکتور');try{await idb.del(d.id)}catch(e){}save();closeModal(b);closeModal();photosModal(d.inv);render(true);
    };
  },
  settings(){
    modal(`<img class="logo-s" src="logo.png" alt=""><h3 style="text-align:center">تنظیمات</h3>
    <h5>اتصال به سرور</h5>
    <p class="q" style="font-size:14px;margin:0">با اتصال به سرور، همکاران شما هم با همین اطلاعات به‌صورت آنلاین کار می‌کنند.</p>
    <label>آدرس سرور</label><input id="cu" dir="ltr" placeholder="http://123.45.67.89:3100" value="${esc(CFG.url)}">
    <label>کلید دسترسی</label><input id="ck" dir="ltr" value="${esc(CFG.key)}">
    <label>نام شما (برای ثبت در خروجی‌ها)</label><input id="cn" value="${esc(CFG.user)}">
    <div class="row"><button class="btn pink" data-a="disc">قطع اتصال</button><button class="btn cyan" data-a="conn">${ico('cloud',20)} ذخیره و اتصال</button></div>
    <h5>پشتیبان‌گیری</h5>
    <button class="btn wide pink" data-a="doExport">گرفتن فایل پشتیبان</button>
    <label class="btn wide pink">بازیابی از فایل پشتیبان<input type="file" id="ifile" accept=".json,application/json" style="display:none"></label>
    <button class="btn wide cyan" data-a="close" style="margin-top:12px">بستن</button>`);
  },
  conn(d,t){
    const b=t.closest('.box');
    CFG={url:normUrl($('#cu',b).value),key:$('#ck',b).value.trim(),user:$('#cn',b).value.trim()};
    localStorage.setItem(CK,JSON.stringify(CFG));
    if(!CFG.url||!CFG.key){toast('آدرس سرور و کلید دسترسی را وارد کنید',1);return}
    syncNow(true);
  },
  disc(d,t){
    CFG.url='';CFG.key='';localStorage.setItem(CK,JSON.stringify(CFG));
    setSt('off');closeModal(t.closest('.box'));toast('اتصال قطع شد؛ اطلاعات روی همین گوشی باقی می‌ماند');
  },
  doExport(){exportData()}
};
document.addEventListener('click',e=>{
  const t=e.target.closest('[data-a]');if(!t)return;
  const f=ACT[t.dataset.a];if(f)f(t.dataset,t,e);
});
document.addEventListener('input',e=>{
  const el=e.target,id=el.id;
  if(el.classList.contains('money')){const r=en(el.value).replace(/[^\d]/g,'');el.value=r?Number(r).toLocaleString('en-US'):''}
  else if(id==='sq'){S.q=el.value;$('#sres').innerHTML=stockBody(S.q)}
  else if(id==='aq')fillA();
  else if(id==='invq'){S.iq=el.value;$('#invlist').innerHTML=invRows(S.iq)}
  else if(id==='photq'){S.pq=el.value;$('#photlist').innerHTML=photRows(S.pq)}
});
document.addEventListener('change',async e=>{
  const el=e.target,id=el.id;
  if(id==='ry'){S.ry=+el.value;render()}
  else if(id==='rm'){S.rm=+el.value;render()}
  else if(id==='fc'){S.defCat=el.value;S.editPid=null;render()}
  else if(id==='ifile'){importFile(el.files[0])}
  else if(el.dataset.excel&&el.files[0]){await importExcelCSV(el.files[0],el.dataset.excel);el.value=''}
  else if(id==='pfile'){
    const inv=el.dataset.inv,files=[...el.files];
    await addPhotos(files,inv);closeModal(el.closest('.box'));photosModal(inv);render(true);
  }
});
window.addEventListener('hashchange',()=>render());

/* ================= شروع ================= */
$('#nav').innerHTML=[['def','تعریف'],['in','ورود'],['stock','موجودی'],['out','خروجی'],['returns','مرجوعی'],['rep','گزارش']].map(([k,t])=>`<a href="#/${k}" data-t="${k}">${ico(k)}${t}</a>`).join('');
$('#setb').innerHTML=ico('set')+'<span class="sd" id="sd"></span>';
$('#shb').innerHTML=ico('share');
try{const A=window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.App;if(A&&A.addListener)A.addListener('backButton',()=>onBack())}catch(e){}
try{
  const C=window.Capacitor&&window.Capacitor.Plugins;
  if(C&&C.StatusBar){C.StatusBar.setBackgroundColor({color:'#ffd66b'});C.StatusBar.setStyle({style:'LIGHT'})}
}catch(e){}
expireDiscs();
render();
if(CFG.url){setSt('busy');syncNow()}
})();
