#!/usr/bin/env node
'use strict';
/*
 * scripts/scan-mock-usage.js — 模拟/演示数据扫描与清理辅助（过渡期临时工具 B）
 *
 * 定位：仅做「发现 + 统计 + 标注 + 预览」，默认不改业务代码。
 *       淘汰完成后本脚本连同前端运行时开关一并移除。
 *
 * 用法：
 *   node scripts/scan-mock-usage.js           # 扫描并生成 docs/数据与接口/模拟数据清单.md
 *   node scripts/scan-mock-usage.js --md      # 同上（显式）
 *   node scripts/scan-mock-usage.js --json    # 仅打印结构化 JSON（stdout）
 *   node scripts/scan-mock-usage.js --mark    # 在命中「定义行」上方插入 // TODO(mock-removal) 标记
 *   node scripts/scan-mock-usage.js --apply   # 移除预览（dry-run，只打印不落盘）
 *   node scripts/scan-mock-usage.js --db      # 额外统计门店库 source='demo_proto' 行数（需 node:sqlite）
 *   node scripts/scan-mock-usage.js --check   # 有命中则退出码 1（淘汰完成后用于 CI 断言「无残留」）
 *   node scripts/scan-mock-usage.js --quiet   # 不打印控制台明细
 *
 * 扫描范围：apps/admin-web/src、bff/routes、bff/lib、bff/store-node、scripts
 * 排除：node_modules / dist / build / .vite / coverage / .git
 *      以及归档副本 old、canteenAI-handoff-*、canteenAI other（不在本仓库改动范围）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ARGV = process.argv.slice(2);
const has = (f) => ARGV.indexOf(f) >= 0;

const OUT_MD = path.join(ROOT, 'docs', '数据与接口', '模拟数据清单.md');

const OPT = {
  json: has('--json'),
  mark: has('--mark'),
  apply: has('--apply'),
  db: has('--db'),
  quiet: has('--quiet'),
  check: has('--check'),
};
OPT.md = has('--md') || (!OPT.json && !OPT.mark && !OPT.apply && !OPT.check);

/* 归档副本，不扫描 */
const EXCLUDE_DIRS = new Set([
  'node_modules', 'dist', 'build', '.vite', 'coverage', '.git',
  'old', 'canteenAI-handoff-20261009', 'canteenAI other',
]);

/*
 * 受控残留：数据来源标记、UI 文案、脚本工具自身的字符串。
 * 它们不构成「界面上的假数据」，因此不参与 --check 阻断，但仍列在清单中供复核。
 */
const CONTROLLED_RULES = new Set([
  'BFF-MOCK-MARK', 'SEED-DEMO', 'SEED-DEMO-NOTE', 'SCRIPT-DEMO', 'FE-DEMO-TEXT',
])

/* ------------------------------------------------------------------ 规则 */

/*
 * scope：以相对路径前缀匹配（统一用 '/' 分隔）。
 * re   ：命中任意一处即计入明细。
 * defRe：命中「定义行」的严格正则，仅 --mark 使用（避免给引用行到处插注释）。
 */
const RULES = [
  {
    id: 'FE-MOCK-CONST',
    cat: '前端硬编码',
    scope: 'apps/admin-web/src',
    re: /\bMOCK_[A-Z0-9_]+\b/,
    defRe: /^\s*export\s+const\s+MOCK_[A-Z0-9_]+\b/,
    note: '集中/内联 mock 常量',
  },
  {
    id: 'FE-FALLBACK',
    cat: '前端回退点',
    scope: 'apps/admin-web/src',
    re: /(?:const|function)\s+mock[A-Z][A-Za-z0-9_]*\b|\bfallback\s*\(|mockOrBlank\s*\(/,
    defRe: /^\s*(?:export\s+)?(?:const|function)\s+mock[A-Z][A-Za-z0-9_]*\b|^\s*(?:const|function)\s+fallback\b/,
    note: '请求失败/空数据时回退到内置数据',
  },
  {
    id: 'FE-DEMO-TEXT',
    cat: '前端演示文案',
    scope: 'apps/admin-web/src',
    re: /内置演示数据|演示数据|演示模式/,
    defRe: null,
    note: '明示「演示数据」的 UI 文案',
  },
  {
    id: 'BFF-MOCK-MARK',
    cat: 'BFF mock 标记',
    scope: 'bff/',
    re: /\bmock\s*:\s*true\b|\bmockReport\b|\bmockAnalysis\b|\bmock_temps\b|\bequipmentTemps\b/,
    defRe: /^\s*(?:const|function)\s+(?:mockReport|mockAnalysis|mock_temps|equipmentTemps)\b/,
    note: '无真实数据时回退合成/原型数据',
  },
  {
    id: 'SEED-DEMO',
    cat: 'seed 演示注入',
    scope: 'bff/',
    re: /demo_proto/,
    defRe: null,
    note: "种子数据来源标记 source='demo_proto'",
  },
  {
    id: 'SEED-DEMO-NOTE',
    cat: 'seed 演示注入',
    scope: 'bff/store-node/seed/',
    re: /演示单|原型数据|静态演示/,
    defRe: null,
    note: '种子脚本中的演示数据说明',
  },
  {
    id: 'SCRIPT-DEMO',
    cat: '脚本层演示',
    scope: 'scripts/',
    re: /demo_proto|演示数据/,
    defRe: null,
    note: '脚本层的演示数据操作',
  },
];

const TARGET_DIRS = [
  { rel: 'apps/admin-web/src', label: '前端', exts: ['.ts', '.tsx', '.js', '.jsx', '.css'] },
  { rel: 'bff/routes', label: 'BFF路由', exts: ['.js'] },
  { rel: 'bff/lib', label: 'BFF库', exts: ['.js'] },
  { rel: 'bff/store-node', label: '店内节点', exts: ['.js', '.sql'] },
  { rel: 'scripts', label: '脚本', exts: ['.js', '.ps1', '.sh'] },
];

/* ------------------------------------------------------------------ 工具 */

const toRel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');
const indentOf = (s) => {
  const m = /^(\s*)/.exec(s);
  return m ? m[1] : '';
};
const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  );
}

function walk(dir, exts, out) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), exts, out);
    } else if (e.isFile()) {
      if (exts && !exts.some((x) => e.name.endsWith(x))) continue;
      out.push(path.join(dir, e.name));
    }
  }
}

/* ------------------------------------------------------------------ 扫描 */

function scanCode() {
  const hits = [];
  const seen = new Set();
  for (const t of TARGET_DIRS) {
    const files = [];
    walk(path.join(ROOT, t.rel), t.exts, files);
    for (const f of files) {
      const rel = toRel(f);
      let text;
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch (e) {
        continue;
      }
      if (text.indexOf('\u0000') >= 0) continue; /* 跳过二进制 */
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        if (ln.length > 500) continue;
        for (const r of RULES) {
          if (rel.indexOf(r.scope) !== 0) continue;
          if (!r.re.test(ln)) continue;
          const key = rel + ':' + (i + 1) + ':' + r.id;
          if (seen.has(key)) continue;
          seen.add(key);
          hits.push({
            rel: rel,
            line: i + 1,
            text: ln.trim().slice(0, 200),
            ruleId: r.id,
            cat: r.cat,
            note: r.note,
            isDef: r.defRe ? r.defRe.test(ln) : false,
          });
        }
      }
    }
  }
  hits.sort((a, b) => (a.cat === b.cat ? (a.rel === b.rel ? a.line - b.line : a.rel < b.rel ? -1 : 1) : a.cat < b.cat ? -1 : 1));
  return hits;
}

function summarize(hits) {
  const cats = new Map();
  for (const h of hits) {
    if (!cats.has(h.cat)) cats.set(h.cat, { cat: h.cat, lines: 0, files: new Set() });
    const c = cats.get(h.cat);
    c.lines += 1;
    c.files.add(h.rel);
  }
  const rows = [...cats.values()].map((c) => ({ cat: c.cat, lines: c.lines, files: c.files.size }));
  rows.sort((a, b) => b.lines - a.lines);
  return {
    total: hits.length,
    fileCount: new Set(hits.map((h) => h.rel)).size,
    byCat: rows,
  };
}

/* ------------------------------------------------------------------ 门店库 */

function scanDb() {
  const dbPath = path.join(ROOT, 'store-inventory', 'data', '餐厅系统.db');
  if (!fs.existsSync(dbPath)) return { ok: false, error: 'db 不存在: ' + toRel(dbPath) };
  let DatabaseSync;
  try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
  } catch (e) {
    return { ok: false, error: '当前 Node 不支持 node:sqlite，跳过 DB 统计' };
  }
  let db;
  try {
    db = new DatabaseSync(dbPath);
  } catch (e) {
    return { ok: false, error: '打开库失败: ' + e.message };
  }
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  const rows = [];
  for (const t of tables) {
    let cols;
    try {
      cols = db.prepare('PRAGMA table_info("' + t + '")').all().map((c) => c.name);
    } catch (e) {
      continue;
    }
    for (const col of ['source', 'src']) {
      if (cols.indexOf(col) < 0) continue;
      try {
        const n = db.prepare('SELECT COUNT(*) AS n FROM "' + t + '" WHERE "' + col + "\"='demo_proto'").get().n;
        if (n > 0) rows.push({ table: t, column: col, rows: n });
      } catch (e) {
        /* 忽略 */
      }
    }
  }
  rows.sort((a, b) => b.rows - a.rows);
  return { ok: true, path: toRel(dbPath), rows: rows };
}

/* ------------------------------------------------------------------ 输出 */

function buildMarkdown(hits, db) {
  const sum = summarize(hits);
  const L = [];
  L.push('# 模拟数据清单（扫描基线）');
  L.push('');
  L.push('- 生成命令：`node scripts/scan-mock-usage.js`');
  L.push('- 生成时间：' + stamp());
  L.push('- 扫描范围：`apps/admin-web/src`、`bff/routes`、`bff/lib`、`bff/store-node`、`scripts`');
  L.push('- 排除：归档副本 `old/`、`canteenAI-handoff-*/`、`canteenAI other/` 与 `node_modules` 等构建产物');
  L.push('- 说明：本清单是**淘汰计划的输入基线**，随淘汰进度应逐项减少；淘汰完成后 `--check` 应返回 0 命中。');
  L.push('');
  L.push('## 一、汇总');
  L.push('');
  L.push('| 分类 | 命中行 | 涉及文件 |');
  L.push('|---|---:|---:|');
  for (const r of sum.byCat) L.push('| ' + r.cat + ' | ' + r.lines + ' | ' + r.files + ' |');
  L.push('| **合计** | **' + sum.total + '** | **' + sum.fileCount + '** |');
  L.push('');

  if (db && db.ok) {
    L.push('### 门店库 `source=\'demo_proto\'` 行');
    L.push('');
    if (db.rows.length === 0) {
      L.push('（无命中）');
    } else {
      L.push('| 表 | 列 | 行数 |');
      L.push('|---|---|---:|');
      for (const r of db.rows) L.push('| ' + r.table + ' | ' + r.column + ' | ' + r.rows + ' |');
      const total = db.rows.reduce((a, b) => a + b.rows, 0);
      L.push('| **合计** |  | **' + total + '** |');
    }
    L.push('');
  } else if (db && !db.ok) {
    L.push('### 门店库');
    L.push('');
    L.push('（跳过：' + db.error + '）');
    L.push('');
  }

  L.push('## 二、明细');
  L.push('');
  const byCat = new Map();
  for (const h of hits) {
    if (!byCat.has(h.cat)) byCat.set(h.cat, []);
    byCat.get(h.cat).push(h);
  }
  for (const [cat, list] of byCat) {
    L.push('### ' + cat + '（' + list.length + ' 处）');
    L.push('');
    L.push('| 文件 | 行 | 内容 |');
    L.push('|---|---:|---|');
    for (const h of list) {
      L.push('| `' + h.rel + '` | ' + h.line + ' | `' + esc(h.text) + '` |');
    }
    L.push('');
  }
  L.push('---');
  L.push('');
  L.push('## 三、淘汰对照');
  L.push('');
  L.push('| 阶段 | 目标类别 | 处理方式 |');
  L.push('|---|---|---|');
  L.push('| 1 | 前端硬编码 + 前端回退点 + 前端演示文案 | 门控返回空态 → 分批删除常量与回退分支 |');
  L.push('| 2 | BFF mock 标记 | 移除 `mock:true` 合成分支，改真实空态（保留 `si_sim`/`analysis_sim` 推演层） |');
  L.push('| 3 | seed 演示注入 | 停用 `demo_proto` 注入（保留导入/迁移脚本） |');
  L.push('| 4 | 门店库演示行 | `scripts/clean-demo-data.js --dry` 复核后清理 |');
  L.push('');
  return L.join('\n');
}

/* ------------------------------------------------------------------ 主流程 */

function main() {
  const hits = scanCode();
  const sum = summarize(hits);
  const db = OPT.db ? scanDb() : null;

  if (OPT.json) {
    process.stdout.write(
      JSON.stringify({ generatedAt: stamp(), summary: sum, hits: hits, db: db }, null, 2) + '\n',
    );
  }

  if (OPT.apply) {
    /* dry-run：只列出将被移除的定义行，不落盘 */
    const defs = hits.filter((h) => h.isDef);
    console.log('[dry-run] 移除预览：共 ' + defs.length + ' 处 mock 定义点（不落盘）');
    for (const h of defs) {
      console.log('  - ' + h.rel + ':' + h.line + '  [' + h.ruleId + ']  ' + h.text);
    }
    console.log('提示：实际删除由人工/后续淘汰阶段执行，本工具只做预览。');
  }

  if (OPT.mark) {
    const byFile = new Map();
    for (const h of hits) {
      if (!h.isDef) continue;
      if (!byFile.has(h.rel)) byFile.set(h.rel, []);
      byFile.get(h.rel).push(h);
    }
    let changed = 0;
    for (const [rel, list] of byFile) {
      const abs = path.join(ROOT, rel);
      let lines;
      try {
        lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
      } catch (e) {
        continue;
      }
      const uniq = [...new Set(list.map((h) => h.line))].sort((a, b) => b - a);
      for (const ln of uniq) {
        const idx = ln - 1;
        const cur = lines[idx];
        if (cur == null) continue;
        const prev = lines[idx - 1];
        if (prev && prev.indexOf('TODO(mock-removal)') >= 0) continue;
        const hitInfo = list.find((h) => h.line === ln);
        lines.splice(idx, 0, indentOf(cur) + '// TODO(mock-removal): ' + hitInfo.note + ' (' + hitInfo.ruleId + ')');
        changed++;
      }
      fs.writeFileSync(abs, lines.join('\n'), 'utf8');
    }
    console.log('已标注 ' + changed + ' 处定义点（TODO(mock-removal)）。');
  }

  if (OPT.md) {
    const md = buildMarkdown(hits, db);
    fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
    fs.writeFileSync(OUT_MD, md + '\n', 'utf8');
    if (!OPT.quiet) console.log('已生成 ' + toRel(OUT_MD));
  }

  if (!OPT.quiet && !OPT.apply) {
    console.log('扫描命中：' + sum.total + ' 行 / ' + sum.fileCount + ' 文件');
    for (const r of sum.byCat) console.log('  - ' + r.cat + '：' + r.lines + ' 行 / ' + r.files + ' 文件');
    if (db && db.ok) {
      const t = db.rows.reduce((a, b) => a + b.rows, 0);
      console.log('门店库 demo_proto 行：' + t);
    }
  }

  const blocking = hits.filter((h) => !CONTROLLED_RULES.has(h.ruleId));
  if (OPT.check && blocking.length > 0) {
    console.error('✗ 仍有 ' + blocking.length + ' 处模拟数据命中（另有 ' + (hits.length - blocking.length) + ' 处受控残留：标记/文案/工具自身），淘汰未完成。');
    process.exit(1);
  }
  if (OPT.check) {
    console.log('✓ 无模拟数据残留。');
  }
}

main();
