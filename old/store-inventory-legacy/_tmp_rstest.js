/* S6 · P3 补货建议 纯逻辑自测（从主文件抽取真实代码） */
const fs=require('fs'),path=require('path');
const html=fs.readFileSync(path.join(__dirname,'熊猫五福餐厅进销存系统_真实数据版.html'),'utf8');
const src=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
function grab(name){
  const m=src.match(new RegExp('function '+name+'\\s*\\([\\s\\S]*?\\n\\}','m'));
  if(!m)throw new Error('未找到 '+name);return m[0];
}
const pre=[
 'let DB={};',
 'let TAB="po";',
 'const r2=n=>Math.round((n+Number.EPSILON)*100)/100;',
 'const r3=n=>Math.round((n+Number.EPSILON)*1000)/1000;',
 'const today=()=>"2026-09-21";',
 "const dOff=n=>{const d=new Date('2026-09-21T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};",
 'const daysAgo=n=>dOff(-n);',
 'const uid=p=>p+(DB.seq=(DB.seq||0)+1);',
 "const mkNo=(p,d,i)=>p+d.replace(/-/g,'')+'-'+String(i).padStart(2,'0');",
 'const ing=id=>DB.ings.find(x=>x.id===id);',
 'const dish=id=>DB.dishes.find(x=>x.id===id);',
 'const recipeLines=did=>DB.rec[did]||[];',
 "const mkPoLine=(g,q,p)=>({ing:g.id,qty:q,price:p,conv:g.conv,amount:r2(q*p),unitCost:r3(p/g.conv)});",
 "const esc=s=>String(s==null?'':s);",
 'const fmt=(n,d=2)=>(+n).toFixed(d);',
 "function RESTOCK_DEF(){return {days:30,lead:1,gap:1,useOnway:1};}",
 grab('dailyUseMap'),grab('orderLineSt'),grab('orderSt'),grab('openOrderQty'),
 grab('syncOrderRecv'),grab('syncAllOrderRecv'),
 grab('restockCfg'),grab('restockLineOf'),grab('restockLines'),
 grab('curRestockPlan'),grab('mkPlanNo'),grab('autoRestockPlan'),grab('genRestockPlan'),
 grab('syncPlanStatus')
].join('\n');
/* 依赖但本测试不验证的副作用函数：桩掉 */
const post='\nreturn {get DB(){return DB},set DB(v){DB=v},get LAST(){return LAST},'
 +'restockCfg,restockLineOf,restockLines,autoRestockPlan,syncPlanStatus,curRestockPlan,dailyUseMap,openOrderQty,orderSt};';
const M=new Function(pre+
 '\nconst saveDB=()=>{};const refresh=()=>{};const toast=(m)=>{LAST=m;};let LAST="";'+
 '\nconst rebuildStock=()=>{};const setOrderLinesSt=()=>{};const genRestockPlanX=0;'+
 post+';')();

const today=()=>'2026-09-21';
let pass=0,fail=0;
const ok=(c,m)=>{if(c){pass++;console.log('  ok  '+m);}else{fail++;console.log('  FAIL '+m);}};
const eq=(a,b,m)=>ok(Math.abs((a||0)-(b||0))<1e-6,m+' (got '+a+')');

function seed(){
 M.DB={
  seq:1,
  ings:[
   /* 日均 5、安全 10、现有 2、无在途 → 缺口 = 5*2+10-2 = 18 */
   {id:'I1',name:'土豆',cat:'蔬菜',unit:'斤',buy:'斤',conv:1,stock:2,safe:10,yld:1,avg:3,last:3,on:1,sup:'甲供应商',moq:0,pack:0},
   /* 日均 2、安全 4、现有 20 → 不缺货 */
   {id:'I2',name:'白菜',cat:'蔬菜',unit:'斤',buy:'斤',conv:1,stock:20,safe:4,yld:1,avg:1,last:1,on:1,sup:'甲供应商'},
   /* 箱装：conv=10，日均 20、安全 30、现有 50 → 缺口 = 20*2+30-50 = 20 → 采购 20/10 = 2 箱 */
   {id:'I3',name:'食用油',cat:'调料',unit:'L',buy:'桶',conv:10,stock:50,safe:30,yld:1,avg:8,last:80,on:1,sup:'乙供应商',pack:2,moq:1},
   /* 停用品不参与 */
   {id:'I4',name:'停用原料',cat:'其他',unit:'斤',buy:'斤',conv:1,stock:0,safe:99,yld:1,avg:1,last:1,on:0},
   /* 无配方耗量(daily=0)、安全 5、现有 1 → 缺口 = 0+5-1 = 4 */
   {id:'I5',name:'酱油',cat:'调料',unit:'瓶',buy:'瓶',conv:1,stock:1,safe:5,yld:1,avg:10,last:12,on:1,sup:'乙供应商'}
  ],
  dishes:[{id:'D1',name:'炒土豆',cat:'常规',price:20,q:1,on:1,est:5}],
  rec:{D1:[{ing:'I1',qty:5},{ing:'I2',qty:2},{ing:'I3',qty:20}]},
  /* 近 30 天每天卖 1 份 → 日均 I1=5 I2=2 I3=20 */
  sales:Array.from({length:30},(_,i)=>({id:'S'+i,date:daysAgo(i),lines:[{dish:'D1',qty:1,price:20,amount:20}]})),
  orders:[],recv:[],plans:[],suppliers:['甲供应商','乙供应商'],logs:[],restock:RESTOCK_DEF_JS()
 };
}
function RESTOCK_DEF_JS(){return {days:30,lead:1,gap:1,useOnway:1};}
function daysAgo(n){const d=new Date('2026-09-21T00:00:00Z');d.setUTCDate(d.getUTCDate()-n);return d.toISOString().slice(0,10);}

console.log('\n[1] 日均耗量（与销售出库同口径：销量×净料÷出成率）');
seed();
let dm=M.dailyUseMap(30);
eq(dm.I1,5,'I1 日均 5（15 天 × 1 份 × 5 净料 ÷ 30）');
eq(dm.I2,2,'I2 日均 2');
eq(dm.I3,20,'I3 日均 20');
eq(dm.I5,0,'I5 无配方 → 日均 0');

console.log('\n[2] restockLineOf 建议量（need 库存单位 → ÷conv → moq → pack）');
let l1=M.restockLineOf(M.DB.ings[0],dm);
eq(l1.need,18,'I1 缺口 = 5×(1+1)+10−2 = 18');
eq(l1.sug,18,'I1 建议采购 18 斤（conv=1，无 moq/pack）');
ok(l1.unit==='斤','缺口与建议量口径记录：unit=库存单位');
let l3=M.restockLineOf(M.DB.ings[2],dm);
eq(l3.need,20,'I3 缺口 = 20×2+30−50 = 20');
eq(l3.sug,2,'I3 建议 20÷10=2 桶，pack=2 → 仍 2 桶');
ok(l3.buy==='桶'&&l3.conv===10,'I3 采购单位/换算随原料');
eq(l3.price,80,'参考单价取 last（元/采购单位）');
let l5=M.restockLineOf(M.DB.ings[4],dm);
eq(l5.need,4,'I5 无耗量也按安全库存补：5−1=4');
ok(M.restockLineOf(M.DB.ings[1],dm)===null,'I2 库存充足 → 不进建议');
ok(!M.restockLines().some(l=>l.ing==='I4'),'停用原料不进建议（restockLines 过滤 on）');

console.log('\n[3] moq / pack 生效');
M.DB.ings[0].moq=50;M.DB.ings[0].pack=20;
l1=M.restockLineOf(M.DB.ings[0],dm);
eq(l1.sug,60,'moq=50 → max(18,50)=50 → pack=20 向上取整 → 60');
M.DB.ings[0].moq=0;M.DB.ings[0].pack=25;
eq(M.restockLineOf(M.DB.ings[0],dm).sug,25,'18 → pack 25 取整 → 25');
M.DB.ings[0].pack=0;

console.log('\n[4] 在途量（未结案采购量）防重复下单');
M.DB.orders=[{id:'O1',no:'CG1',date:today(),supplier:'甲',status:'normal',
  lines:[{ing:'I1',qty:20,price:3,conv:1,amount:60,unitCost:3,recvQty:5}]}];
M.DB.restock.useOnway=1;
eq(M.restockLineOf(M.DB.ings[0],dm).need,3,'扣在途：18−(20−5)=3');
M.DB.restock.useOnway=0;
eq(M.restockLineOf(M.DB.ings[0],dm).need,18,'关闭扣减 → 仍 18');
M.DB.orders=[{id:'O1',no:'CG1',date:today(),supplier:'甲',status:'void',
  lines:[{ing:'I1',qty:20,price:3,conv:1,amount:60,unitCost:3,recvQty:0,st:'canceled'}]}];
M.DB.restock.useOnway=1;
eq(M.restockLineOf(M.DB.ings[0],dm).need,18,'作废单不计入在途');
M.DB.orders=[];

console.log('\n[5] 自动生成 ≠ 自动下单（P3-19）');
seed();
let p=M.autoRestockPlan();
ok(!!p,'无待处理单时自动生成建议单');
eq(M.DB.plans.length,1,'只生成 1 张');
ok(p.status==='pending','初始状态 pending');
ok(p.no.startsWith('BY'),'单号 BY 前缀：'+p.no);
eq(M.DB.orders.length,0,'绝不自动生成采购单 CG');
ok(M.autoRestockPlan()===null,'已有 pending 单时不重复生成');
eq(M.DB.plans.length,1,'仍为 1 张');
ok(p.lines.length===3,'3 个缺货品项（I1/I3/I5）');
ok(!p.lines.some(l=>l.ing==='I2'),'库存充足的 I2 不在建议内');
ok(!p.lines.some(l=>l.ing==='I4'),'停用原料不在建议内');

console.log('\n[6] 结案闭环（P3-21）');
const byId=id=>p.lines.find(l=>l.ing===id);
byId('I1').st='done';byId('I1').po='O9';
M.DB.orders.push({id:'O9',no:'CG9',date:today(),supplier:'甲',status:'normal',
  lines:[{ing:'I1',qty:18,price:3,conv:1,amount:54,unitCost:3,recvQty:18}]});
M.syncPlanStatus();
ok(p.status==='part','部分转单 → plan=part');
ok(byId('I1').st==='closed','采购单收齐 → 行 closed');
byId('I3').st='ignored';byId('I5').st='ignored';
M.syncPlanStatus();
ok(p.status==='ignored'||p.status==='closed','其余忽略后收口（closed 优先）',p.status);
byId('I3').st='done';byId('I3').po='O9';byId('I5').st='done';byId('I5').po='O9';
M.syncPlanStatus();
ok(p.status==='closed','全部收货 → plan=closed');
byId('I1').po='OX';
M.syncPlanStatus();
ok(byId('I1').st==='pending','采购单被删除 → 行回退 pending');

console.log('\n[7] 不触碰库存与均价（硬规则 1）');
seed();
const snap=M.DB.ings.map(g=>g.stock+'/'+g.avg).join('|');
M.restockLines();M.autoRestockPlan();
ok(M.DB.ings.map(g=>g.stock+'/'+g.avg).join('|')===snap,'测算前后 stock/avg 完全不变');

console.log('\n结果：'+pass+' 通过 / '+fail+' 失败');
process.exit(fail?1:0);
