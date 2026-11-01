// 保存した数字の検算：損益は各段がつながるか、貸借対照表は両側が総資産に一致するか
const fs=require('fs'),path=require('path');
const dir=path.join(__dirname,'..','data','companies');
let docs=0,plOK=0,bsOK=0,plNG=[],bsNG=[],bad=[];
for(const f of fs.readdirSync(dir)){const co=JSON.parse(fs.readFileSync(path.join(dir,f)));
 for(const d of co.docs){docs++;
  if(d.pl.ok){plOK++;const c=d.pl.cur,t=d.pl.unit.div*3;
    const ok=Math.abs(c.op+c.nonop+c.sp-c.tax-c.ni)<=t && Math.abs((c.gp??c.rev)-c.sga-c.op)<=t;
    if(!ok) bad.push(co.code+' PL');} else plNG.push(co.code+' '+d.pl.reason);
  if(d.bs.ok){bsOK++;const a=d.bs.assets.reduce((s,x)=>s+x.v,0),r=d.bs.right.reduce((s,x)=>s+x.v,0),t=d.bs.unit.div*3;
    if(Math.abs(a-d.bs.total)>t||Math.abs(r-d.bs.total)>t) bad.push(co.code+' BS');} else bsNG.push(co.code+' '+d.bs.reason);
  if(!d.fye||!d.q) bad.push(co.code+' 期不明');
 }}
const cnt=a=>a.reduce((m,x)=>{const k=x.replace(/^\S+ /,'');m[k]=(m[k]||0)+1;return m;},{});
console.log({docs,plOK,bsOK,mismatch:bad.length});console.log('PL描けず',cnt(plNG));console.log('BS描けず',cnt(bsNG));console.log(bad.slice(0,20));
