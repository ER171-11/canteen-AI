#!/usr/bin/env bash
# 安卓端 SI 一键刷新：重启 BFF（加载新代码）→ adb reverse → 重新构建安装 APK → 启动。
# 用途：代码改动后，确保手机看到的是最新后端 + 最新 App（避免旧进程/旧 APK 造成“没体现”）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> 1) 重启 BFF :8787（加载最新路由：/api/inbox /api/policies /api/si/* /api/agent/stream …）"
pkill -f "node server.js" 2>/dev/null || true
sleep 1
( cd "$ROOT/bff" && nohup node server.js >/tmp/canteen-bff.log 2>&1 & )
for i in $(seq 1 20); do
  curl -sf -m 2 http://127.0.0.1:8787/api/health >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf -m 3 http://127.0.0.1:8787/api/health | head -c 200 || { echo; echo "BFF 启动失败，见 /tmp/canteen-bff.log"; exit 1; }
echo

echo "==> 2) 构建 APK"
APK="$ROOT/apps/android-app/app/build/outputs/apk/debug/app-debug.apk"
( cd "$ROOT/apps/android-app" && ./gradlew :app:assembleDebug -q )
echo "  APK: $APK"

echo "==> 3) adb reverse + 安装启动"
mapfile -t DEVICES < <(adb devices | awk 'NR>1 && $2=="device"{print $1}')
if [ -n "${ANDROID_SERIAL:-}" ]; then DEVICES=("$ANDROID_SERIAL"); fi
if [ "${#DEVICES[@]}" -eq 0 ]; then echo "无 adb 设备（先连真机/模拟器）"; exit 1; fi
for d in "${DEVICES[@]}"; do
  echo "  · $d"
  timeout 30 adb -s "$d" reverse tcp:8787 tcp:8787 >/dev/null 2>&1 || true
  timeout 240 adb -s "$d" install -r "$APK" >/dev/null 2>&1 || { echo "    安装超时/失败，跳过 $d"; continue; }
  timeout 20 adb -s "$d" shell am force-stop com.pandawufu.app >/dev/null 2>&1 || true
  timeout 20 adb -s "$d" shell am start -n com.pandawufu.app/.MainActivity >/dev/null 2>&1 || true
done
echo "==> 完成：BFF 已重启、APK 已安装并启动。"
