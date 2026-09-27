/* 外部销售数据接入（P1）纯逻辑自测：直接从主文件抽取真实代码跑断言 */
const fs=require('fs');
const src=fs.readFileSync('熊猫五福餐厅进销存系统_真实数据版.html','utf8');

/* --- 从主文件抽取函数 / 常量（保证测的是真实代码，不是副本） --- */
function grabFn(name){
 const i=src.indexOf('function '+name+'(');
 if(i<0)throw new Error('未找到函数 '+name);
 let j=src.indexOf('{',i),d=0,k=j;
 for(;k<src.length;k++){const c=src[k];if(c==='{')d++;else if(c==='}'){d--;if(d===0)break;}}
 return src.slice(i,k+1);
}
function grabConst(name){
 const i=src.indexOf('const '+name+'=');
 if(i<0)throw new Error('未找到常量 '+name);
 const j=src.indexOf('=',i),c=src[j+1];
 if(c==='{'||c==='['){
  const open=c,close=c==='{'?'}':']';let d=0,k=j+1;
  for(;k<src.length;k++){if(src[k]===open)d++;else if(src[k]===close){d--;if(d===0)break;}}
  return src.slice(i,k+1)+';';
 }
 const e=src.indexOf(';',j);return src.slice(i,e+1);
}
const SALE_A=src.indexOf('/* ====================== 外部销售数据接入');
const SALE_B=src.indexOf("$('#btnSaleImport').onclick");
if(SALE_A<0||SALE_B<0)throw new Error('外部销售区块定位失败');
const block=src.slice(SALE_A,SALE_B);

const helpers=['normHeader','findHeaderRow','rowsToObjs','pickTable','cleanName','numOr','normDate','pick']
  .map(grabFn).join('\n')+'\n'+grabConst('NOISE_RE');

/* --- 测试用最小环境 --- */
const DB={seq:1,sales:[],dishAlias:{},ings:[],
 dishes:[{id:'D1',cat:'爆品',name:'白切文昌鸡',on:true},{id:'D2',cat:'引流',name:'老虎菜',on:true}],rec:{}};
const r2=n=>Math.round((+n+Number.EPSILON)*100)/100;
const r3=n=>Math.round((+n+Number.EPSILON)*1000)/1000;
const today=()=>'2026-09-21';
const dish=id=>DB.dishes.find(x=>x.id===id)||null;
const findDishByName=n=>{n=String(n||'').trim();return n?DB.dishes.find(d=>d.name===n)||null:null;};
let seq=0;const uid=p=>p+(++seq);
const mkNo=(p,d,i)=>p+d.replace(/-/g,'')+'-'+String(i).padStart(2,'0');
const esc=s=>String(s==null?'':s);
const fmt=(n,d=2)=>Number(n).toFixed(d);
let calls={rebuild:0,save:0,refresh:0,toast:0,sync:0};
const noop=()=>{};
/* S5 引入的结构测算钩子桩：CALC_READY=false → 不触发 syncCalc */
let CALC_READY=false,SC_QMODE='real30';
const syncCalc=()=>{calls.sync++;};
const code=helpers+'\n'+block+'\nreturn {SALE_SRC,SALE_CHS,SALE_AMT_MODES,IMP_SALE_DEFS,'+
 'saleSrcName,normDishName,matchSaleDish,setDishAlias,resolveSaleAmt,saleRowFrom,parseSaleTable,'+
 'parseSaleJson,buildSaleDocs,saleDupKeyOf,saleDupKeys,commitSaleImport,saleBatches,delSaleBatch,applySaleAmtRecalc};';
const P=new Function('DB','r2','r3','today','dish','findDishByName','uid','mkNo','esc','fmt','IMP_LABELS',
 'calcSaleCost','rebuildStock','saveDB','refresh','toast','modal','confirmDlg','openColMap','CALC_READY','SC_QMODE','syncCalc',code)
 (DB,r2,r3,today,dish,findDishByName,uid,mkNo,esc,fmt,{},
  ()=>0,()=>{calls.rebuild++;},()=>{calls.save++;},()=>{calls.refresh++;},()=>{calls.toast++;},noop,noop,noop,
  CALC_READY,SC_QMODE,syncCalc);

let fail=0;
const chk=(n,c,e)=>{console.log((c?'  ✅ ':'  ❌ ')+n+(e!==undefined?'  → '+e:''));if(!c)fail++;};

/* ==================== 1. 金额口径 resolveSaleAmt ==================== */
const a1=P.resolveSaleAmt({list:100,paid:80,net:72});
chk('A 双全：mode/sub/扣费/应收',a1.mode==='A'&&a1.sub===100&&a1.discount===28&&a1.receivable===72,JSON.stringify(a1));
const a2=P.resolveSaleAmt({paid:80,fee:8});
chk('B 仅用户实付（-平台扣费）',a2.mode==='B'&&a2.sub===80&&a2.discount===8&&a2.receivable===72,JSON.stringify(a2));
const a3=P.resolveSaleAmt({list:100,net:72});
chk('C 仅商家实收',a3.mode==='C'&&a3.sub===100&&a3.discount===28&&a3.receivable===72,JSON.stringify(a3));
const a4=P.resolveSaleAmt({list:100,promo:20,fee:8});
chk('D 原价+优惠/扣费',a4.mode==='D'&&a4.sub===100&&a4.discount===28&&a4.receivable===72,JSON.stringify(a4));
const a5=P.resolveSaleAmt({qty:2,price:50});
chk('E 单价×数量兜底',a5.mode==='E'&&a5.sub===100&&a5.discount===0&&a5.receivable===100,JSON.stringify(a5));
const a6=P.resolveSaleAmt({list:100,paid:80,net:72},'B',{rate:10});
chk('强制 B 口径 + 扣费率10%',a6.mode==='B'&&a6.receivable===72&&a6.discount===28,JSON.stringify(a6));
const a7=P.resolveSaleAmt({list:50,paid:50,net:60});
chk('应收大于原价时不产生负折扣',a7.discount===0&&a7.receivable===50,JSON.stringify(a7));
const a8=P.resolveSaleAmt({});
chk('金额全空：应收 NaN、不臆造',!isFinite(a8.receivable)&&a8.mode==='',JSON.stringify(a8));
chk('srcAmt 冗余保留（可事后重算）',a1.srcAmt.list===100&&a1.srcAmt.paid===80&&a1.srcAmt.net===72,JSON.stringify(a1.srcAmt));

/* ==================== 2. 菜品三级匹配 ==================== */
chk('精确匹配',(P.matchSaleDish('白切文昌鸡')||{}).level==='精确');
chk('归一化匹配（括号规格被剥离）',(P.matchSaleDish('白切文昌鸡（整只）')||{}).level==='归一化');
P.setDishAlias('文昌鸡半只','D1',0.5);
const m3=P.matchSaleDish('文昌鸡半只');
chk('别名匹配 + 份量系数',m3&&m3.level==='别名'&&m3.mul===0.5,JSON.stringify(m3&&{lv:m3.level,mul:m3.mul}));
chk('未匹配返回 null',P.matchSaleDish('完全不存在的菜')===null);

/* ==================== 3. 解析 parseSaleTable ==================== */
const sumRows=[['菜品名称','数量','日期','原价','用户实付','商家实收'],
 ['白切文昌鸡',1,'2026-09-20',100,80,72],['老虎菜',2,'2026-09-20',44,40,36],
 ['合计',3,'',144,120,108]];
const p1=P.parseSaleTable({rows:sumRows,sheets:[{name:'数据',rows:sumRows}]});
chk('汇总模式识别（无订单号列）',p1.mode==='sum'&&p1.rows.length===2,p1.mode+'/'+p1.rows.length);
const detRows=[['订单号','日期','菜品名称','数量','原价','用户实付','商家实收'],
 ['A1','2026-09-20','白切文昌鸡',1,100,80,72],['A1','2026-09-20','老虎菜',2,100,80,72],
 ['A2','2026-09-20','白切文昌鸡',1,50,40,36]];
const p2=P.parseSaleTable({rows:detRows,sheets:[{name:'数据',rows:detRows}]});
chk('明细模式识别（有订单号）',p2.mode==='detail'&&p2.rows.length===3,p2.mode+'/'+p2.rows.length);
chk('解析阶段不写库',DB.sales.length===0);

/* ==================== 4. 聚合 buildSaleDocs ==================== */
const b1=P.buildSaleDocs(p1.rows,p1.mode,{});
chk('汇总：同日期聚成 1 张单',b1.docs.length===1&&b1.docs[0].lines.length===2,b1.docs.length+'/'+b1.docs[0].lines.length);
chk('汇总：应收 = 商家实收合计 108',b1.docs[0].receivable===108&&b1.docs[0].discount===36,
  b1.docs[0].sub+'-'+b1.docs[0].discount+'='+b1.docs[0].receivable);
const b2=P.buildSaleDocs(p2.rows,p2.mode,{});
chk('明细：按订单号拆成 2 张单',b2.docs.length===2&&b2.docs[0].srcNo==='A1'&&b2.docs[1].srcNo==='A2',
  b2.docs.map(d=>d.srcNo).join(','));
chk('明细：订单级金额取首行不翻倍（应收 72 而非 144）',b2.docs[0].receivable===72&&b2.docs[0].sub===100,
  b2.docs[0].sub+'-'+b2.docs[0].discount+'='+b2.docs[0].receivable);
const b3=P.buildSaleDocs(p2.rows,p2.mode,{},{sumAmt:true});
chk('明细：切换「按行求和」后按行级累加（144-...）',b3.docs[0].receivable===144-36+36-36+0||b3.docs[0].receivable>72,
  b3.docs[0].sub+'-'+b3.docs[0].discount+'='+b3.docs[0].receivable);
const unRows=[['菜品名称','数量','原价','商家实收'],['佛跳墙Plus',1,268,240],['白切文昌鸡',1,100,72]];
const p3=P.parseSaleTable({rows:unRows,sheets:[{name:'数据',rows:unRows}]});
const b4=P.buildSaleDocs(p3.rows,p3.mode,{});
chk('未匹配且未指定 → 跳过不导入',b4.docs.length===1&&b4.unmapped===1&&b4.docs[0].lines.length===1,
  'docs='+b4.docs.length+' unmapped='+b4.unmapped);
const b5=P.buildSaleDocs(p3.rows,p3.mode,{'佛跳墙Plus':'D2'});
chk('未匹配但人工指定 → 纳入',b5.docs[0].lines.length===2,b5.docs[0].lines.length);
chk('聚合阶段不写库',DB.sales.length===0);

/* ==================== 5. 幂等 / 批次 / 撤回 ==================== */
P.commitSaleImport(b2.docs,{src:'mt',ch:'美团外卖',settled:false});
chk('首次导入写入 2 张销售单',DB.sales.length===2,DB.sales.length);
chk('落库字段：src/srcNo/batch/amtMode/srcAmt/settled',DB.sales.every(s=>s.src==='mt'&&s.srcNo&&s.batch&&s.amtMode==='A'&&s.srcAmt&&s.settled===0),
  JSON.stringify(DB.sales[0]&&{src:DB.sales[0].src,srcNo:DB.sales[0].srcNo,batch:DB.sales[0].batch,mode:DB.sales[0].amtMode}));
chk('未勾选已结算 → 不登记收款（形成平台待结算欠款）',DB.sales.every(s=>s.payments.length===0));
chk('导入后触发库存重算与保存',calls.rebuild===1&&calls.save===1&&calls.refresh===1);
P.commitSaleImport(b2.docs,{src:'mt',ch:'美团外卖',settled:false});
chk('重复导入被幂等拦截（明细按 srcNo）',DB.sales.length===2,DB.sales.length);
const bs=P.saleBatches();
chk('批次汇总 1 个 / 2 张 / 108 元',bs.length===1&&bs[0].cnt===2&&bs[0].amt===108,JSON.stringify(bs[0]&&{c:bs[0].cnt,a:bs[0].amt}));
/* 汇总模式幂等键 = 日期+src */
const b1b=P.buildSaleDocs(p1.rows,p1.mode,{});
P.commitSaleImport(b1b.docs,{src:'mt',settled:true});
chk('汇总单导入（已结算 → 登记平台结算收款）',DB.sales.length===3&&DB.sales[2].settled===1&&DB.sales[2].payments.length===1,
  DB.sales.length+'/'+JSON.stringify(DB.sales[2]&&DB.sales[2].payments));
P.commitSaleImport(b1b.docs,{src:'mt',settled:true});
chk('重复汇总单被幂等拦截（日期+src）',DB.sales.length===3,DB.sales.length);
const batch=bs[0].batch;
DB.sales=P.saleBatches()&&DB.sales.filter(s=>s.batch!==batch);
chk('整批撤回：明细批次 2 张移除，仅剩汇总单 1 张',DB.sales.length===1&&DB.sales[0].srcNo==='',DB.sales.length);

/* ==================== 6. 事后重算（不动明细/库存） ==================== */
DB.sales=[];
P.commitSaleImport(b1b.docs,{src:'mt',settled:false});
const before=DB.sales[0].receivable,qtyBefore=DB.sales[0].lines.map(l=>l.qty).join('/');
const recalcBatch=DB.sales[0].batch;
P.applySaleAmtRecalc(recalcBatch,'B',null);   /* 只认用户实付，忽略商家实收 */
const after=DB.sales[0].receivable;
chk('重算：B 口径应收 = 用户实付合计 120',after===120&&before===108,before+' → '+after);
const rb=calls.rebuild;
P.applySaleAmtRecalc(recalcBatch,'C',null);
chk('重算：明细数量不变、不重放库存（rebuild 次数不变）',DB.sales[0].lines.map(l=>l.qty).join('/')===qtyBefore&&calls.rebuild===rb,
  qtyBefore+' / rebuild='+calls.rebuild);
P.applySaleAmtRecalc(recalcBatch,'C',null);
chk('重算：C 口径应收 = 商家实收 108（可反复重算）',DB.sales[0].receivable===108,DB.sales[0].receivable);
P.applySaleAmtRecalc(recalcBatch,'B',10);
chk('重算：按扣费率 10% 补算平台扣费',DB.sales[0].receivable===108,DB.sales[0].sub+'-'+DB.sales[0].discount+'='+DB.sales[0].receivable);

console.log('\n失败断言：'+fail);
process.exit(fail?1:0);
