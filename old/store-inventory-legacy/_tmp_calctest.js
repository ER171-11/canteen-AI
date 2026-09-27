/* S5 · P2 销量口径 纯逻辑自测（从主文件抽取真实代码） */
const fs=require('fs'),path=require('path');
const F=path.join(__dirname,'熊猫五福餐厅进销存系统_真实数据版.html');
const html=fs.readFileSync(F,'utf8');
const blocks=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
const src=blocks.join('\n');

function grab(name){
  const re=new RegExp('function '+name+'\\s*\\([\\s\\S]*?\\n\\}','m');
  const m=src.match(re);
  if(!m)throw new Error('未找到函数 '+name);
  return m[0];
}
const code=[
  "let SC_QMODE='real30',SC_QFALLBACK=true;",
  "const SC_QMODES=[['est','估算 q（菜品主数据）'],['real30','近30天真实'],['real7','近7天真实']];",
  'let DB={sales:[],dishes:[],ings:[],rec:{}};',
  'let SD=[];',
  "const r2=n=>Math.round((n+Number.EPSILON)*100)/100;",
  "const r3=n=>Math.round((n+Number.EPSILON)*1000)/1000;",
  "const today=()=>{const d=new Date();return d.toISOString().slice(0,10);};",
  "const dOff=n=>{const d=new Date();d.setDate(d.getDate()+n);return d.toISOString().slice(0,10);};",
  "const daysAgo=n=>dOff(-n);",
  "const ing=id=>DB.ings.find(x=>x.id===id);",
  "const dish=id=>DB.dishes.find(x=>x.id===id);",
  "const recipeLines=did=>DB.rec[did]||[];",
  "const dishRecipeCost=did=>0;",
  "const dishCost=d=>0;",
  grab('scQDays'),grab('dishRealQty'),grab('calcQtyOf'),grab('syncCalc'),grab('calcStatText')
].join('\n');
const mod=new Function(code+'\nreturn {get DB(){return DB},set DB(v){DB=v},get SD(){return SD},set SD(v){SD=v},'
 +'get SC_QMODE(){return SC_QMODE},set SC_QMODE(v){SC_QMODE=v},'
 +'get SC_QFALLBACK(){return SC_QFALLBACK},set SC_QFALLBACK(v){SC_QFALLBACK=v},'
 +'dishRealQty,calcQtyOf,syncCalc,calcStatText,scQDays};')();

let pass=0,fail=0;
const ok=(c,m)=>{if(c){pass++;console.log('  ok  '+m);}else{fail++;console.log('  FAIL '+m);}};
const eq=(a,b,m)=>ok(Math.abs((a||0)-(b||0))<1e-9,m+' (got '+a+')');

/* 造数据：D1 近30天共 60 份；D2 近30天 7 份；D3 无销量（估算 5）；D4 只在 40 天前有销量 */
const d=new Date();
const iso=n=>{const x=new Date();x.setDate(x.getDate()+n);return x.toISOString().slice(0,10);};
mod.DB={
 sales:[
  {id:'S1',date:iso(-2),lines:[{dish:'D1',qty:20,price:10,amount:200},{dish:'D2',qty:7,price:10,amount:70}]},
  {id:'S2',date:iso(-10),lines:[{dish:'D1',qty:40,price:10,amount:400}]},
  {id:'S3',date:iso(-40),lines:[{dish:'D4',qty:99,price:10,amount:990}]},
  {id:'S4',date:iso(-3),lines:[{dish:'D1',qty:3,price:10,amount:30}]}
 ],
 dishes:[
  {id:'D1',name:'A菜',cat:'爆品',price:30,q:2,on:1,est:8},
  {id:'D2',name:'B菜',cat:'常规',price:20,q:4,on:1,est:6},
  {id:'D3',name:'C菜',cat:'常规',price:15,q:5,on:1,est:5},
  {id:'D4',name:'D菜',cat:'常规',price:15,q:1,on:1,est:1},
  {id:'D5',name:'停售菜',cat:'常规',price:15,q:9,on:0,est:9}
 ],
 ings:[],rec:{}
};

console.log('\n[1] dishRealQty 口径');
eq(mod.dishRealQty('D1',30),63,'近30天 D1 总销量 63');
eq(mod.dishRealQty('D1',7),23,'近7天 D1 总销量 23（-2 天 20 + -3 天 3，-10 天 40 已出窗口）');
eq(mod.dishRealQty('D2',30),7,'近30天 D2 总销量 7');
eq(mod.dishRealQty('D3',30),0,'D3 无销量');
eq(mod.dishRealQty('D4',30),0,'D4 仅在 40 天前有销量 → 近30天为 0');

console.log('\n[2] calcQtyOf 日均 + 兜底');
mod.SC_QMODE='real30';mod.SC_QFALLBACK=true;
eq(mod.calcQtyOf({id:'D1',q:2}),2.1,'D1 日均 63/30=2.1');
eq(mod.calcQtyOf({id:'D2',q:4}),0.23,'D2 日均 7/30');
eq(mod.calcQtyOf({id:'D3',q:5}),5,'D3 无销量 → 回落估算 5');
eq(mod.calcQtyOf({id:'D4',q:1}),1,'D4 超窗口 → 回落估算 1');
mod.SC_QFALLBACK=false;
eq(mod.calcQtyOf({id:'D3',q:5}),0,'兜底关闭 → 0');
mod.SC_QFALLBACK=true;
mod.SC_QMODE='real7';
eq(mod.calcQtyOf({id:'D1',q:2}),3.29,'近7天日均 23/7');
mod.SC_QMODE='est';
eq(mod.calcQtyOf({id:'D1',q:2}),2,'估算口径直接用 q');
ok(mod.calcQtyOf({id:'D3',q:5})===5,'估算口径不受兜底影响');

console.log('\n[3] 只读隔离：syncCalc 不写回 DB.dishes.q');
mod.SC_QMODE='real30';mod.syncCalc();
ok(mod.DB.dishes[0].q===2,'DB.dishes.q 仍为 2（未被覆写）');
ok(mod.DB.dishes[2].q===5,'DB.dishes.q(D3) 仍为 5');
eq(mod.DB.dishes.length,5,'菜品主数据条数不变');
ok(mod.SD.length===4,'SD 只含上架菜品 4 道（停售菜不入）');
const s1=mod.SD.find(x=>x.id==='D1');
eq(s1.q,2.1,'SD[D1].q = 2.1');
eq(s1.sq,63,'SD[D1].sq = 63（近30天总份数）');
ok(s1.src==='real','SD[D1].src=real');
const s3=mod.SD.find(x=>x.id==='D3');
ok(s3.src==='est','SD[D3].src=est（回落）');
eq(s3.q,5,'SD[D3].q 回落估算 5');
eq(s3.def.q,5,'def.q 与当前口径一致，行内重置不会跳变');
eq(s1.def.q,2.1,'def.q(D1)=2.1');

console.log('\n[4] 与配方页 dishSalesAgg 口径一致（date >= daysAgo(N-1)）');
function dishSalesAggLike(did,n){let q=0;const from=daysAgo(n-1);
 mod.DB.sales.forEach(s=>{if(s.date<from)return;s.lines.forEach(l=>{if(l.dish===did)q+=l.qty;});});return q;}
function daysAgo(n){const x=new Date();x.setDate(x.getDate()-n);return x.toISOString().slice(0,10);}
ok(dishSalesAggLike('D1',30)===mod.dishRealQty('D1',30),'近30天总量与配方页算法一致');
ok(dishSalesAggLike('D1',7)===mod.dishRealQty('D1',7),'近7天总量与配方页算法一致');

console.log('\n[5] 文案同步 calcStatText');
mod.SC_QMODE='real30';mod.syncCalc();
let t=mod.calcStatText();
ok(t.includes('近30天真实'),'文案含口径名');
ok(/2 道取真实销量/.test(t)&&/2 道无销量/.test(t),'近30天：2 道真实 + 2 道回落');
ok(t.includes('不写回菜品主数据'),'含只读声明');
mod.SC_QMODE='est';mod.syncCalc();
t=mod.calcStatText();
ok(t.includes('估算 q')&&t.includes('菜品主数据估算值'),'估算口径文案');
ok(!t.includes('取真实销量'),'估算口径不出现真实/回落拆分');
mod.SC_QMODE='real7';mod.syncCalc();
ok(mod.calcStatText().includes('近 7 天'),'近7天文案');

console.log('\n[6] 口径切换后 fallback 数量统计');
mod.SC_QMODE='real7';mod.syncCalc();
const fb=mod.SD.filter(x=>x.src!=='real').length;
eq(fb,2,'近7天：D1/D2 有销量，D3/D4 回落');

console.log('\n结果：'+pass+' 通过 / '+fail+' 失败');
process.exit(fail?1:0);
