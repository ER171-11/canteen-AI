#!/usr/bin/env bash
# Wave1 写回闭环冒烟：login → restock.create → confirm → consumer --once → 查 recv
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BFF="${BFF_URL:-http://127.0.0.1:8787}"
STORE="${STORE_URL:-http://127.0.0.1:8765}"

echo "== login =="
TOKEN=$(curl -sf -X POST "$BFF/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"account":"boss","device_fp":"e2e-wave1"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
export BFF_TOKEN="$TOKEN"

echo "== snapshot rev =="
REV=$(curl -sf "$BFF/api/snapshot/latest" -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json;print(json.load(sys.stdin).get('rev'))")
echo "rev=$REV"

echo "== enqueue restock.create =="
AID=$(curl -sf -X POST "$BFF/api/actions" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"type":"restock.create","payload":{"supplier":"E2E","note":"wave1","items":[{"ing_id":"I1","name":"测试料","qty":1,"price":1}]},"operator":"boss"}' \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['id']);assert d['status']=='queued'")
echo "action=$AID"

echo "== confirm =="
curl -sf -X POST "$BFF/api/actions/$AID/confirm" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"operator\":\"boss\",\"rev\":\"$REV\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);assert d.get('ok') and d.get('status')=='待执行', d"

echo "== consume once =="
python3 "$ROOT/store-inventory/queue_consumer.py" --once --token "$TOKEN" --bff-url "$BFF" --store-url "$STORE" 2>&1 | tail -5

echo "== status =="
curl -sf "$BFF/api/actions/$AID/status" -H "Authorization: Bearer $TOKEN" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d);assert d.get('status') in ('已执行','已驳回'), d"

echo "WAVE1 E2E OK"
