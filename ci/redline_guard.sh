#!/usr/bin/env bash
# 红线守卫：受保护文件零改动 + 后台无旁路写 + 无硬编码 Key
# 用法: ci/redline_guard.sh   （在仓库根目录执行，任一检查失败即非零退出）
set -u
cd "$(dirname "$0")/.."
FAIL=0

echo "== R3/R4 受保护文件哈希基线 =="
if sha256sum -c ci/redline_baseline.sha256; then
  echo "OK: 受保护文件零改动"
else
  echo "FAIL: 受保护文件被修改（bff/store-node/db.js|merge.js 为店内存储核心，零改动）"
  FAIL=1
fi

echo "== R13 后台无旁路写 =="
# admin-web 与 bff admin 路由禁止直连店内 /api/sync 或 sqlite 写
HITS=$(grep -rn --include='*.ts' --include='*.tsx' --include='*.js' \
  -E 'api/sync|sqlite3|餐厅系统\.db' \
  apps/admin-web/src bff/routes/admin 2>/dev/null | grep -v '禁止\|红线\|bypass' || true)
if [ -n "$HITS" ]; then
  echo "FAIL: 发现疑似旁路写路径:"; echo "$HITS"
  FAIL=1
else
  echo "OK: 后台写操作均指向 /api/actions 队列"
fi

echo "== R5 无硬编码密钥 =="
KEYS=$(grep -rn -E 'sk-[A-Za-z0-9]{20,}' \
  --include='*.js' --include='*.ts' --include='*.tsx' --include='*.py' \
  --include='*.kt' --include='*.swift' \
  bff apps kmp-shared store-inventory 2>/dev/null \
  | grep -v node_modules || true)
if [ -n "$KEYS" ]; then
  echo "FAIL: 发现疑似硬编码 Key:"; echo "$KEYS"
  FAIL=1
else
  echo "OK: 无硬编码 Key"
fi

echo "== R10 图片不落库（BFF 侧）=="
if grep -rn --include='*.js' -E 'writeFileSync.*imageBase64|imageBase64.*writeFile' bff 2>/dev/null | grep -v node_modules; then
  echo "FAIL: 图片疑似落盘"
  FAIL=1
else
  echo "OK: 图片仅内存传递"
fi

if [ "$FAIL" -eq 0 ]; then
  echo "== 红线守卫全部通过 =="
else
  echo "== 红线守卫未通过 =="
fi
exit $FAIL
