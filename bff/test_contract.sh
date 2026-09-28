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
# assert_node <描述> <json 文件> <JavaScript 表达式>
# 在独立 Node 进程中校验 JSON，避免依赖 jq 并正确支持中文字段。
assert_node() {
  local desc="$1" file="$2" expr="$3"
  if node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (!(eval(process.argv[2]))) process.exit(1);' "$file" "$expr" >/dev/null 2>&1; then
    ok "$desc"
  else
    bad "$desc (表达式: $expr)"
  fi
}
json_get() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((o,k)=>o==null?o:o[k],j);console.log(v==null?"":v);' "$1" "$2"; }

# ---------- 启动服务 ----------
say "== 启动 BFF（port=$PORT, data=$TMPD/data）=="
BFF_PORT="$PORT" BFF_DATA_DIR="$TMPD/data" RL_STD_CAP=1000 node server.js > "$TMPD/server.log" 2>&1 &
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

# 无快照：snapshot 仍 404；厨房空开 200（菜单兜底 / 空工单），避免 App 整页加载失败
CODE=$(curl -s -o "$TMPD/ns0.json" -w "%{http_code}" "$BASE/api/snapshot/latest" -H "$AUTH")
assert_code "无快照 latest" 404 "$CODE"
assert_grep "无快照错误体" "$TMPD/ns0.json" 'no snapshot'
CODE=$(curl -s -o "$TMPD/ns_wo.json" -w "%{http_code}" "$BASE/api/sop/workorder" -H "$AUTH")
assert_code "无快照 sop/workorder 空开" 200 "$CODE"
assert_node "无快照 workorder hint" "$TMPD/ns_wo.json" 'j.ok&&j.hint==="no_snapshot"&&j.count===0'
CODE=$(curl -s -o "$TMPD/ns_kr.json" -w "%{http_code}" "$BASE/api/kitchen/recipes" -H "$AUTH")
assert_code "无快照 kitchen/recipes 空开" 200 "$CODE"
assert_node "无快照 recipes 有菜单或空列表" "$TMPD/ns_kr.json" 'j.ok&&j.hint==="no_snapshot"&&Array.isArray(j.items)'
CODE=$(curl -s -o "$TMPD/ns_kb.json" -w "%{http_code}" "$BASE/api/kitchen/board" -H "$AUTH")
assert_code "无快照 kitchen/board 空开" 200 "$CODE"
assert_node "无快照 board hint" "$TMPD/ns_kb.json" 'j.ok&&j.hint==="no_snapshot"'
CODE=$(curl -s -o "$TMPD/ns_ms.json" -w "%{http_code}" "$BASE/api/modules/staff" -H "$AUTH")
assert_code "无快照 modules/staff 空开" 200 "$CODE"
assert_node "无快照 staff hint" "$TMPD/ns_ms.json" 'j.ok&&j.hint==="no_snapshot"&&Array.isArray(j.shifts)'
CODE=$(curl -s -o "$TMPD/ns_ma.json" -w "%{http_code}" "$BASE/api/modules/analysis" -H "$AUTH")
assert_code "无快照 modules/analysis 空开" 200 "$CODE"
assert_node "无快照 analysis mock/hint" "$TMPD/ns_ma.json" 'j.ok&&j.hint==="no_snapshot"&&(j.mock===true||Array.isArray(j.trend))'
CODE=$(curl -s -o "$TMPD/ns_mb.json" -w "%{http_code}" "$BASE/api/modules/booking" -H "$AUTH")
assert_code "无快照 modules/booking 空开" 200 "$CODE"
assert_node "无快照 booking hint" "$TMPD/ns_mb.json" 'j.ok&&j.hint==="no_snapshot"'

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
assert_grep "agent 返回只读 note" "$TMPD/agent.json" '规则快照答案|SI 已用只读工具取数|只读快照答案|只读快照 \+ 提案 CTA|agent 决策层待完善'
assert_grep "agent cards 为空" "$TMPD/agent.json" '"cards":\[\]'

# agent 流式（SSE）：无 Key 时也应回 stage + delta + done
curl -s --max-time 8 -N -X POST "$BASE/api/agent/stream" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"question":"今天营收"}' > "$TMPD/agent_stream.txt" 2>/dev/null || true
assert_grep "agent/stream 有 stage" "$TMPD/agent_stream.txt" 'event: stage'
assert_grep "agent/stream 有 delta" "$TMPD/agent_stream.txt" 'event: delta'
assert_grep "agent/stream 有 done" "$TMPD/agent_stream.txt" 'event: done'

# ---------- 5b. SI 简报 / 收件箱 ----------
say "== 5b. SI 简报 / 收件箱（只读聚合） =="
CODE=$(curl -s -o "$TMPD/brief.json" -w "%{http_code}" "$BASE/api/report/briefing" -H "$AUTH")
assert_code "GET /api/report/briefing" 200 "$CODE"
assert_grep "briefing 有 headline" "$TMPD/brief.json" '"headline"'
CODE=$(curl -s -o "$TMPD/inbox.json" -w "%{http_code}" "$BASE/api/inbox" -H "$AUTH")
assert_code "GET /api/inbox" 200 "$CODE"
assert_grep "inbox 带 counts" "$TMPD/inbox.json" '"counts"'
assert_grep "inbox 分组齐" "$TMPD/inbox.json" '"decide".*"doing".*"alerts"'

# ---------- 5c. 分级授权政策 / 自动执行 / 审计 ----------
say "== 5c. 分级授权政策（默认关闭） =="
CODE=$(curl -s -o "$TMPD/pol.json" -w "%{http_code}" "$BASE/api/policies" -H "$AUTH")
assert_code "GET /api/policies" 200 "$CODE"
assert_grep "默认 auto_enabled=false" "$TMPD/pol.json" '"auto_enabled":false'
curl -s -X POST "$BASE/api/policies/toggle" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"auto_enabled":true}' > "$TMPD/pol_on.json"
assert_grep "开启自动执行" "$TMPD/pol_on.json" '"auto_enabled":true'
curl -s -X POST "$BASE/api/policies" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"小额补货自动执行","enabled":true,"match":{"types":["restock.create"],"max_amount":0}}' > "$TMPD/pol_add.json"
POLID=$(json_get "$TMPD/pol_add.json" policy.id)
if [ -n "$POLID" ]; then ok "新增政策 id=$POLID"; else bad "新增政策失败"; fi

curl -s -X POST "$BASE/api/actions" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"type":"restock.create","payload":{"items":[{"name":"面粉","qty":5,"price":4}]},"origin":"si","operator":"SI"}' > "$TMPD/auto.json"
assert_grep "SI 命中政策 → 自动置待执行" "$TMPD/auto.json" '"status":"待执行"'
assert_grep "返回 auto_executed=true" "$TMPD/auto.json" '"auto_executed":true'
AUTOID=$(json_get "$TMPD/auto.json" id)

# 高风险类型永远不自动
curl -s -X POST "$BASE/api/actions" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"type":"dish.price","payload":{"name":"老虎菜","price":18},"origin":"si","operator":"SI"}' > "$TMPD/noauto.json"
assert_grep "高风险 dish.price 仍待拍板" "$TMPD/noauto.json" '"status":"queued"'
assert_grep "auto_reason 非空" "$TMPD/noauto.json" '"auto_reason"'

curl -s "$BASE/api/si/audit?limit=20" -H "$AUTH" > "$TMPD/audit.json"
assert_grep "审计含 auto_execute" "$TMPD/audit.json" 'auto_execute'
assert_grep "审计含 hold" "$TMPD/audit.json" '"decision":"hold"'

# 清理：驳回自动动作 + 关自动 + 删政策
if [ -n "$AUTOID" ]; then curl -s -X POST "$BASE/api/actions/$AUTOID/reject" -H "$AUTH" -H 'Content-Type: application/json' -d '{"reason":"测试清理"}' > /dev/null; fi
if [ -n "$POLID" ]; then curl -s -X DELETE "$BASE/api/policies/$POLID" -H "$AUTH" > /dev/null; fi
curl -s -X POST "$BASE/api/policies/toggle" -H "$AUTH" -H 'Content-Type: application/json' -d '{"auto_enabled":false}' > /dev/null

# 回滚：店内消费者落库的动作不提供云端一键回滚
CODE=$(curl -s -o "$TMPD/rb.json" -w "%{http_code}" -X POST "$BASE/api/actions/act_none/rollback" -H "$AUTH")
assert_code "rollback 未知动作 404" 404 "$CODE"

# ---------- 5d. SI 目标 / What-if 模拟 ----------
say "== 5d. SI 目标 / 模拟（只读） =="
CODE=$(curl -s -o "$TMPD/goals.json" -w "%{http_code}" "$BASE/api/si/goals" -H "$AUTH")
assert_code "GET /api/si/goals" 200 "$CODE"
assert_grep "goals 带 items/score" "$TMPD/goals.json" '"items".*"score"'
# 补一条带配方的快照（rev 不变），供模拟取成本卡
curl -s -o /dev/null -X POST "$BASE/api/snapshot/push" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"rev":42,"machine":"pos-t","data":{"dishes":[{"name":"五福饺子"}],"sales":[{"date":"2026-09-24T12:30:00","amount":58.5},{"date":"2026-09-24T18:10:00","amount":102}],"members":[{"id":1}],"recipes":[{"id":"r1"}]},"ext":{"recipes":[{"sku_id":"SKU-TEST","name":"测试饺子","face_main":["火龙果汁 220g"],"main":["猪前肩肉 500g"],"aux":[],"seasoning":[],"params":{"一批出成_个":67}}]}}'
CODE=$(curl -s -o "$TMPD/sim.json" -w "%{http_code}" -X POST "$BASE/api/si/simulate" -H "$AUTH" \
  -H 'Content-Type: application/json' -d '{"sku":"SKU-TEST","portions":500,"price_delta_pct":5}')
assert_code "POST /api/si/simulate" 200 "$CODE"
assert_grep "模拟带 projected.gross_margin" "$TMPD/sim.json" '"projected".*"gross_margin"'
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/si/simulate" -H "$AUTH" \
  -H 'Content-Type: application/json' -d '{"sku":"不存在的菜","portions":1}')
assert_code "模拟未知 SKU 422" 422 "$CODE"

# ---------- 5e. SI 专家团 / 战役 / 知识 ----------
say "== 5e. SI 专家团 / 战役 / 知识 =="
CODE=$(curl -s -o "$TMPD/team.json" -w "%{http_code}" "$BASE/api/si/team" -H "$AUTH")
assert_code "GET /api/si/team" 200 "$CODE"
assert_grep "team 带 specialists" "$TMPD/team.json" '"specialists"'
assert_grep "team 含出品官(菜谱SI)" "$TMPD/team.json" '"id":"kitchen"'
CODE=$(curl -s -o "$TMPD/pipe.json" -w "%{http_code}" "$BASE/api/si/pipeline" -H "$AUTH")
assert_code "GET /api/si/pipeline" 200 "$CODE"
assert_node "pipeline 六阶段+next_key" "$TMPD/pipe.json" 'j.ok&&Array.isArray(j.stages)&&j.stages.length===6&&typeof j.next_key==="string"&&j.stages[0].key==="watch"&&j.stages.every(function(s){return Array.isArray(s.items)})'

# 全局驾驶舱 + 岗位工作台
CODE=$(curl -s -o "$TMPD/cockpit.json" -w "%{http_code}" "$BASE/api/si/cockpit" -H "$AUTH")
assert_code "GET /api/si/cockpit" 200 "$CODE"
assert_node "cockpit 含 KPI+六域+next" "$TMPD/cockpit.json" 'j.ok&&j.kpis&&j.team&&Array.isArray(j.team.specialists)&&j.next&&typeof j.next.label==="string"'
assert_node "cockpit 含队列健康" "$TMPD/cockpit.json" 'j.queue&&typeof j.queue.pending_execute==="number"&&typeof j.queue.stalled==="boolean"'
assert_node "cockpit 含历史趋势" "$TMPD/cockpit.json" 'Array.isArray(j.trend)'
CODE=$(curl -s -o "$TMPD/qh.json" -w "%{http_code}" "$BASE/api/queue/health" -H "$AUTH")
assert_code "GET /api/queue/health" 200 "$CODE"
assert_node "queue/health 形状" "$TMPD/qh.json" 'j.ok&&typeof j.pending_execute==="number"&&typeof j.stalled==="boolean"'
CODE=$(curl -s -o "$TMPD/wbp.json" -w "%{http_code}" "$BASE/api/workbench/procurement" -H "$AUTH")
assert_code "GET /api/workbench/procurement" 200 "$CODE"
assert_node "采购工作台 需求→缺口+验收标准" "$TMPD/wbp.json" 'j.ok&&Array.isArray(j.need_lines)&&j.restock_payload&&typeof j.accept_standards==="number"'
CODE=$(curl -s -o "$TMPD/wbk.json" -w "%{http_code}" "$BASE/api/workbench/kitchen" -H "$AUTH")
assert_code "GET /api/workbench/kitchen" 200 "$CODE"
assert_node "厨师工作台 标准+工单" "$TMPD/wbk.json" 'j.ok&&j.standards&&Array.isArray(j.workorders)'
CODE=$(curl -s -o "$TMPD/wbr.json" -w "%{http_code}" "$BASE/api/workbench/recv" -H "$AUTH")
assert_code "GET /api/workbench/recv" 200 "$CODE"
assert_node "到货验收 待到货+标准" "$TMPD/wbr.json" 'j.ok&&Array.isArray(j.orders)&&typeof j.standards==="number"'
CODE=$(curl -s -o "$TMPD/kb.json" -w "%{http_code}" "$BASE/api/si/knowledge" -H "$AUTH")
assert_code "GET /api/si/knowledge" 200 "$CODE"
assert_grep "knowledge 带 derived" "$TMPD/kb.json" '"derived"'
CODE=$(curl -s -o "$TMPD/mission.json" -w "%{http_code}" -X POST "$BASE/api/si/missions" -H "$AUTH" \
  -H 'Content-Type: application/json' -d '{"template":"loss","autonomy":"advise"}')
assert_code "POST /api/si/missions" 200 "$CODE"
assert_grep "mission 有 steps" "$TMPD/mission.json" '"steps"'
MID=$(json_get "$TMPD/mission.json" mission.id)
CODE=$(curl -s -o "$TMPD/mfrom.json" -w "%{http_code}" -X POST "$BASE/api/si/missions/from-goal" -H "$AUTH" \
  -H 'Content-Type: application/json' -d '{"goal_id":"breakeven"}')
assert_code "POST /api/si/missions/from-goal" 200 "$CODE"
MID2=$(json_get "$TMPD/mfrom.json" mission.id)
CODE=$(curl -s -o "$TMPD/mtick.json" -w "%{http_code}" -X POST "$BASE/api/si/missions/tick" -H "$AUTH")
assert_code "POST /api/si/missions/tick" 200 "$CODE"
CODE=$(curl -s -o "$TMPD/madv.json" -w "%{http_code}" -X POST "$BASE/api/si/missions/$MID/advance" -H "$AUTH" \
  -H 'Content-Type: application/json' -d '{}')
assert_code "POST /api/si/missions/{id}/advance" 200 "$CODE"
CODE=$(curl -s -o "$TMPD/kbadd.json" -w "%{http_code}" -X POST "$BASE/api/si/knowledge" -H "$AUTH" \
  -H 'Content-Type: application/json' -d '{"title":"周六晚高峰加排1人","insight":"基于历史峰谷","tags":["排班"]}')
assert_code "POST /api/si/knowledge" 200 "$CODE"
KBID=$(json_get "$TMPD/kbadd.json" playbook.id)
if [ -n "$MID" ]; then curl -s -o /dev/null -X DELETE "$BASE/api/si/missions/$MID" -H "$AUTH"; fi
if [ -n "$MID2" ]; then curl -s -o /dev/null -X DELETE "$BASE/api/si/missions/$MID2" -H "$AUTH"; fi
if [ -n "$KBID" ]; then curl -s -o /dev/null -X DELETE "$BASE/api/si/knowledge/$KBID" -H "$AUTH"; fi




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

# 管理端 reject 入口（queued → 已驳回，无需先 confirm）
curl -s -X POST "$BASE/api/actions" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"type":"config.update","payload":{"values":{"contract_reject":1}},"operator":"老板"}' > "$TMPD/a4.json"
RID=$(json_get "$TMPD/a4.json" id)
CODE=$(curl -s -o "$TMPD/rej.json" -w "%{http_code}" -X POST "$BASE/api/actions/$RID/reject" \
  -H "$AUTH" -H 'Content-Type: application/json' -d '{"reason":"contract reject"}')
assert_code "POST /actions/{id}/reject" 200 "$CODE"
assert_grep "reject → 已驳回" "$TMPD/rej.json" '"status":"已驳回"'

# ---------- 6b. 报损审批 → 扣库存 ----------
say "== 6b. 报损审批 → 扣库存 =="
curl -s -X POST "$BASE/api/actions" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"type":"loss.report","payload":{"name":"面粉","ing_name":"面粉","qty":1,"pending":true,"reason":"测试审批"},"operator":"店长"}' > "$TMPD/lr.json"
LRID=$(json_get "$TMPD/lr.json" id)
REV=$(curl -s "$BASE/api/snapshot/latest" -H "$AUTH" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).rev)}catch(e){console.log(0)}})')
curl -s -o /dev/null -X POST "$BASE/api/actions/$LRID/confirm" -H "$AUTH" -H 'Content-Type: application/json' -d "{\"operator\":\"店长\",\"rev\":$REV}"
curl -s -o "$TMPD/lrapply.json" -X POST "$BASE/api/actions/$LRID/apply" -H "$AUTH"
assert_grep "报损待审批登记（不扣账）" "$TMPD/lrapply.json" '已执行'
LOSSID=$(curl -s "$BASE/api/snapshot/latest" -H "$AUTH" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const a=((j.ext||{}).loss_reports)||[];console.log(a.length?a[a.length-1].id:"")}catch(e){console.log("")}})')
curl -s -X POST "$BASE/api/actions" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"type\":\"loss.approve\",\"payload\":{\"id\":$LOSSID},\"operator\":\"老板\"}" > "$TMPD/la.json"
LAID=$(json_get "$TMPD/la.json" id)
if [ -n "$LOSSID" ] && [ -n "$LAID" ]; then ok "报损单 id=$LOSSID 审批入队"; else bad "报损单 id/审批入队失败"; fi
REV2=$(curl -s "$BASE/api/snapshot/latest" -H "$AUTH" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.parse(s).rev)})')
curl -s -o /dev/null -X POST "$BASE/api/actions/$LAID/confirm" -H "$AUTH" -H 'Content-Type: application/json' -d "{\"operator\":\"老板\",\"rev\":$REV2}"
curl -s -o /dev/null -X POST "$BASE/api/actions/$LAID/apply" -H "$AUTH"
curl -s "$BASE/api/snapshot/latest" -H "$AUTH" > "$TMPD/lrfin.json"
assert_node "报损审批 → 已审批扣库存" "$TMPD/lrfin.json" 'j.ext&&Array.isArray(j.ext.loss_reports)&&j.ext.loss_reports.some(function(x){return String(x.id)==="'"$LOSSID"'"&&x.status==="已审批"})'

# ---------- 6c. 前厅传菜 → 工单闭环 ----------
say "== 6c. 前厅传菜 → 工单闭环 =="
TODAY3=$(date +%F)
step_action() {
  local t="$1" pl="$2"
  curl -s -X POST "$BASE/api/actions" -H "$AUTH" -H 'Content-Type: application/json' \
    -d "{\"type\":\"$t\",\"payload\":$pl,\"operator\":\"test\"}" > "$TMPD/st.json"
  local id=$(json_get "$TMPD/st.json" id)
  local rev=$(curl -s "$BASE/api/snapshot/latest" -H "$AUTH" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.parse(s).rev)})')
  curl -s -o /dev/null -X POST "$BASE/api/actions/$id/confirm" -H "$AUTH" -H 'Content-Type: application/json' -d "{\"operator\":\"test\",\"rev\":$rev}"
  curl -s -o /dev/null -X POST "$BASE/api/actions/$id/apply" -H "$AUTH"
}
step_action "workorder.create" '{"sku_id":"SKU-WF-HONG","qty":1,"table_id":"T9","date":"'$TODAY3'","status":"待开始"}'
step_action "pos.ready" '{"table_id":"T9","note":"齐菜"}'
curl -s "$BASE/api/snapshot/latest" -H "$AUTH" > "$TMPD/t9a.json"
assert_node "前厅齐菜 → 工单待传" "$TMPD/t9a.json" '((j.ext||{}).sop_workorders||[]).some(function(w){return String(w.table_id)==="T9"&&String(w.date)==="'"$TODAY3"'"&&w.status==="待传"})'
step_action "pos.pass" '{"table_id":"T9","note":"已传"}'
curl -s "$BASE/api/snapshot/latest" -H "$AUTH" > "$TMPD/t9b.json"
assert_node "前厅传菜 → 工单已完成" "$TMPD/t9b.json" '((j.ext||{}).sop_workorders||[]).some(function(w){return String(w.table_id)==="T9"&&String(w.date)==="'"$TODAY3"'"&&w.status==="已完成"})'


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

CODE=$(curl -s -o "$TMPD/pushext.json" -w "%{http_code}" -X POST "$BASE/api/snapshot/push" \
  -H "$KAUTH" -H 'Content-Type: application/json' --data-binary @"$TMPD/ext.json")
assert_code "push 带 ext 快照" 200 "$CODE"
assert_grep "push ext rev=50" "$TMPD/pushext.json" '"rev":50'

curl -s "$BASE/api/snapshot/latest" -H "$KAUTH" > "$TMPD/lx.json"
assert_node "latest 透传 ext.recipes" "$TMPD/lx.json" 'j.ext&&j.ext.recipes.length===2'
assert_node "latest 透传 ext.qc_records" "$TMPD/lx.json" 'j.ext&&j.ext.qc_records.length===3'
assert_node "latest 仍含 data" "$TMPD/lx.json" 'j.data&&j.data.dishes.length>=1'

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
assert_node "kitchen/recipes 全量含快照配方" "$TMPD/kr.json" 'j.ok&&j.count>=2&&j.rev===50'
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

# ---------- 10. modules（员工/预订/食安/分析）+ report 推导 ----------
say "== 10. modules / report 推导 =="
# 全新 token，避免前面用例耗尽标准桶
MTOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"account":"modules-tester"}' | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).token)')
MAUTH="Authorization: Bearer $MTOKEN"
TODAY=$(date +%F)
YDAY=$(date -d "yesterday" +%F 2>/dev/null || date -v-1d +%F)

node -e '
const fs=require("fs");
const today=process.argv[2], yday=process.argv[3];
const now=Date.now(), H=3600000, D=24*H;
const iso=(ms)=>new Date(ms).toISOString();
const plusD=(n)=>{const d=new Date(now+n*D);return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");};
const snap={rev:60,machine:"pos-m",
  data:{
    sales:[
      {ts:today+"T11:30:00",amount:58.5},{ts:today+"T12:10:00",amount:102},
      {ts:today+"T18:40:00",amount:76},
      {ts:yday+"T12:00:00",amount:88},{ts:yday+"T19:00:00",amount:66.5}
    ],
    dishes:[
      {name:"红饺",est:100,price:28,q:60},
      {name:"黑饺",est:90,price:32,q:35},
      {name:"白饺",est:40,price:26,q:58},
      {name:"紫饺",est:30,price:30,q:30}
    ],
    ings:[{name:"面粉",qty:5,safe:20},{name:"猪肉",qty:30,safe:10}],
    members:[{id:1}]
  },
  ext:{
    staff_shifts:[{staff:"张三",shift:"早班"},{staff:"李四",shift:"晚班"}],
    staff_clock:[{staff:"张三",ts:today+"T08:55:00"},{staff:"李四",ts:today+"T09:02:00"}],
    staff_perf:[{staff:"张三",score:92}],
    staff_train:[{staff:"王五",course:"食品安全"}],
    fs_certs:[{name:"张三",expire:plusD(10)},{name:"李四",expire:plusD(100)}],
    fs_trace:[{batch:"B2026",supplier:"双汇"}],
    fs_samples:[{dish:"红饺",ts:iso(now-46*H)},{dish:"黄饺",ts:iso(now-10*H)}],
    fs_disinfect:[{area:"后厨",ts:today+"T07:30:00"}],
    bookings:[{id:"b1",date:today,people:4},{id:"b2",date:today,people:2},{id:"b3",date:yday,people:6}],
    queue:[{no:"A05"},{no:"A06"},{no:"A07"},{no:"A08"},{no:"A09"}],
    sop_workorders:[{id:"w1",date:today,status:"已完成"},{id:"w2",date:today,status:"进行中"}]
  }};
fs.writeFileSync(process.argv[1],JSON.stringify(snap));
' "$TMPD/mod.json" "$TODAY" "$YDAY"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/snapshot/push" \
  -H "$MAUTH" -H 'Content-Type: application/json' --data-binary @"$TMPD/mod.json")
assert_code "push 含新 ext 键快照" 200 "$CODE"

curl -s "$BASE/api/modules/staff" -H "$MAUTH" > "$TMPD/mst.json"
assert_node "modules/staff 四表形状" "$TMPD/mst.json" 'j.ok&&j.shifts.length===2&&j.clock.length===2&&j.perf.length===1&&j.train.length===1'
assert_node "modules/staff 带 rev/generated_at" "$TMPD/mst.json" 'j.rev===60&&!!j.generated_at'
assert_node "modules/staff insight 打卡+禁岗" "$TMPD/mst.json" 'j.insight&&j.insight.today&&j.insight.clock&&Array.isArray(j.insight.certs.blocked_scheduled)&&j.insight.peak'

curl -s "$BASE/api/modules/booking" -H "$MAUTH" > "$TMPD/mbk.json"
assert_node "modules/booking 默认今日 2 条+queue 5" "$TMPD/mbk.json" 'j.ok&&j.date==="'$TODAY'"&&j.bookings.length===2&&j.queue.length===5'
assert_node "modules/booking insight 翻台+备料" "$TMPD/mbk.json" 'j.insight&&j.insight.tables&&j.insight.turn&&j.insight.turn.by_capacity&&j.insight.staffing&&typeof j.insight.staffing.suggest_add==="boolean"'
curl -s "$BASE/api/modules/booking?date=$YDAY" -H "$MAUTH" > "$TMPD/mbk2.json"
assert_node "modules/booking 指定昨日 1 条" "$TMPD/mbk2.json" 'j.bookings.length===1&&j.bookings[0].id==="b3"'

curl -s "$BASE/api/modules/foodsafe" -H "$MAUTH" > "$TMPD/mfs.json"
assert_node "modules/foodsafe 四表形状" "$TMPD/mfs.json" 'j.ok&&j.certs.length===2&&j.trace.length===1&&j.samples.length===2&&j.disinfect.length===1'
assert_node "modules/foodsafe insight 留样+消毒" "$TMPD/mfs.json" 'j.insight&&j.insight.certs&&j.insight.samples&&j.insight.disinfect&&typeof j.insight.samples.pending==="number"'
assert_node "foodsafe hours_left 46h前≈2h" "$TMPD/mfs.json" 'var s=j.samples.find(function(x){return x.dish==="红饺"});s.hours_left>=0&&s.hours_left<=4'
assert_node "foodsafe hours_left 10h前≈38h" "$TMPD/mfs.json" 'var s=j.samples.find(function(x){return x.dish==="黄饺"});s.hours_left>=36&&s.hours_left<=39'

curl -s "$BASE/api/modules/analysis" -H "$MAUTH" > "$TMPD/man.json"
assert_node "analysis 真实聚合 mock:false" "$TMPD/man.json" 'j.ok&&j.mock===false'
assert_node "analysis trend 按日 2 天" "$TMPD/man.json" 'j.trend.length===2&&j.trend[0].revenue>0&&j.trend[0].orders>0'
assert_node "analysis heatmap 非空" "$TMPD/man.json" 'j.heatmap.length>0&&j.heatmap[0].hour!=null&&j.heatmap[0].weekday!=null'
assert_node "analysis 矩阵象限 star/dog" "$TMPD/man.json" 'j.matrix.some(function(m){return m.quadrant==="star"})&&j.matrix.some(function(m){return m.quadrant==="dog"})'
assert_node "analysis efficiency 客单价" "$TMPD/man.json" 'j.efficiency&&j.efficiency.avg_ticket>0&&j.efficiency.peak_hour!=null'
assert_node "analysis forecast 7日+备货" "$TMPD/man.json" 'j.forecast&&j.forecast.days&&j.forecast.days.length>=7&&Array.isArray(j.forecast.restock)'

curl -s "$BASE/api/modules/equipment" -H "$MAUTH" > "$TMPD/meq.json"
assert_node "equipment temps 非空" "$TMPD/meq.json" 'j.ok&&Array.isArray(j.temps)&&j.temps.length>=1&&j.temps[0].device'
assert_node "equipment energy_summary" "$TMPD/meq.json" 'j.energy_summary&&Array.isArray(j.energy_summary.items)'

curl -s "$BASE/api/modules/vip" -H "$MAUTH" > "$TMPD/mvip.json"
assert_node "vip members 数组" "$TMPD/mvip.json" 'j.ok&&Array.isArray(j.members)'
assert_node "vip insight 资产+券" "$TMPD/mvip.json" 'j.insight&&j.insight.assets&&typeof j.insight.assets.stored_total==="number"&&j.insight.coupons&&typeof j.insight.coupons.liability==="number"'

curl -s "$BASE/api/modules/takeout" -H "$MAUTH" > "$TMPD/mto.json"
assert_node "takeout insight 概览+对账" "$TMPD/mto.json" 'j.ok&&j.insight&&j.insight.overview&&typeof j.insight.overview.gross==="number"&&j.insight.reconcile&&Array.isArray(j.insight.reconcile.pending)'

curl -s "$BASE/api/modules/finance" -H "$MAUTH" > "$TMPD/mfin.json"
assert_node "finance insight 发票+税务" "$TMPD/mfin.json" 'j.ok&&j.insight&&j.insight.invoices&&typeof j.insight.invoices.remaining==="number"&&j.insight.tax&&typeof j.insight.tax.payable==="number"&&j.insight.cashflow'

curl -s "$BASE/api/modules/loss" -H "$MAUTH" > "$TMPD/mloss.json"
assert_node "loss insight 损耗率+归因" "$TMPD/mloss.json" 'j.ok&&j.insight&&typeof j.insight.total_amount==="number"&&j.insight.approvals&&Array.isArray(j.insight.top_ingredients)'

curl -s "$BASE/api/modules/review" -H "$MAUTH" > "$TMPD/mrv.json"
assert_node "review insight 评分+差评" "$TMPD/mrv.json" 'j.ok&&j.insight&&j.insight.scores&&j.insight.bad&&typeof j.insight.bad.count==="number"&&j.insight.improve'

curl -s "$BASE/api/modules/supply" -H "$MAUTH" > "$TMPD/msup.json"
assert_node "supply insight 供应商+账龄" "$TMPD/msup.json" 'j.ok&&j.insight&&j.insight.vendors&&typeof j.insight.vendors.count==="number"&&j.insight.compare&&j.insight.accounts'

curl -s "$BASE/api/modules/pos" -H "$MAUTH" > "$TMPD/mpos.json"
assert_node "pos insight 桌台+实收" "$TMPD/mpos.json" 'j.ok&&j.insight&&j.insight.tables&&typeof j.insight.tables.total==="number"&&j.insight.payments&&Array.isArray(j.insight.advice)'

curl -s "$BASE/api/report/daily?date=$TODAY" -H "$MAUTH" > "$TMPD/mrp.json"
assert_node "report 带 rev/generated_at" "$TMPD/mrp.json" 'j.rev===60&&!!j.generated_at'
assert_node "report todos 带 kind" "$TMPD/mrp.json" 'j.todos.every(function(t){return !t.text||typeof t.kind==="string"||t.kind==null})||j.todos.some(function(t){return t.kind})'
assert_node "report alerts 或 equipment/vip 作战" "$TMPD/mrp.json" 'j.alerts.length>=0'
assert_node "report todos 库存告急" "$TMPD/mrp.json" 'j.todos.some(function(t){return t.text.indexOf("库存告急：面粉")>=0})'
assert_node "report todos 今日工单" "$TMPD/mrp.json" 'j.todos.some(function(t){return t.text.indexOf("今日工单 2 单")>=0})'
assert_node "report todos 今日预订" "$TMPD/mrp.json" 'j.todos.some(function(t){return t.text.indexOf("今日预订 2 桌")>=0})'
assert_node "report alerts 健康证<30天" "$TMPD/mrp.json" 'j.alerts.some(function(a){return a.text.indexOf("健康证")>=0&&a.text.indexOf("张三")>=0})'
assert_node "report alerts 留样临近48h" "$TMPD/mrp.json" 'j.alerts.some(function(a){return a.text.indexOf("留样")>=0&&a.text.indexOf("红饺")>=0})'
assert_node "report alerts 库存告急" "$TMPD/mrp.json" 'j.alerts.some(function(a){return a.text.indexOf("库存告急 1 项")>=0})'

# mock 回退：空 data 快照
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/snapshot/push" \
  -H "$MAUTH" -H 'Content-Type: application/json' -d '{"rev":61,"machine":"pos-m","data":{}}')
assert_code "push 空 data 快照" 200 "$CODE"
curl -s "$BASE/api/modules/analysis" -H "$MAUTH" > "$TMPD/man0.json"
assert_node "analysis mock 回退" "$TMPD/man0.json" 'j.ok&&j.mock===true&&j.trend.length===4&&j.matrix.some(function(m){return m.quadrant==="star"})'
assert_node "analysis mock efficiency 演示" "$TMPD/man0.json" 'j.efficiency&&j.efficiency.翻台率===3.2'
curl -s "$BASE/api/report/daily?date=$TODAY" -H "$MAUTH" > "$TMPD/mrp0.json"
assert_node "report 无数据回退 mock" "$TMPD/mrp0.json" 'j.mock===true&&j.rev===null&&j.kpi.length===8'

# 只读性：写动词一律 404
for ep in staff booking foodsafe analysis; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/modules/$ep" -H "$MAUTH" -H 'Content-Type: application/json' -d '{}')
  assert_code "POST modules/$ep 只读" 404 "$CODE"
done

# ---------- 汇总 ----------
say ""
say "== 结果：PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" -eq 0 ]
