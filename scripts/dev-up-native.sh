#!/usr/bin/env bash
# 原生 Android / 全闭环联调一键拉起：店内(Node) → BFF → 推快照 → consumer 常驻 → pusher 常驻
# 全部为 Node（node:sqlite），无 Python 依赖。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少命令: $1"; exit 1; }; }
need node
need curl

# node:sqlite 需要 Node 22.5+（推荐 24）
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "警告：当前 Node $(node -v)，node:sqlite 需 Node 22.5+，请升级（推荐 24）"
fi

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

STORE_DB="${STORE_DB:-$ROOT/store-inventory/data/餐厅系统.db}"

# ---- 环境标识：CANTEEN_ENV=sandbox 时强制走演练库，避免误写真实主库 ----
CANTEEN_ENV="${CANTEEN_ENV:-real}"
MAIN_DB="$ROOT/store-inventory/data/餐厅系统.db"
SANDBOX_DB="$ROOT/store-inventory/data/餐厅系统_演练.db"
if [ "$CANTEEN_ENV" = "sandbox" ]; then
  if [ "$STORE_DB" = "$MAIN_DB" ]; then
    echo "==> [sandbox] STORE_DB 未显式指定，自动切到演练库"
    STORE_DB="$SANDBOX_DB"
  fi
  if [ ! -f "$STORE_DB" ]; then
    echo "==> [sandbox] 演练库不存在，正在从主库生成 ..."
    node "$ROOT/scripts/sandbox-db.js" --init || { echo "演练库生成失败"; exit 1; }
  fi
  echo "==> [SANDBOX] 演练模式：写入 $STORE_DB（真实主库不受影响）"
elif [ "$STORE_DB" = "$SANDBOX_DB" ]; then
  echo "==> [WARN] CANTEEN_ENV=real 但 STORE_DB 指向演练库，按演练模式处理"
else
  echo "==> [REAL] 真实库模式：写入 $STORE_DB"
fi
export CANTEEN_ENV

echo "==> 1) 店内数据节点(Node) :8765  db=$STORE_DB"
if ! curl -sf -m 2 http://127.0.0.1:8765/api/health >/dev/null; then
  start_bg store "cd '$ROOT' && node bff/store-node/server.js --port 8765 --db '$STORE_DB'" /tmp/canteen-inv.log
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
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).token||'')}catch(e){}})")
if [[ -z "$TOKEN" ]]; then
  echo "登录失败"; exit 1
fi
echo "  token ok"

echo "==> 4) 推送快照（Node pusher 一次）"
BFF_TOKEN="$TOKEN" node bff/store-node/pusher.js --once --store-url http://127.0.0.1:8765 \
  --bff-url http://127.0.0.1:8787 --token "$TOKEN" --db "$STORE_DB" | tail -3

echo "==> 5) consumer 常驻（Node，5s，token 失效自动续期）"
start_bg consumer \
  "cd '$ROOT' && BFF_TOKEN='$TOKEN' BFF_ACCOUNT='${BFF_ACCOUNT:-boss}' BFF_PASSWORD='${BFF_PASSWORD:-wufu123}' node bff/store-node/consumer.js --interval 5 --store-url http://127.0.0.1:8765 --bff-url http://127.0.0.1:8787 --token '$TOKEN' --account '${BFF_ACCOUNT:-boss}' --password '${BFF_PASSWORD:-wufu123}' --db '$STORE_DB'" \
  /tmp/canteen-consumer.log

echo "==> 6) pusher 常驻（Node，60s）"
start_bg pusher \
  "cd '$ROOT' && BFF_TOKEN='$TOKEN' node bff/store-node/pusher.js --interval 60 --store-url http://127.0.0.1:8765 --bff-url http://127.0.0.1:8787 --token '$TOKEN' --db '$STORE_DB'" \
  /tmp/canteen-pusher.log

echo ""
echo "就绪（原生 App 联调）："
echo "  BFF       http://127.0.0.1:8787/api/health"
echo "  店内节点  http://127.0.0.1:8765/api/health"
echo "  consumer  /tmp/canteen-consumer.log"
echo "  pusher    /tmp/canteen-pusher.log"
echo "  APK       apps/android-app/app/build/outputs/apk/debug/app-debug.apk"
echo "  模拟器 BFF 默认 10.0.2.2:8787；真机改 local.properties bff.base.url"
echo "停止：kill \$(cat $PIDDIR/*.pid)"
