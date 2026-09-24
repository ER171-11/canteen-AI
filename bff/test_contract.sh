#!/usr/bin/env bash
# test_contract.sh — 熊猫五福餐厅 云端 BFF 契约自测
# 用法：bash test_contract.sh
#   脚本自行启动 node server.js（127.0.0.1:8787），跑完 curl 校验后杀掉，退出码反映成败。
set -u
cd "$(dirname "$0")"

BASE="http://127.0.0.1:8787"
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
say "== 启动 BFF =="
node server.js > "$TMPD/server.log" 2>&1 &
SRV_PID=$!
cleanup() { kill "$SRV_PID" 2>/dev/null; wait "$SRV_PID" 2>/dev/null; rm -rf "$TMPD"; }
trap cleanup EXIT

for i in $(seq 1 50); do
  curl -s -o /dev/null "$BASE/api/health" && break
  sleep 0.2
done

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

# ---------- 汇总 ----------
say ""
say "== 结果：PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" -eq 0 ]
