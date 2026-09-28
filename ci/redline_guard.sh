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

echo "== R14 迁移功能清单（替代式迁移必须逐项标注状态）=="
# 规范见 docs/迁移颗粒度规范.md：以「页面/模块」为单位宣称完成 = 静默丢失功能的入口。
# 要求 docs/迁移基线/*.md 中每个 FP 行都带四态之一，未标注即失败。
if [ -d docs/迁移基线 ]; then
  BASE_FILES=$(ls docs/迁移基线/*.md 2>/dev/null || true)
  if [ -z "$BASE_FILES" ]; then
    echo "OK: 尚未建立迁移基线（未启动替代式迁移）"
  else
    for bf in $BASE_FILES; do
      TOTAL=$(grep -c '^|[[:space:]]*FP-' "$bf" || true)
      MARKED=$(grep '^|[[:space:]]*FP-' "$bf" | grep -c -E '已移植|等价替代|待补|废弃' || true)
      if [ "${TOTAL:-0}" != "${MARKED:-0}" ]; then
        echo "FAIL: $bf 存在未标注状态的功能点（已标注 ${MARKED:-0}/${TOTAL:-0}）"
        FAIL=1
      else
        echo "OK: $bf 全部 ${TOTAL:-0} 项已标注状态"
      fi
    done
  fi
else
  echo "OK: 无迁移基线目录"
fi

if [ "$FAIL" -eq 0 ]; then
  echo "== 红线守卫全部通过 =="
else
  echo "== 红线守卫未通过 =="
fi
exit $FAIL
