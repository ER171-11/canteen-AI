/* 采购单状态 / 单向回流 纯逻辑自测 */
const fs=require('fs');
const html=fs.readFileSync('熊猫五福餐厅进销存系统_真实数据版.html','utf8');
const a=html.indexOf('/* ====================== 采购单状态 + 进货单→采购单单向回流');
const b=html.indexOf('/* 采购管理页 ---');
if(a<0||b<0)throw new Error('定位失败');
const code=html.slice(a,b);
const r2=x=>Math.round((+x||0)*100)/100;
const today=()=>'2026-09-21';
const DB={orders:[],recv:[],plans:[]};
/* S6：syncAllOrderRecv 末尾会推进补货建议单状态，此处给空实现 */
const syncPlanStatus=()=>{};
const P=new Function('r2','today','DB','syncPlanStatus',code+'\nreturn {orderLineSt,orderSt,orderRecvProg,openOrderQty,syncOrderRecv,setOrderLinesSt,syncAllOrderRecv};')(r2,today,DB,syncPlanStatus);

let fail=0;
const chk=(n,c,e)=>{console.log((c?'  ✅ ':'  ❌ ')+n+(e!==undefined?'  → '+e:''));if(!c)fail++;};

const O1={id:'O1',no:'CG-1',date:'2026-09-20',supplier:'菜篮子',status:'normal',
  lines:[{ing:'I1',qty:10,price:5,amount:50},{ing:'I2',qty:4,price:20,amount:80}]};
DB.orders.push(O1);
DB.recv.push({id:'R1',no:'JH-1',po:'O1',lines:[{ing:'I1',qty:4},{ing:'I2',qty:1}]});

P.syncAllOrderRecv();
chk('部分收货：已收数按进货单重算',O1.lines[0].recvQty===4&&O1.lines[1].recvQty===1,JSON.stringify(O1.lines.map(l=>l.recvQty)));
chk('部分收货：状态=进行中',P.orderSt(O1)==='normal',P.orderSt(O1));
chk('进度 5/14',JSON.stringify(P.orderRecvProg(O1))==='{"q":14,"g":5,"pct":36}',JSON.stringify(P.orderRecvProg(O1)));
chk('未结案采购量 I1=6',P.openOrderQty('I1')===6,P.openOrderQty('I1'));
chk('未结案采购量 I2=3',P.openOrderQty('I2')===3,P.openOrderQty('I2'));

/* 收齐 → 自动结案 */
DB.recv.push({id:'R2',no:'JH-2',po:'O1',lines:[{ing:'I1',qty:6},{ing:'I2',qty:3}]});
P.syncAllOrderRecv();
chk('收齐：已收数累加',O1.lines[0].recvQty===10&&O1.lines[1].recvQty===4,JSON.stringify(O1.lines.map(l=>l.recvQty)));
chk('收齐：自动结案',P.orderSt(O1)==='closed'&&O1.status==='closed'&&O1.closeBy==='auto',O1.status+'/'+O1.closeBy);
chk('结案后未结案采购量=0',P.openOrderQty('I1')===0&&P.openOrderQty('I2')===0);

/* 删除进货单 → 回退 */
DB.recv=DB.recv.filter(r=>r.id!=='R2');
P.syncAllOrderRecv();
chk('删除进货单后已收数回退',O1.lines[0].recvQty===4&&O1.status==='normal',O1.lines[0].recvQty+'/'+O1.status);

/* 手动结案不被自动覆盖 */
O1.status='closed';O1.closeBy='manual';
P.syncOrderRecv(O1);
chk('手动结案不被自动重算覆盖',O1.status==='closed'&&O1.closeBy==='manual',O1.status+'/'+O1.closeBy);

/* 作废 / 恢复 */
O1.status='void';P.setOrderLinesSt(O1,'canceled');
chk('作废：状态 void',P.orderSt(O1)==='void',P.orderSt(O1));
chk('作废：不计入未结案采购量',P.openOrderQty('I1')===0,P.openOrderQty('I1'));
P.setOrderLinesSt(O1,null);O1.status='normal';O1.closeBy='auto';P.syncOrderRecv(O1);
chk('恢复：回到收货中并重算',P.orderSt(O1)==='normal'&&O1.lines[0].recvQty===4,O1.status+'/'+O1.lines[0].recvQty);

/* 未关联的进货单不回流 */
const O2={id:'O2',no:'CG-2',date:'2026-09-21',supplier:'X',lines:[{ing:'I9',qty:5,price:2,amount:10}]};
DB.orders.push(O2);
DB.recv.push({id:'R3',no:'JH-3',lines:[{ing:'I9',qty:99}]});   /* 无 po */
P.syncAllOrderRecv();
chk('未关联进货单不回写',O2.lines[0].recvQty===0,O2.lines[0].recvQty);
chk('未关联不影响未结案采购量',P.openOrderQty('I9')===5,P.openOrderQty('I9'));

console.log('\n失败断言：'+fail);
process.exit(fail?1:0);
