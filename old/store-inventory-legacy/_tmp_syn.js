const fs=require('fs'),cp=require('child_process');
const f='熊猫五福餐厅进销存系统_真实数据版.html';
const s=fs.readFileSync(f,'utf8');
const re=/<script\b[^>]*>([\s\S]*?)<\/script>/g;
let m,parts=[];
while((m=re.exec(s)))parts.push(m[1]);
console.log('script blocks:',parts.length);
parts.forEach((p,i)=>{
  const out='_tmp_blk'+i+'.js';
  fs.writeFileSync(out,p);
  try{cp.execSync('node --check '+out,{stdio:'pipe'});console.log('block',i,'OK',p.split('\n').length,'lines');}
  catch(e){console.log('block',i,'SYNTAX ERROR:\n'+String(e.stderr||e.stdout||e));}
});
