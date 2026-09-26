#!/usr/bin/env bash
# Wave2–5 多类型写回冒烟：login → enqueue → confirm → consumer --once → status=已执行
set -euo pipefail
BFF="${BFF_URL:-http://127.0.0.1:8787}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN=$(curl -sf -X POST "$BFF/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"account":"boss","device_fp":"e2e-wave"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
REV=$(curl -sf "$BFF/api/snapshot/latest" -H "Authorization: Bearer $TOKEN" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('rev'))")
echo "token ok rev=$REV"

run_one() {
  local type="$1" payload="$2"
  local aid
  aid=$(curl -sf -X POST "$BFF/api/actions" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"type\":\"$type\",\"payload\":$payload,\"operator\":\"boss\"}" \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
  curl -sf -X POST "$BFF/api/actions/$aid/confirm" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"operator\":\"boss\",\"rev\":\"$REV\"}" >/dev/null
  BFF_TOKEN=$TOKEN python3 "$ROOT/store-inventory/queue_consumer.py" --once --token "$TOKEN" >/tmp/qc_$aid.log 2>&1 || true
  local st
  st=$(curl -sf "$BFF/api/actions/$aid/status" -H "Authorization: Bearer $TOKEN" \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('status'))")
  # refresh rev for next confirm
  REV=$(curl -sf "$BFF/api/snapshot/latest" -H "Authorization: Bearer $TOKEN" \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('rev'))")
  echo "$type $aid → $st (rev now $REV)"
  [[ "$st" == "已执行" ]] || { echo "FAIL $type"; tail -20 /tmp/qc_$aid.log; exit 1; }
}

run_one "sample.log" '{"meal":"午餐","dish":"五福饺","weight_g":125,"keeper":"e2e"}'
run_one "loss.report" '{"name":"面粉","qty":1,"reason":"破损","amount":12}'
run_one "booking.upsert" '{"guest_name":"测试客","party_size":4,"status":"待确认"}'
run_one "staff.clock" '{"staff_id":"boss","kind":"上班"}'
run_one "vip.campaign" '{"campaign_type":"满减","value":10,"code":"E2E'"$(date +%s)"'"}'
run_one "equipment.maintain" '{"device":"冷藏柜-1","kind":"巡检","operator":"e2e"}'
run_one "review.followup" '{"action":"回访","owner":"e2e"}'
run_one "finance.freeze" '{"party":"合伙人","amount":100,"frozen_until":"2099-01-01"}'
run_one "pos.table_state" '{"table_id":"T2","no":"2","state":"busy","seats":4}'
run_one "pos.pay" '{"table_id":"T2","amount":88,"method":"微信"}'

echo "ALL_OK"
