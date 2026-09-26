#!/usr/bin/env bash
# 原生 Android / 全闭环联调一键拉起：店内 → BFF → 推快照 → queue_consumer 常驻 → pusher 常驻
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少命令: $1"; exit 1; }; }
need python3
need node
need curl

PIDDIR=/tmp/canteenAI-pids
mkdir -p "$PIDDIR"

start_bg() {
  local name="$1" cmd="$2" log="$3"
  if [[ -f "$PIDDIR/$name.pid" ]] && kill -0 "$(cat "$PIDDIR/$name.pid")" 2>/dev/null; then
    echo "  · $name 已在跑 pid=$(cat "$PIDDIR/$name.pid")"
    return
  fi
  bash -c "$cmd" >"$log" 2>&1 &
  echo $! >"$PIDDIR/$name.pid"
  echo "  · $name 启动 pid=$! log=$log"
}

echo "==> 1) 店内进销存 :8765"
if ! curl -sf -m 2 http://127.0.0.1:8765/api/health >/dev/null; then
  start_bg store "cd '$ROOT/store-inventory' && python3 server/app.py" /tmp/canteen-inv.log
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    curl -sf -m 2 http://127.0.0.1:8765/api/health >/dev/null && break
  done
fi
curl -sf -m 3 http://127.0.0.1:8765/api/health | head -c 200; echo

echo "==> 2) BFF :8787"
if ! curl -sf -m 2 http://127.0.0.1:8787/api/health >/dev/null; then
  start_bg bff "cd '$ROOT/bff' && node server.js" /tmp/canteen-bff.log
  for i in 1 2 3 4 5; do
    sleep 1
    curl -sf -m 2 http://127.0.0.1:8787/api/health >/dev/null && break
  done
fi
curl -sf -m 3 http://127.0.0.1:8787/api/health | head -c 200; echo

echo "==> 3) 登录拿 token"
TOKEN=$(curl -sf -X POST http://127.0.0.1:8787/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"account":"boss","device_fp":"dev-up-native"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))")
if [[ -z "$TOKEN" ]]; then
  echo "登录失败"; exit 1
fi
echo "  token ok"

echo "==> 4) 推送快照（一次）"
BFF_TOKEN="$TOKEN" python3 store-inventory/snapshot_pusher.py --once --token "$TOKEN" | tail -3

echo "==> 5) queue_consumer 常驻（5s）"
start_bg consumer \
  "cd '$ROOT' && BFF_TOKEN='$TOKEN' python3 store-inventory/queue_consumer.py --interval 5 --token '$TOKEN'" \
  /tmp/canteen-consumer.log

echo "==> 6) snapshot_pusher 常驻（60s）"
start_bg pusher \
  "cd '$ROOT' && BFF_TOKEN='$TOKEN' python3 store-inventory/snapshot_pusher.py --interval 60 --token '$TOKEN'" \
  /tmp/canteen-pusher.log

echo ""
echo "就绪（原生 App 联调）："
echo "  BFF       http://127.0.0.1:8787/api/health"
echo "  进销存    http://127.0.0.1:8765/"
echo "  consumer  /tmp/canteen-consumer.log"
echo "  pusher    /tmp/canteen-pusher.log"
echo "  APK       apps/android-app/app/build/outputs/apk/debug/app-debug.apk"
echo "  模拟器 BFF 默认 10.0.2.2:8787；真机改 local.properties bff.base.url"
echo "停止：kill \$(cat $PIDDIR/*.pid)"
