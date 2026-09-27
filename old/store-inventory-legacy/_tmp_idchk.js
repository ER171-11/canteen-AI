/* 静态检查：HTML 中声明的 id vs JS 中引用的 id（含动态生成的 modal 内 id 白名单） */
const fs=require('fs');
const f='熊猫五福餐厅进销存系统_真实数据版.html';
const s=fs.readFileSync(f,'utf8');
const htmlIds=new Set();
const re1=/\sid="([^"]+)"/g;let m;
while((m=re1.exec(s)))htmlIds.add(m[1]);
/* 模板字符串里动态生成的 id */
const re2=/id="([A-Za-z][A-Za-z0-9_-]*)"/g;
while((m=re2.exec(s)))htmlIds.add(m[1]);
const re3=/id=\\?"([A-Za-z][A-Za-z0-9_-]*)\\?"/g;
while((m=re3.exec(s)))htmlIds.add(m[1]);
const refs=new Map();
const add=(id,line)=>{if(!refs.has(id))refs.set(id,line);};
const lines=s.split(/\r?\n/);
const dynamic=new Set();
lines.forEach((ln,i)=>{
  let mm;
  const r1=/\$\('#([A-Za-z0-9_-]+)'\)/g;while((mm=r1.exec(ln)))add(mm[1],i+1);
  const r2=/getElementById\('([A-Za-z0-9_-]+)'\)/g;while((mm=r2.exec(ln)))add(mm[1],i+1);
  const r3=/querySelector\('#([A-Za-z0-9_-]+)'\)/g;while((mm=r3.exec(ln)))add(mm[1],i+1);
  /* 动态模板里声明的 id 视为存在 */
  const r4=/id="([A-Za-z][A-Za-z0-9_-]*)"/g;while((mm=r4.exec(ln)))dynamic.add(mm[1]);
  const r5=/id='([A-Za-z][A-Za-z0-9_-]*)'/g;while((mm=r5.exec(ln)))dynamic.add(mm[1]);
  const r6=/#\{?'?([A-Za-z][A-Za-z0-9_-]{3,})/g;
});
const missing=[...refs].filter(([id])=>!htmlIds.has(id)&&!dynamic.has(id));
console.log('HTML 声明 id 数:',htmlIds.size,'| 模板动态 id 数:',dynamic.size,'| JS 引用 id 数:',refs.size);
console.log('引用但未声明:',missing.length?missing.map(([id,l])=>id+' @'+l).join(', '):'无');
/* 重复 id */
const cnt={};
const r7=/\sid="([^"]+)"/g;
const body=s.replace(/<script[\s\S]*?<\/script>/g,'');
while((m=r7.exec(body)))cnt[m[1]]=(cnt[m[1]]||0)+1;
const dup=Object.keys(cnt).filter(k=>cnt[k]>1);
console.log('静态重复 id:',dup.length?dup.join(', '):'无');
