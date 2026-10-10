#!/usr/bin/env bash
# 局域网一键联调（多岗位真实登录 + 真机/多设备测试）
#   - BFF 绑 0.0.0.0，手机与外网同 Wi-Fi 即可直连（无需 adb reverse）
#   - 自动探测本机局域网 IP，可选把 App 指向该 IP 并构建安装到已连接设备
#   - 默认把测试岗位账号密码重置为 wufu123，保证 App 一键登录可用
#
# 用法：
#   bash scripts/dev-up-lan.sh            # 起服务（店内节点/BFF/consumer/pusher/管理后台）
#   bash scripts/dev-up-lan.sh --app      # 额外：把 App 指向局域网 IP，构建并安装到设备
#   bash scripts/dev-up-lan.sh --no-reset # 不重置测试账号密码
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BUILD_APP=0
RESET_PW=1
for arg in "$@"; do
  case "$arg" in
    --app) BUILD_APP=1 ;;
    --no-reset) RESET_PW=0 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少命令: $1"; exit 1; }; }
need node
need curl

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "警告：当前 Node $(node -v)，node:sqlite 需 Node 22.5+，请升级（推荐 24）"
fi

detect_lan_ip() {
  local ip=""
  ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
  if [ -z "$ip" ]; then ip="$(hostname -I 2>/dev/null | awk '{print $1}')"; fi
  printf '%s' "$ip"
}

LAN_IP="$(detect_lan_ip)"
if [ -z "$LAN_IP" ]; then
  echo "无法探测局域网 IP，请手动设置（如 BFF_HOST=0.0.0.0 后把 BFF_BASE_URL 指向本机 IP）"
  exit 1
fi
BFF_PORT="${BFF_PORT:-8787}"
ADMIN_PORT="${ADMIN_PORT:-5173}"

PIDDIR=/tmp/canteenAI-lan-pids
mkdir -p "$PIDDIR"

start_bg() {
  local name="$1" cmd="$2" log="$3"
  if [[ -f "$PIDDIR/$name.pid" ]] && kill -0 "$(cat "$PIDDIR/$name.pid")" 2>/dev/null; then
    echo "  · $name 已在跑 pid=$(cat "$PIDDIR/$name.pid")"
    return
  fi
  setsid bash -c "$cmd" >"$log" 2>&1 </dev/null &
  echo $! >"$PIDDIR/$name.pid"
  echo "  · $name 启动 pid=$! log=$log"
}

# 是否已有同类常驻进程（无论由谁启动），避免重复消费/重复推送
proc_running() { pgrep -f "$1" >/dev/null 2>&1; }

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

echo "==> 局域网 IP: $LAN_IP  (BFF http://$LAN_IP:$BFF_PORT) =="

if [ "$RESET_PW" -eq 1 ]; then
  echo "==> 重置测试岗位账号密码为 wufu123（--no-reset 可跳过）"
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const { scryptSync, randomBytes } = require("crypto");
    let org;
    try { org = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { console.log("  · org.json 不存在，跳过（首个登录会自动种子）"); process.exit(0); }
    const accs = ["boss", "manager", "cashier", "kitchen", "finance", "newbie"];
    let n = 0;
    for (const a of accs) {
      const u = (org.users || []).find((x) => x.account === a);
      if (!u) continue;
      const salt = randomBytes(16).toString("hex");
      u.password_salt = salt;
      u.password_hash = scryptSync("wufu123", salt, 32).toString("hex");
      n += 1;
    }
    fs.writeFileSync(p, JSON.stringify(org, null, 2));
    console.log("  · 已重置 " + n + " 个账号");
  ' "$ROOT/bff/data/org.json"
fi

echo "==> 1) 店内数据节点(Node) :8765  db=$STORE_DB"
if ! curl -sf -m 2 http://127.0.0.1:8765/api/health >/dev/null; then
  start_bg store "cd '$ROOT' && node bff/store-node/server.js --port 8765 --db '$STORE_DB'" /tmp/canteen-inv.log
  for i in $(seq 1 10); do sleep 1; curl -sf -m 2 http://127.0.0.1:8765/api/health >/dev/null && break; done
fi
curl -sf -m 3 http://127.0.0.1:8765/api/health | head -c 120; echo

echo "==> 2) BFF :$BFF_PORT（绑 0.0.0.0，允许局域网）"
if ! curl -sf -m 2 http://127.0.0.1:$BFF_PORT/api/health >/dev/null; then
  start_bg bff "cd '$ROOT/bff' && BFF_HOST=0.0.0.0 BFF_PORT=$BFF_PORT ALLOW_DEMO_LOGIN=1 node server.js" /tmp/canteen-bff.log
  for i in $(seq 1 8); do sleep 1; curl -sf -m 2 http://127.0.0.1:$BFF_PORT/api/health >/dev/null && break; done
fi
curl -sf -m 3 http://127.0.0.1:$BFF_PORT/api/health | head -c 200; echo

echo "==> 3) 登录拿 token（boss）"
TOKEN=$(curl -sf -X POST http://127.0.0.1:$BFF_PORT/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"account":"boss","password":"wufu123","device_fp":"dev-up-lan"}' \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).token||'')}catch(e){}})")
if [[ -z "$TOKEN" ]]; then echo "登录失败（检查 org.json 账号）"; exit 1; fi
echo "  token ok"

echo "==> 4) 推送快照（一次）"
BFF_TOKEN="$TOKEN" node bff/store-node/pusher.js --once --store-url http://127.0.0.1:8765 \
  --bff-url http://127.0.0.1:$BFF_PORT --token "$TOKEN" --db "$STORE_DB" | tail -2

echo "==> 5) consumer 常驻（5s，token 失效自动续期）"
if proc_running "store-node/consumer.js"; then
  echo "  · consumer 已在跑，复用（避免重复消费）"
else
  start_bg consumer \
    "cd '$ROOT' && BFF_TOKEN='$TOKEN' BFF_ACCOUNT='boss' BFF_PASSWORD='wufu123' node bff/store-node/consumer.js --interval 5 --store-url http://127.0.0.1:8765 --bff-url http://127.0.0.1:$BFF_PORT --token '$TOKEN' --account boss --password wufu123 --db '$STORE_DB'" \
    /tmp/canteen-consumer.log
fi

echo "==> 6) pusher 常驻（60s）"
if proc_running "store-node/pusher.js"; then
  echo "  · pusher 已在跑，复用（避免重复推送）"
else
  start_bg pusher \
    "cd '$ROOT' && BFF_TOKEN='$TOKEN' node bff/store-node/pusher.js --interval 60 --store-url http://127.0.0.1:8765 --bff-url http://127.0.0.1:$BFF_PORT --token '$TOKEN' --db '$STORE_DB'" \
    /tmp/canteen-pusher.log
fi

echo "==> 7) PC 管理后台 (admin-web) :$ADMIN_PORT"
if ! curl -sf -m 2 "http://127.0.0.1:$ADMIN_PORT" >/dev/null; then
  start_bg admin "cd '$ROOT/apps/admin-web' && npm run dev" /tmp/canteen-admin.log
  for i in $(seq 1 10); do sleep 1; curl -sf -m 2 "http://127.0.0.1:$ADMIN_PORT" >/dev/null && break; done
fi
echo "  · 本机 http://127.0.0.1:$ADMIN_PORT   局域网 http://$LAN_IP:$ADMIN_PORT"

if [ "$BUILD_APP" -eq 1 ]; then
  need adb
  echo "==> 8) App 指向局域网 IP 并构建安装"
  LP="$ROOT/apps/android-app/local.properties"
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const url = "http://" + process.argv[2] + ":8787";
    let s = "";
    try { s = fs.readFileSync(p, "utf8"); } catch (e) {}
    const lines = s.split(/\r?\n/);
    let found = false;
    const out = lines.map((l) => {
      if (/^\s*bff\.base\.url\s*=/.test(l)) { found = true; return "bff.base.url=" + url; }
      return l;
    });
    if (!found) out.push("bff.base.url=" + url);
    fs.writeFileSync(p, out.join("\n"));
    console.log("  · local.properties → " + url);
  ' "$LP" "$LAN_IP"
  ( cd "$ROOT/apps/android-app" && ./gradlew :app:assembleDebug --offline )
  APK="$ROOT/apps/android-app/app/build/outputs/apk/debug/app-debug.apk"
  INSTALLED=0
  while read -r serial state; do
    [ "$state" = "device" ] || continue
    echo "  · 安装到 $serial"
    adb -s "$serial" install -r "$APK" >/dev/null && INSTALLED=1
  done < <(adb devices | tail -n +2)
  [ "$INSTALLED" -eq 1 ] && echo "  · 已安装（App 内将直连 $LAN_IP:$BFF_PORT）"
fi

cat <<EOF

==================== 局域网联调就绪 ====================
局域网 IP      $LAN_IP
BFF 健康       http://127.0.0.1:$BFF_PORT/api/health
管理后台       http://$LAN_IP:$ADMIN_PORT   （平台 → App 下载）
App 安装包     http://$LAN_IP:$BFF_PORT/api/app/download
店内节点       http://127.0.0.1:8765/api/health
consumer/pusher 日志  /tmp/canteen-consumer.log · /tmp/canteen-pusher.log

多岗位一键登录（真实账号，密码 wufu123）：
  老板 boss · 店长 manager · 收银 cashier · 厨房 kitchen · 财务 finance · 只读 newbie
  · App 登录页「一键登录 · 真实岗位账号」（调试版可见）
  · 管理后台登录页底部一键登录按钮

手机准备：连同一 Wi-Fi → 扫码/浏览器打开 App 安装包地址安装 → App 内一键登录。
（App 必须用 --app 构建，使 BFF 指向 $LAN_IP；改 IP 后重跑 --app 即可）
停止：kill \$(cat $PIDDIR/*.pid)
=======================================================
EOF
