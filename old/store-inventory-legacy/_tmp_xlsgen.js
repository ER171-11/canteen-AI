/* 生成「真二进制 .xls」回归样本 + 抽取主文件解析器做实测 */
const fs=require('fs');
const HTML='熊猫五福餐厅进销存系统_真实数据版.html';
const DIR='_tmp_xls_samples';

/* ---------- BIFF 基础构造 ---------- */
const u8=n=>{const b=Buffer.alloc(1);b.writeUInt8(n&0xff,0);return b;};
const u16=n=>{const b=Buffer.alloc(2);b.writeUInt16LE(n>>>0,0);return b;};
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n>>>0,0);return b;};
const dbl=n=>{const b=Buffer.alloc(8);b.writeDoubleLE(n,0);return b;};
const rec=(id,data)=>Buffer.concat([u16(id),u16(data.length),Buffer.from(data)]);
const uni=s=>{const b=Buffer.alloc(s.length*2);for(let i=0;i<s.length;i++)b.writeUInt16LE(s.charCodeAt(i),i*2);return b;};
const mbs=s=>{const b=Buffer.alloc(s.length);for(let i=0;i<s.length;i++)b.writeUInt8(s.charCodeAt(i)&0xff,i);return b;};
/* Excel 日期序列号（1900 日期系统） */
const serial=(y,m,d)=>Math.round((Date.UTC(y,m-1,d)-Date.UTC(1899,11,30))/86400000);
/* XLUnicodeRichExtendedString */
const sstEntry=(s,wide)=>Buffer.concat([u16(s.length),u8(wide?1:0),wide?uni(s):mbs(s)]);

/* ---------- OLE2(CFB) 容器 ---------- */
function buildOle(wb,name){
  const SSZ=512,MSSZ=64;
  const nMini=Math.ceil(wb.length/MSSZ);     /* mini 扇区数 */
  const nMiniSec=Math.ceil(nMini*MSSZ/SSZ);  /* mini 流占用的常规扇区数 */
  const miniPadded=nMiniSec*SSZ;             /* 按整扇区补齐，避免尾部被截断 */
  const miniStart=3, dirStart=2, miniFatStart=1, fatStart=0;
  /* 扇区布局：0=FAT 1=MiniFAT 2=Directory 3..=mini 流 */
  const miniBlob=Buffer.alloc(miniPadded);wb.copy(miniBlob);
  const fat=[0xFFFFFFFD,0xFFFFFFFD,0xFFFFFFFD];
  for(let i=0;i<nMiniSec;i++)fat.push(miniStart+i+(i===nMiniSec-1?0:1));
  fat[fat.length-1]=0xFFFFFFFE;
  while(fat.length<SSZ/4)fat.push(0xFFFFFFFF);
  const fatSec=Buffer.alloc(SSZ);
  fat.forEach((v,i)=>fatSec.writeUInt32LE(v>>>0,i*4));
  const mfat=[];for(let i=0;i<nMini;i++)mfat.push(i+1);
  if(mfat.length)mfat[mfat.length-1]=0xFFFFFFFE;
  while(mfat.length<SSZ/4)mfat.push(0xFFFFFFFF);
  const mfatSec=Buffer.alloc(SSZ);
  mfat.forEach((v,i)=>mfatSec.writeUInt32LE(v>>>0,i*4));
  const dirEnt=(nm,type,start,size,child)=>{
    const e=Buffer.alloc(128);
    const u=uni(nm);u.copy(e,0);
    e.writeUInt16LE((nm.length+1)*2,64);
    e.writeUInt8(type,66);e.writeUInt8(1,67);            /* 类型 + 节点色 */
    e.writeInt32LE(-1,68);e.writeInt32LE(-1,72);e.writeInt32LE(child==null?-1:child,76);
    e.writeUInt32LE(start>>>0,116);e.writeUInt32LE(size>>>0,120);
    return e;
  };
  const dirSec=Buffer.alloc(SSZ);
  dirEnt('Root Entry',5,miniStart,miniPadded,1).copy(dirSec,0);
  dirEnt(name,2,0,wb.length).copy(dirSec,128);
  const hdr=Buffer.alloc(512);
  Buffer.from([0xD0,0xCF,0x11,0xE0,0xA1,0xB1,0x1A,0xE1]).copy(hdr,0);
  hdr.writeUInt16LE(0x003E,24);hdr.writeUInt16LE(0x0003,26);hdr.writeUInt16LE(0xFFFE,28);
  hdr.writeUInt16LE(9,30);hdr.writeUInt16LE(6,32);          /* 扇区 512 / mini 64 */
  hdr.writeUInt32LE(0,40);hdr.writeUInt32LE(1,44);hdr.writeUInt32LE(dirStart,48);
  hdr.writeUInt32LE(0x1000,56);                             /* mini cutoff 4096 */
  hdr.writeUInt32LE(miniFatStart,60);hdr.writeUInt32LE(1,64);
  hdr.writeUInt32LE(0xFFFFFFFE,68);hdr.writeUInt32LE(0,72);
  for(let i=0;i<109;i++)hdr.writeUInt32LE(i===0?fatStart:0xFFFFFFFF,76+i*4);
  return Buffer.concat([hdr,fatSec,mfatSec,dirSec,miniBlob]);
}

/* ---------- 工作簿构造（BIFF8） ---------- */
function xfRec(ifmt){const b=Buffer.alloc(20);b.writeUInt16LE(0,0);b.writeUInt16LE(ifmt,2);return b;}
/* enc: 0=UTF-16LE，1=压缩单字节 */
function bounds(name,pos,enc){return rec(0x0085,Buffer.concat([u32(pos),u16(0),u8(name.length),u8(enc?1:0),enc?mbs(name):uni(name)]));}
function buildWb8(strings,sheets,opt){
  opt=opt||{};
  const bofs=[];
  let glob=Buffer.concat([
    rec(0x0809,Buffer.concat([u16(0x0600),u16(0x0000),u32(0),u32(0),u32(0),u32(0x00C1),u32(0x06)])),
    rec(0x0042,u16(1200)),                                  /* CODEPAGE = UTF-16 */
    rec(0x041E,Buffer.concat([u16(164),u16(10),u8(0),uni('yyyy-mm-dd')]))   /* 自定义日期格式 */
  ]);
  for(let i=0;i<16;i++)glob=Buffer.concat([glob,rec(0x00E0,xfRec(i===15?164:0))]);   /* XF[15] 为日期格式 */
  /* SST：可切成多个 CONTINUE */
  const total=strings.length;
  const body=Buffer.concat(strings.map(s=>sstEntry(s,true)));
  const cut=opt.sstCut||body.length;
  let sstRec=rec(0x00FC,Buffer.concat([u32(total),u32(total),body.slice(0,cut)]));
  for(let p=cut;p<body.length;p+=(opt.contSize||32)){
    const chunk=body.slice(p,Math.min(p+(opt.contSize||32),body.length));
    sstRec=Buffer.concat([sstRec,rec(0x003C,Buffer.concat([u8(1),chunk]))]);
  }
  glob=Buffer.concat([glob,sstRec]);
  /* 占位：先写 BOUNDSHEET（位置稍后回填） */
  const ph=[];sheets.forEach(sh=>ph.push(bounds(sh.name,0)));   /* 占位必须与回填后等长 */
  glob=Buffer.concat([glob,...ph,rec(0x000A,Buffer.alloc(0))]);
  let cur=glob.length;
  const sheetBufs=sheets.map(sh=>{
    bofs.push(cur);
    const parts=[rec(0x0809,Buffer.concat([u16(0x0600),u16(0x0010),u32(0),u32(0),u32(0)]))];
    (sh.cells||[]).forEach(c=>{
      if(c.s!=null)parts.push(rec(0x00FD,Buffer.concat([u16(c.r),u16(c.c),u16(0),u32(c.s)])));
      else if(c.rk)parts.push(rec(0x027E,Buffer.concat([u16(c.r),u16(c.c),u16(c.xf||0),u32(c.rk)])));
      else if(c.f)parts.push(rec(0x0006,Buffer.concat([u16(c.r),u16(c.c),u16(c.xf||0),dbl(c.v),u16(0),u32(0),u8(0)])));
      else parts.push(rec(0x0203,Buffer.concat([u16(c.r),u16(c.c),u16(c.xf||0),dbl(c.v)])));
    });
    parts.push(rec(0x000A,Buffer.alloc(0)));
    const b=Buffer.concat(parts);cur+=b.length;return b;
  });
  /* 回填 BOUNDSHEET 的真实位置与名称 */
  let out=glob;
  sheets.forEach((sh,i)=>{
    const want=bounds(sh.name,bofs[i]);
    const old=ph[i];
    const at=out.indexOf(old);
    if(at<0)throw new Error('BOUNDSHEET 占位未找到');
    out=Buffer.concat([out.slice(0,at),want,out.slice(at+old.length)]);
  });
  return Buffer.concat([out,...sheetBufs]);
}
/* 工作簿构造（BIFF5：无 SST，内联 LABEL） */
function buildWb5(sheets){
  const bofs=[];
  let glob=Buffer.concat([rec(0x0809,Buffer.concat([u16(0x0500),u16(0x0010),u32(0)])),rec(0x0042,u16(936))]);
  for(let i=0;i<16;i++){const b=Buffer.alloc(16);b.writeUInt16LE(0,0);b.writeUInt16LE(i===15?164:0,2);glob=Buffer.concat([glob,rec(0x00E0,b)]);}
  glob=Buffer.concat([glob,rec(0x041E,Buffer.concat([u16(164),u8(10),mbs('yyyy-mm-dd')]))]);
  const ph=[];sheets.forEach(sh=>ph.push(bounds(sh.name,0,1)));
  glob=Buffer.concat([glob,...ph,rec(0x000A,Buffer.alloc(0))]);
  let cur=glob.length;
  const bufs=sheets.map(sh=>{
    bofs.push(cur);
    const parts=[rec(0x0809,Buffer.concat([u16(0x0500),u16(0x0010),u32(0)])),
      rec(0x0200,Buffer.concat([u32(0),u32(1),u16(0),u16(0)]))];   /* BOF 必须是子流首记录（BOUNDSHEET 指向它） */
    (sh.cells||[]).forEach(c=>{
      if(c.t!=null)parts.push(rec(0x0204,Buffer.concat([u16(c.r),u16(c.c),u16(c.xf||0),u16(c.t.length),u8(0),mbs(c.t)])));
      else parts.push(rec(0x0203,Buffer.concat([u16(c.r),u16(c.c),u16(c.xf||0),dbl(c.v)])));
    });
    parts.push(rec(0x000A,Buffer.alloc(0)));
    const b=Buffer.concat(parts);cur+=b.length;return b;
  });
  let out=glob;
  sheets.forEach((sh,i)=>{const at=out.indexOf(ph[i]);out=Buffer.concat([out.slice(0,at),bounds(sh.name,bofs[i],1),out.slice(at+ph[i].length)]);});
  return Buffer.concat([out,...bufs]);
}
/* RK 编码：整数型 + 百分位（bit1=整数，bit0=×0.01） */
const rkInt=n=>(((Math.round(n*100)<<2)|0x2|0x1)>>>0);

/* ---------- 三个回归样本 ---------- */
if(!fs.existsSync(DIR))fs.mkdirSync(DIR);
const D=serial(2026,9,20);
/* 1) 中文 SST（单个 SST 记录）+ 空单元格 + 多工作表 */
const s1=['日期','菜品名称','销量','用户实付','商家实收','红烧肉','鱼香肉丝','宫保鸡丁'];
const wb1=buildWb8(s1,[
 {name:'外卖日结',cells:[
   {r:0,c:0,s:0},{r:0,c:1,s:1},{r:0,c:2,s:2},{r:0,c:3,s:3},{r:0,c:4,s:4},
   {r:1,c:0,v:D,xf:15},{r:1,c:1,s:5},{r:1,c:2,rk:rkInt(12)},{r:1,c:3,v:456.5},{r:1,c:4,v:410.85},
   {r:2,c:0,v:D,xf:15},{r:2,c:1,s:6},{r:2,c:2,rk:rkInt(8)},{r:2,c:3,v:240},{r:2,c:4,f:1,v:216},
   {r:3,c:1,s:7},{r:3,c:2,v:5}                       /* 空单元格：c0/c3/c4 缺失 */
 ]},
 {name:'汇总',cells:[{r:0,c:0,s:1},{r:0,c:1,s:2},{r:1,c:0,s:5},{r:2,c:2,v:99}]}
]);
fs.writeFileSync(DIR+'/真样本1_中文SST.xls',buildOle(wb1,'Workbook'));
/* 2) SST 跨 CONTINUE（长中文串被切成多段） */
const s2=['菜品名称','销量','超长菜名测试：秘制黑椒牛柳粒配时蔬一份','红烧肉','鱼香肉丝'];
const wb2=buildWb8(s2,[
 {name:'菜单',cells:[
   {r:0,c:0,s:0},{r:0,c:1,s:1},
   {r:1,c:0,s:2},{r:1,c:1,rk:rkInt(3)},
   {r:2,c:0,s:3},{r:2,c:1,v:7},
   {r:3,c:0,s:4}
 ]}
],{sstCut:24,contSize:16});   /* 让第 2 个（超长中文）字符串横跨多个 CONTINUE */
fs.writeFileSync(DIR+'/真样本2_SST跨CONTINUE.xls',buildOle(wb2,'Workbook'));
/* 3) BIFF5：内联 LABEL + 空单元格 + 3 个工作表 */
/* BIFF5 用单字节字符集，样本统一使用 ASCII 文本 */
const wb3=buildWb5([
 {name:'Sheet1',cells:[{r:0,c:0,t:'Material'},{r:0,c:1,t:'Qty'},{r:0,c:2,t:'Price'},
   {r:1,c:0,t:'Potato'},{r:1,c:1,v:20},{r:1,c:2,v:2.5},
   {r:2,c:0,t:'Beef'},{r:2,c:2,v:38.8}]},                        /* c1 空 */
 {name:'Sheet2',cells:[{r:1,c:1,t:'Blank'}]},
 {name:'Sheet3',cells:[{r:0,c:0,t:'Date'},{r:0,c:1,t:'Amount'},{r:1,c:0,v:D,xf:15},{r:1,c:1,v:1024}]}
]);
fs.writeFileSync(DIR+'/真样本3_BIFF5空单元格多表.xls',buildOle(wb3,'Book'));

/* ---------- 抽取主文件解析器并实测 ---------- */
const html=fs.readFileSync(HTML,'utf8');
const a=html.indexOf('/* ================= 真二进制 .xls：OLE2(CFB) 容器 + BIFF8/BIFF5');
const b=html.indexOf('/* --- 读取入口：统一嗅探文件真实格式 --- */');
if(a<0||b<0)throw new Error('未能定位解析器代码块');
const code=html.slice(a,b);
const sandbox={};
const fn=new Function(code+'\nreturn {parseXls:parseXls,oleStreamBytes:oleStreamBytes,parseBiff:parseBiff};');
const P=fn();
let fail=0;
const chk=(name,cond,extra)=>{console.log((cond?'  ✅ ':'  ❌ ')+name+(extra?'  → '+extra:''));if(!cond)fail++;};
['真样本1_中文SST.xls','真样本2_SST跨CONTINUE.xls','真样本3_BIFF5空单元格多表.xls'].forEach(f=>{
  console.log('\n=== '+f);
  const bytes=new Uint8Array(fs.readFileSync(DIR+'/'+f));
  let res=null;
  try{res=P.parseXls(bytes);}catch(e){console.log('  ❌ 解析抛错：'+e.message);fail++;return;}
  console.log('  工作表：'+res.sheets.map(s=>s.name+'('+s.rows.length+'行)').join(' / '));
  res.sheets.forEach(s=>s.rows.forEach(r=>console.log('    ['+s.name+'] '+JSON.stringify(r))));
  if(f.indexOf('真样本1')===0){
    const r=res.sheets[0].rows;
    chk('表头中文正确',r[0][0]==='日期'&&r[0][1]==='菜品名称',JSON.stringify(r[0]));
    chk('日期按格式转 ISO',r[1][0]==='2026-09-20',r[1][0]);
    chk('RK 整数',r[1][2]==='12',r[1][2]);
    chk('NUMBER 小数',r[1][3]==='456.5',r[1][3]);
    chk('FORMULA 缓存值',r[2][4]==='216',r[2][4]);
    chk('空单元格补空串',r[3][0]===''&&r[3][3]===''&&r[3][1]==='宫保鸡丁',JSON.stringify(r[3]));
    chk('第二张表',res.sheets[1]&&res.sheets[1].name==='汇总');
  }
  if(f.indexOf('真样本2')===0){
    const r=res.sheets[0].rows;
    chk('跨 CONTINUE 长中文串还原',r[1][0]==='超长菜名测试：秘制黑椒牛柳粒配时蔬一份',r[1][0]);
    chk('后续字符串未错位',r[2][0]==='红烧肉'&&r[3][0]==='鱼香肉丝',r[2][0]+'|'+r[3][0]);
  }
  if(f.indexOf('真样本3')===0){
    chk('三张工作表',res.sheets.length===3,res.sheets.map(s=>s.name).join('/'));
    const r=res.sheets[0].rows;
    chk('BIFF5 内联文本',r[0][0]==='Material'&&r[1][0]==='Potato',JSON.stringify(r[0]));
    chk('BIFF5 空单元格',r[2][1]===''&&r[2][2]==='38.8',JSON.stringify(r[2]));
    chk('BIFF5 日期',res.sheets[2].rows[1][0]==='2026-09-20',res.sheets[2].rows[1][0]);
  }
});
console.log('\n失败断言：'+fail);
process.exit(fail?1:0);
