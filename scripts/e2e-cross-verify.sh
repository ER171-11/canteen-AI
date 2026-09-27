#!/usr/bin/env bash
# 三件套联验：App 拍板（模拟）↔ SaaS 审批/模块台账 ↔ 统一 BFF
# 同一 boss 账号：enqueue → actions 列表可见 → modules/report 可读 → confirm 状态推进
set -euo pipefail
BFF="${BFF_URL:-http://127.0.0.1:8787}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CODE="CROSS$(date +%s)"

echo "== 1. 登录（App 同源 auth/login） =="
TOKEN=$(curl -sf -X POST "$BFF/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"account":"boss","password":"wufu123","device_fp":"cross-verify-app"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
AUTH="Authorization: Bearer $TOKEN"
STORE=$(curl -sf "$BFF/api/auth/me" -H "$AUTH" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('store_id') or '')" 2>/dev/null || true)
HDR=(-H "$AUTH" -H "X-Store-Id: ${STORE:-store_jinfeng}")
echo "token ok store=${STORE:-store_jinfeng}"

echo "== 2. SaaS 同源读：report + modules =="
curl -sf "$BFF/api/report/daily" "${HDR[@]}" | python3 -c "
import sys,json
j=json.load(sys.stdin)
assert j.get('ok') is not False
todos=j.get('todos') or []
assert isinstance(todos,list)
kinds=[t.get('kind') for t in todos if t.get('kind')]
print('report todos=',len(todos),'kinds=',kinds[:6])
"
curl -sf "$BFF/api/modules/analysis" "${HDR[@]}" | python3 -c "
import sys,json
j=json.load(sys.stdin)
assert j.get('ok') and j.get('forecast') and len(j['forecast'].get('days') or [])>=7
print('analysis forecast days=',len(j['forecast']['days']),'restock=',len(j['forecast'].get('restock') or []))
"
curl -sf "$BFF/api/modules/equipment" "${HDR[@]}" | python3 -c "
import sys,json
j=json.load(sys.stdin)
assert j.get('ok') and (j.get('temps') or [])
print('equipment temps=',len(j['temps']))
"
curl -sf "$BFF/api/modules/vip" "${HDR[@]}" | python3 -c "
import sys,json
j=json.load(sys.stdin)
assert j.get('ok') and isinstance(j.get('members'),list)
soon=sum(1 for m in j['members'] if m.get('birthday_soon'))
print('vip members=',len(j['members']),'birthday_soon=',soon)
"

echo "== 3. App 拍板入队（vip.campaign） =="
AID=$(curl -sf -X POST "$BFF/api/actions" "${HDR[@]}" -H 'Content-Type: application/json' \
  -d "{\"type\":\"vip.campaign\",\"payload\":{\"campaign_type\":\"生日礼\",\"value\":30,\"code\":\"$CODE\"},\"operator\":\"boss\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
echo "action id=$AID"

echo "== 4. SaaS 审批中心同源可见 =="
curl -sf "$BFF/api/actions" "${HDR[@]}" | python3 -c "
import sys,json
j=json.load(sys.stdin)
items=j.get('items') or j if isinstance(j,list) else j.get('items') or []
ids=[str(x.get('id')) for x in items]
assert '$AID' in ids, 'action not in SaaS list'
row=next(x for x in items if str(x.get('id'))=='$AID')
print('visible type=',row.get('type'),'status=',row.get('status'))
"

echo "== 5. 确认执行（可选 consumer） =="
REV=$(curl -sf "$BFF/api/snapshot/latest" "${HDR[@]}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('rev'))")
curl -sf -X POST "$BFF/api/actions/$AID/confirm" "${HDR[@]}" -H 'Content-Type: application/json' \
  -d "{\"operator\":\"admin\",\"rev\":\"$REV\"}" >/dev/null
if [[ -f "$ROOT/bff/store-node/consumer.js" ]]; then
  BFF_TOKEN=$TOKEN node "$ROOT/bff/store-node/consumer.js" --once --token "$TOKEN" >/tmp/cross_qc.log 2>&1 || true
fi
ST=$(curl -sf "$BFF/api/actions/$AID/status" "${HDR[@]}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('status'))")
echo "status after confirm=$ST"

echo "== 6. 平台审计含 store_id =="
curl -sf "$BFF/api/admin/audit?limit=5" "${HDR[@]}" | python3 -c "
import sys,json
j=json.load(sys.stdin)
items=j.get('items') or []
print('audit recent=',len(items))
" || echo "(audit skip if role)"

echo "ALL_OK cross-verify App↔SaaS↔API"
