#!/usr/bin/env bash
# 熊猫五福 · 本地演示一键拉起（店内 → BFF → 推快照 → boss-app）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少命令: $1"; exit 1; }; }
need python3
need node
need curl

echo "==> 1) 店内进销存 :8765"
if ! curl -sf -m 2 http://127.0.0.1:8765/api/health >/dev/null; then
  (cd store-inventory && python3 server/app.py) >/tmp/canteen-inv.log 2>&1 &
  sleep 1
fi
curl -sf -m 3 http://127.0.0.1:8765/api/health | head -c 200; echo

echo "==> 2) BFF :8787"
if ! curl -sf -m 2 http://127.0.0.1:8787/health >/dev/null; then
  (cd bff && node server.js) >/tmp/canteen-bff.log 2>&1 &
  sleep 1
fi
curl -sf -m 3 http://127.0.0.1:8787/health | head -c 200; echo

echo "==> 3) 推送快照（常青）"
TOKEN=$(curl -sf -X POST http://127.0.0.1:8787/api/admin/login \
  -H 'Content-Type: application/json' \
  -d '{"account":"boss","device_fp":"dev-up"}' | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))")
if [[ -z "$TOKEN" ]]; then
  echo "登录失败，跳过推送"
else
  BFF_TOKEN="$TOKEN" python3 store-inventory/snapshot_pusher.py --once
fi

echo "==> 4) boss-app :5174"
if ! curl -sf -m 2 -o /dev/null http://127.0.0.1:5174/; then
  (cd apps/boss-app && npm run dev -- --host 127.0.0.1 --port 5174) >/tmp/canteen-boss.log 2>&1 &
  sleep 2
fi

echo ""
echo "就绪："
echo "  老板 App  http://127.0.0.1:5174/"
echo "  BFF       http://127.0.0.1:8787/health"
echo "  进销存    http://127.0.0.1:8765/"
echo "角标应显示「真数据 · rev N」（若仍 mock，再跑一次 snapshot_pusher --once）"
