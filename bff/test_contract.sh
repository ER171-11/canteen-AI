#!/usr/bin/env bash
# test_contract.sh — 熊猫五福餐厅 云端 BFF 契约自测
# 用法：bash test_contract.sh
#   脚本自行启动 node server.js（默认 127.0.0.1:8788，可用 BFF_TEST_PORT 覆盖；
#   数据目录用临时目录 BFF_DATA_DIR，不碰 bff/data 与 8787 上可能存在的服务），
#   跑完 curl 校验后杀掉，退出码反映成败。
set -u
cd "$(dirname "$0")"

# 测试用独立端口与独立数据目录：8787 上可能有别人起的服务，绝不占用/污染
PORT="${BFF_TEST_PORT:-8788}"
BASE="http://127.0.0.1:$PORT"
PASS=0
FAIL=0
TMPD="$(mktemp -d)"

say()  { printf '%s\n' "$*"; }
ok()   { PASS=$((PASS+1)); say "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); say "  FAIL  $1"; }

# assert_code <描述> <期望码> <实际码>
assert_code() {
  if [ "$2" = "$3" ]; then ok "$1 (http=$3)"; else bad "$1 (期望 $2 实得 $3)"; fi
}
# assert_grep <描述> <文件> <正则>
assert_grep() {
  if grep -Eq "$3" "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1 (未匹配 /$3/ → $(head -c 200 "$2"))"; fi
}
json_get() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((o,k)=>o==null?o:o[k],j);console.log(v==null?"":v);' "$1" "$2"; }

# ---------- 启动服务 ----------
say "== 启动 BFF（port=$PORT, data=$TMPD/data）=="
BFF_PORT="$PORT" BFF_DATA_DIR="$TMPD/data" node server.js > "$TMPD/server.log" 2>&1 &
SRV_PID=$!
cleanup() { kill "$SRV_PID" 2>/dev/null; wait "$SRV_PID" 2>/dev/null; rm -rf "$TMPD"; }
trap cleanup EXIT

for i in $(seq 1 50); do
  curl -s -o /dev/null "$BASE/api/health" && break
  sleep 0.2
done
if ! curl -s -o /dev/null "$BASE/api/health"; then
  say "FATAL: 服务未能启动，日志："; cat "$TMPD/server.log"
  exit 1
fi

# ---------- 1. 健康检查 ----------
say "== 1. 健康检查 =="
CODE=$(curl -s -o "$TMPD/h.json" -w "%{http_code}" "$BASE/api/health")
assert_code "GET /api/health" 200 "$CODE"
assert_grep "health 含 models/key_loaded/rev" "$TMPD/h.json" '"key_loaded":(true|false)'
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/")
assert_code "GET / 旧版健康检查" 200 "$CODE"

# ---------- 2. 鉴权 ----------
say "== 2. 鉴权 =="
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/actions")
assert_code "无 token 访问 /api/actions" 401 "$CODE"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/snapshot/latest" -H "Authorization: Bearer bad.token")
assert_code "伪 token 访问" 401 "$CODE"

curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"account":"boss","device_fp":"t1"}' > "$TMPD/login.json"
assert_grep "boss 登录 role=老板" "$TMPD/login.json" '"role":"老板"'
TOKEN=$(json_get "$TMPD/login.json" token)
AUTH="Authorization: Bearer $TOKEN"
[ -n "$TOKEN" ] && ok "取得 token" || bad "未取得 token"

curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"account":"someone"}' > "$TMPD/ro.json"
assert_grep "未知账号 role=只读" "$TMPD/ro.json" '"role":"只读"'
ROTOKEN=$(json_get "$TMPD/ro.json" token)

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{}')
assert_code "缺 account 登录" 400 "$CODE"

# 无快照时只读端点一律 404（数据目录是全新的）
CODE=$(curl -s -o "$TMPD/ns0.json" -w "%{http_code}" "$BASE/api/snapshot/latest" -H "$AUTH")
assert_code "无快照 latest" 404 "$CODE"
assert_grep "无快照错误体" "$TMPD/ns0.json" 'no snapshot'
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/sop/workorder" -H "$AUTH")
assert_code "无快照 sop/workorder" 404 "$CODE"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/kitchen/recipes" -H "$AUTH")
assert_code "无快照 kitchen/recipes" 404 "$CODE"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/kitchen/board" -H "$AUTH")
assert_code "无快照 kitchen/board" 404 "$CODE"

# ---------- 3. 快照 ----------
say "== 3. 快照 push/latest =="
CODE=$(curl -s -o "$TMPD/push.json" -w "%{http_code}" -X POST "$BASE/api/snapshot/push" \
  -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"rev":42,"machine":"pos-t","data":{"dishes":[{"name":"五福饺子"}],"sales":[{"date":"2026-09-24T12:30:00","amount":58.5},{"date":"2026-09-24T18:10:00","amount":102}],"members":[{"id":1}],"recipes":[{"id":"r1"}]}}')
assert_code "push 小快照" 200 "$CODE"
assert_grep "push 返回 rev=42" "$TMPD/push.json" '"rev":42'

curl -s "$BASE/api/snapshot/latest" -H "$AUTH" > "$TMPD/latest.json"
assert_grep "latest rev=42" "$TMPD/latest.json" '"rev":42'
curl -s "$BASE/api/snapshot/latest?module=dishes" -H "$AUTH" > "$TMPD/mod.json"
assert_grep "module=dishes 仅含 dishes" "$TMPD/mod.json" '"data":\{"dishes":'
if grep -q '"sales"' "$TMPD/mod.json"; then bad "module 过滤泄漏了 sales"; else ok "module 过滤不含其它 key"; fi

# 5MB 边界
head -c 5242881 /dev/zero | tr '\0' 'a' > "$TMPD/big.bin"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/snapshot/push" \
  -H "$AUTH" -H 'Content-Type: application/json' --data-binary @"$TMPD/big.bin")
assert_code "push >5MB 拒收" 413 "$CODE"
node -e 'const pad="a".repeat(5*1024*1024-2048);require("fs").writeFileSync(process.argv[1],JSON.stringify({rev:43,machine:"pos-t",data:{pad}}))' "$TMPD/ok5m.json"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/snapshot/push" \
  -H "$AUTH" -H 'Content-Type: application/json' --data-binary @"$TMPD/ok5m.json")
assert_code "push <5MB 通过" 200 "$CODE"
# 恢复小快照 rev=42
curl -s -o /dev/null -X POST "$BASE/api/snapshot/push" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"rev":42,"machine":"pos-t","data":{"dishes":[{"name":"五福饺子"}],"sales":[{"date":"2026-09-24T12:30:00","amount":58.5},{"date":"2026-09-24T18:10:00","amount":102}],"members":[{"id":1}],"recipes":[{"id":"r1"}]}}'

# ---------- 4. 日报 ----------
say "== 4. 日报 =="
curl -s "$BASE/api/report/daily?date=2026-09-24" -H "$AUTH" > "$TMPD/rep.json"
assert_grep "日报 mock:false" "$TMPD/rep.json" '"mock":false'
assert_grep "日报 8 个 kpi" "$TMPD/rep.json" '"label":"销售记录总数"'
assert_grep "日报营收聚合" "$TMPD/rep.json" '¥160\.50'

# ---------- 5. agent 桩 ----------
say "== 5. agent 桩（只读） =="
CODE=$(curl -s -o "$TMPD/agent.json" -w "%{http_code}" -X POST "$BASE/api/agent/chat" \
  -H "$AUTH" -H 'Content-Type: application/json' -d '{"question":"今天营收","ctx":{}}')
assert_code "agent/chat" 200 "$CODE"
assert_grep "agent 返回 Sprint4 note" "$TMPD/agent.json" 'agent 决策层待 Sprint4'
assert_grep "agent cards 为空" "$TMPD/agent.json" '"cards":\[\]'

# ---------- 6. actions 队列 ----------
say "== 6. actions 队列状态机 =="
curl -s -X POST "$BASE/api/actions" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"type":"stock.replenish","payload":{"sku":"flour","qty":10},"operator":"店长"}' > "$TMPD/a1.json"
assert_grep "入队 status=queued" "$TMPD/a1.json" '"status":"queued"'
assert_grep "入队 rev=42" "$TMPD/a1.json" '"rev":42'
AID=$(json_get "$TMPD/a1.json" id)

curl -s -X POST "$BASE/api/actions" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"type":"stock.replenish","payload":{"sku":"flour","qty":10},"operator":"店长"}' > "$TMPD/a2.json"
AID2=$(json_get "$TMPD/a2.json" id)
assert_grep "重复提交 dedup:true" "$TMPD/a2.json" '"dedup":true'
if [ "$AID" = "$AID2" ] && [ -n "$AID" ]; then ok "幂等：重复提交返回同一 id"; else bad "幂等失败 ($AID vs $AID2)"; fi

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/actions/$AID/confirm" \
  -H "$AUTH" -H 'Content-Type: application/json' -d '{"operator":"店长","rev":999}')
assert_code "confirm rev 不符" 409 "$CODE"

CODE=$(curl -s -o "$TMPD/cf.json" -w "%{http_code}" -X POST "$BASE/api/actions/$AID/confirm" \
  -H "$AUTH" -H 'Content-Type: application/json' -d '{"operator":"店长","rev":42}')
assert_code "confirm rev 匹配" 200 "$CODE"
assert_grep "confirm 后 待执行" "$TMPD/cf.json" '"status":"待执行"'

curl -s "$BASE/api/actions/$AID/status" -H "$AUTH" > "$TMPD/st.json"
assert_grep "status=待执行" "$TMPD/st.json" '"status":"待执行"'
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/actions/$AID/status" -H "$AUTH")
assert_code "status 也支持 POST" 200 "$CODE"

curl -s -X POST "$BASE/api/actions/$AID/execute" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"result":{"ok":true,"applied":1}}' > "$TMPD/ex.json"
assert_grep "execute → 已执行" "$TMPD/ex.json" '"status":"已执行"'
curl -s "$BASE/api/actions/$AID/status" -H "$AUTH" > "$TMPD/st2.json"
assert_grep "status 含 executed_at" "$TMPD/st2.json" '"executed_at":"20'

# 驳回分支
curl -s -X POST "$BASE/api/actions" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"type":"price.update","payload":{"sku":"d1","price":30},"operator":"老板"}' > "$TMPD/a3.json"
BID=$(json_get "$TMPD/a3.json" id)
curl -s -o /dev/null -X POST "$BASE/api/actions/$BID/confirm" -H "$AUTH" -H 'Content-Type: application/json' -d '{"operator":"老板","rev":42}'
curl -s -X POST "$BASE/api/actions/$BID/execute" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"result":{"ok":false,"error":"店内库存不足"}}' > "$TMPD/rj.json"
assert_grep "execute ok:false → 已驳回" "$TMPD/rj.json" '"status":"已驳回"'
assert_grep "驳回含 error" "$TMPD/rj.json" '店内库存不足'

curl -s -G "$BASE/api/actions" --data-urlencode "status=已执行" -H "$AUTH" > "$TMPD/ls.json"
assert_grep "按 status=已执行 过滤" "$TMPD/ls.json" "\"id\":\"$AID\""
if grep -q "\"id\":\"$BID\"" "$TMPD/ls.json"; then bad "过滤混入了已驳回记录"; else ok "过滤未混入已驳回"; fi

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/actions/$AID/confirm" \
  -H "$AUTH" -H 'Content-Type: application/json' -d '{"operator":"店长","rev":42}')
assert_code "已执行后重复 confirm" 409 "$CODE"

# ---------- 7. admin ----------
say "== 7. admin =="
CODE=$(curl -s -o "$TMPD/al.json" -w "%{http_code}" -X POST "$BASE/api/admin/login" \
  -H 'Content-Type: application/json' -d '{"account":"manager"}')
assert_code "admin/login" 200 "$CODE"
assert_grep "admin/login 标记 admin-web" "$TMPD/al.json" '"source":"admin-web"'

for k in dishes recipes staff members tables vendors; do
  CODE=$(curl -s -o "$TMPD/adm_$k.json" -w "%{http_code}" "$BASE/api/admin/$k" -H "$AUTH")
  assert_code "admin/$k 只读" 200 "$CODE"
done
assert_grep "admin/dishes 有数据" "$TMPD/adm_dishes.json" '"count":1'
assert_grep "admin/vendors 空数组" "$TMPD/adm_vendors.json" '"items":\[\]'

CODE=$(curl -s -o "$TMPD/cfg.json" -w "%{http_code}" "$BASE/api/admin/config" -H "$AUTH")
assert_code "admin/config GET" 200 "$CODE"
assert_grep "config 来源标注" "$TMPD/cfg.json" '"source":"(snapshot|default)"'

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/admin/config" \
  -H "Authorization: Bearer $ROTOKEN" -H 'Content-Type: application/json' -d '{"config":{"x":1}}')
assert_code "只读角色写配置 RBAC" 403 "$CODE"

CODE=$(curl -s -o "$TMPD/cfgw.json" -w "%{http_code}" -X POST "$BASE/api/admin/config" \
  -H "$AUTH" -H 'Content-Type: application/json' -d '{"config":{"safety_stock":{"flour":20}}}')
assert_code "老板写配置 → 200 走队列" 200 "$CODE"
assert_grep "配置写返回队列 id" "$TMPD/cfgw.json" '"queued":true'

CODE=$(curl -s -o "$TMPD/kl.json" -w "%{http_code}" "$BASE/api/admin/kimi-log?limit=5" -H "$AUTH")
assert_code "admin/kimi-log" 200 "$CODE"
CODE=$(curl -s -o "$TMPD/au.json" -w "%{http_code}" "$BASE/api/admin/audit?limit=5" -H "$AUTH")
assert_code "admin/audit" 200 "$CODE"
assert_grep "audit 记录含 trace_id/role/status" "$TMPD/au.json" '"trace_id":"[^"]+"'

# ---------- 8. 中间件 ----------
say "== 8. 中间件（trace / 限流） =="
TRACE_HDR=$(curl -s -D - -o /dev/null "$BASE/api/health" -H 'X-Trace-Id: contract-trace-1' | grep -i '^X-Trace-Id:' | tr -d '\r' | awk '{print $2}')
if [ "$TRACE_HDR" = "contract-trace-1" ]; then ok "X-Trace-Id 透传"; else bad "X-Trace-Id 透传失败($TRACE_HDR)"; fi

# 限流：/api/agent/* 10 req/min（用全新 token 保证桶满）
NEWTOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"account":"rl-tester"}' | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).token)')
CODES=""
for i in $(seq 1 12); do
  C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/agent/chat" \
    -H "Authorization: Bearer $NEWTOKEN" -H 'Content-Type: application/json' -d '{}')
  CODES="$CODES $C"
done
if [ "${CODES##* }" = "429" ]; then ok "agent 限流 10/min 触发 429 ($CODES )"; else bad "agent 限流未触发 ($CODES )"; fi

# kimi 路由鉴权 + 参数校验（不打真实 API）
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/kimi/vision" -H 'Content-Type: application/json' -d '{}')
assert_code "kimi/vision 无 token" 401 "$CODE"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/kimi/vision" \
  -H "$AUTH" -H 'Content-Type: application/json' -d '{"type":"nope","imageBase64":"x"}')
assert_code "kimi/vision 非法 type" 400 "$CODE"

# ---------- 9. ext 快照 + 厨房/SOP 只读端点 ----------
say "== 9. ext 透传 / 厨房 / SOP =="
# 全新 token，避免前面用例耗尽 60/min 标准桶
KTOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"account":"kitchen-tester"}' | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).token)')
KAUTH="Authorization: Bearer $KTOKEN"
TODAY=$(date +%F)
YDAY=$(date -d "yesterday" +%F 2>/dev/null || date -v-1d +%F)

node -e '
const today=process.argv[2], yday=process.argv[3];
const ext={
  recipes:[
    {sku_id:"sku-red",name:"五福红饺",color:"红",filling:"火龙果猪肉",version:3,updated_at:today+"T08:00:00"},
    {sku_id:"sku-yellow",name:"五福黄饺",color:"黄",filling:"南瓜鸡肉",version:2,updated_at:today+"T08:00:00"}
  ],
  sop_steps:[
    {sku_id:"sku-red",step_no:2,stage:"包制",duration_min:10,key_points:"褶纹≥12"},
    {sku_id:"sku-red",step_no:1,stage:"和面",duration_min:15,key_points:"火龙果汁和面"},
    {sku_id:"sku-yellow",step_no:1,stage:"和面",duration_min:12}
  ],
  sop_workorders:[
    {id:"w1",date:today,sku_id:"sku-red",qty:100,planned_start:today+"T09:00:00",status:"已完成"},
    {id:"w2",date:today,sku_id:"sku-yellow",qty:50,planned_start:today+"T14:00:00",status:"进行中"},
    {id:"w3",date:yday,sku_id:"sku-red",qty:999,planned_start:yday+"T09:00:00",status:"已完成"}
  ],
  qc_records:[
    {id:"q1",workorder_id:"w1",sku_id:"sku-red",sample_weight:26.1,pass:true,ts:today+"T12:05:00",source:"ai"},
    {id:"q2",workorder_id:"w1",sku_id:"sku-red",sample_weight:23.5,pass:false,ts:today+"T12:20:00",source:"ai"},
    {id:"q3",workorder_id:"w2",sku_id:"sku-yellow",sample_weight:25.8,pass:true,ts:today+"T15:00:00",source:"manual"}
  ]
};
require("fs").writeFileSync(process.argv[1],JSON.stringify({rev:50,machine:"pos-k",data:{dishes:[{name:"五福红饺"}]},ext}));
' "$TMPD/ext.json" "$TODAY" "$YDAY"

assert_node() {
  if node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(!eval(process.argv[2]))process.exit(1)' "$2" "$3" 2>/dev/null; then
    ok "$1"
  else
    bad "$1 (表达式: $3)"
  fi
}

CODE=$(curl -s -o "$TMPD/pushext.json" -w "%{http_code}" -X POST "$BASE/api/snapshot/push" \
  -H "$KAUTH" -H 'Content-Type: application/json' --data-binary @"$TMPD/ext.json")
assert_code "push 带 ext 快照" 200 "$CODE"
assert_grep "push ext rev=50" "$TMPD/pushext.json" '"rev":50'

curl -s "$BASE/api/snapshot/latest" -H "$KAUTH" > "$TMPD/lx.json"
assert_node "latest 透传 ext.recipes" "$TMPD/lx.json" 'j.ext&&j.ext.recipes.length===2'
assert_node "latest 透传 ext.qc_records" "$TMPD/lx.json" 'j.ext&&j.ext.qc_records.length===3'
assert_node "latest 仍含 data" "$TMPD/lx.json" 'j.data&&j.data.dishes.length===1'

curl -s "$BASE/api/snapshot/latest?module=ext.recipes" -H "$KAUTH" > "$TMPD/mr.json"
assert_node "module=ext.recipes 只回 recipes" "$TMPD/mr.json" 'j.ext&&j.ext.recipes&&j.ext.recipes.length===2&&!j.ext.sop_steps'
assert_node "module=ext.* 时 data 置空" "$TMPD/mr.json" 'j.data===null'
curl -s "$BASE/api/snapshot/latest?module=ext.sop_steps" -H "$KAUTH" > "$TMPD/ms.json"
assert_node "module=ext.sop_steps" "$TMPD/ms.json" 'j.ext&&j.ext.sop_steps.length===3&&!j.ext.recipes'

curl -s "$BASE/api/sop/workorder" -H "$KAUTH" > "$TMPD/wo.json"
assert_node "workorder 默认今日 count=2" "$TMPD/wo.json" 'j.ok&&j.count===2'
assert_node "workorder 关联 name/color" "$TMPD/wo.json" 'j.workorders[0].name==="五福红饺"&&j.workorders[0].color==="红"'
assert_node "workorder steps 按 step_no 升序" "$TMPD/wo.json" 'var w=j.workorders.find(function(x){return x.id==="w1"});w.steps.length===2&&w.steps[0].step_no===1&&w.steps[1].step_no===2'
assert_node "昨日工单被过滤" "$TMPD/wo.json" '!j.workorders.some(function(x){return x.id==="w3"})'
curl -s "$BASE/api/sop/workorder?date=1999-01-01" -H "$KAUTH" > "$TMPD/wo0.json"
assert_node "workorder 指定空日期 count=0" "$TMPD/wo0.json" 'j.ok&&j.count===0&&j.workorders.length===0'

curl -s "$BASE/api/kitchen/recipes" -H "$KAUTH" > "$TMPD/kr.json"
assert_node "kitchen/recipes 全量 count=2" "$TMPD/kr.json" 'j.ok&&j.count===2&&j.rev===50'
curl -s "$BASE/api/kitchen/recipes/sku-red" -H "$KAUTH" > "$TMPD/kr1.json"
assert_node "kitchen/recipes/{sku} 单条+steps" "$TMPD/kr1.json" 'j.ok&&j.item.sku_id==="sku-red"&&j.steps.length===2'
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/kitchen/recipes/sku-none" -H "$KAUTH")
assert_code "kitchen/recipes 未知 sku" 404 "$CODE"

curl -s "$BASE/api/kitchen/qc" -H "$KAUTH" > "$TMPD/kq.json"
assert_node "kitchen/qc 今日 3 条" "$TMPD/kq.json" 'j.ok&&j.count===3'
assert_node "kitchen/qc 关联 name" "$TMPD/kq.json" 'j.items[0].name==="五福红饺"&&j.items[0].workorder_status==="已完成"'

curl -s "$BASE/api/kitchen/board" -H "$KAUTH" > "$TMPD/kb.json"
assert_node "board 红 planned/done=100/100" "$TMPD/kb.json" 'var g=j.board.find(function(x){return x.color==="红"});g&&g.planned===100&&g.done===100'
assert_node "board 红 qc_pass_rate=0.5" "$TMPD/kb.json" 'var g=j.board.find(function(x){return x.color==="红"});g.qc_pass_rate===0.5&&g.qc_total===2'
assert_node "board 黄 planned/done=50/0 rate=1" "$TMPD/kb.json" 'var g=j.board.find(function(x){return x.color==="黄"});g&&g.planned===50&&g.done===0&&g.qc_pass_rate===1'

curl -s "$BASE/api/report/daily?date=$TODAY" -H "$KAUTH" > "$TMPD/rk.json"
assert_node "日报含 kitchen 摘要 2/1" "$TMPD/rk.json" 'j.kitchen&&j.kitchen.workorders_total===2&&j.kitchen.workorders_done===1'

# 只读性：写动词一律 404
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/sop/workorder" -H "$KAUTH" -H 'Content-Type: application/json' -d '{}')
assert_code "POST sop/workorder 只读" 404 "$CODE"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/kitchen/recipes" -H "$KAUTH" -H 'Content-Type: application/json' -d '{}')
assert_code "POST kitchen/recipes 只读" 404 "$CODE"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/kitchen/board" -H "$KAUTH" -H 'Content-Type: application/json' -d '{}')
assert_code "POST kitchen/board 只读" 404 "$CODE"

# ---------- 汇总 ----------
say ""
say "== 结果：PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" -eq 0 ]
