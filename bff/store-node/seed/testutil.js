'use strict';
/*
 * seed/testutil.js — 移植平价（差分）测试的共享工具。
 *
 * 纯 Node 内置：node:sqlite / fs / path / child_process。
 * 职责：
 *   - 准备两份完全相同的临时 sqlite（优先复制真实库，缺失则按 migrations 重建）；
 *   - 读取受影响表的行内容并做「忽略自增 id / 时间戳」的规范化快照；
 *   - 触发 Python 原实现（通过 importlib 直接调用模块函数，避免其副作用）。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { runPython: execPy, pick: pickPy } = require('../../lib/_python');

const SEED_DIR = __dirname;
const ROOT = path.resolve(SEED_DIR, '..', '..', '..'); // canteenAI/
const PY_DIR = path.join(ROOT, 'store-inventory');
const PY_SEED_DIR = path.join(ROOT, 'old', 'store-inventory-legacy', 'python-seed');
const MIGRATIONS_DIR = path.join(PY_DIR, 'migrations');
const BASE_DB = path.join(PY_DIR, 'data', '餐厅系统.db');

const PY_MASTER = path.join(PY_SEED_DIR, 'seed_master_data.py');
const PY_MODULES = path.join(PY_SEED_DIR, 'seed_modules.py');
const PY_FINANCE = path.join(PY_SEED_DIR, 'seed_finance_extra.py');

// 差分比较时忽略的列：自增主键与易变时间戳
const IGNORE_COLS = new Set(['id', 'ts', 'updated_at', 'created_at']);

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function openDb(dbPath) {
  return new DatabaseSync(dbPath);
}

/** 按 migrations 目录（排序）建一份全新库。 */
function buildFreshDb(dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const db = openDb(dst);
  try {
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    }
  } finally {
    db.close();
  }
  return dst;
}

/** 复制真实基线库到 dst；真实库缺失时回退到 migrations 全量重建。 */
function copyBaseDb(dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(BASE_DB)) {
    fs.copyFileSync(BASE_DB, dst);
  } else {
    buildFreshDb(dst);
  }
  return dst;
}

/** 清空指定表（用于验证「空表才灌」的插入路径）。 */
function clearTables(dbPath, tables) {
  const db = openDb(dbPath);
  try {
    db.exec('BEGIN');
    for (const t of tables) db.exec('DELETE FROM ' + t);
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

/** 取某表规范化快照：去掉忽略列 + 按稳定 JSON 串排序。 */
function tableSnapshot(dbPath, table) {
  const db = openDb(dbPath);
  try {
    const cols = db.prepare('PRAGMA table_info(' + table + ')').all()
      .map((r) => r.name)
      .filter((c) => !IGNORE_COLS.has(c));
    const all = db.prepare('SELECT * FROM ' + table).all();
    const rows = all.map((row) => {
      const o = {};
      for (const c of cols) o[c] = row[c] === undefined ? null : row[c];
      return JSON.stringify(o);
    });
    rows.sort();
    return rows;
  } finally {
    db.close();
  }
}

/** 逐表断言两份库内容一致（忽略自增 id / 时间戳）。 */
function assertTablesEqual(nodeDb, pyDb, tables) {
  for (const t of tables) {
    const n = tableSnapshot(nodeDb, t);
    const p = tableSnapshot(pyDb, t);
    try {
      assert.deepStrictEqual(n, p);
    } catch (e) {
      console.error('表不一致: ' + t);
      console.error('  Node  : ' + JSON.stringify(n, null, 2));
      console.error('  Python: ' + JSON.stringify(p, null, 2));
      throw e;
    }
  }
}

function countWhere(dbPath, table, where) {
  const db = openDb(dbPath);
  try {
    return db.prepare('SELECT COUNT(*) AS c FROM ' + table + (where ? ' WHERE ' + where : '')).get().c;
  } finally {
    db.close();
  }
}

/** 执行内联 Python 代码（可直接 importlib 加载原脚本并调用函数）。 */
function runPython(code, args, input) {
  return execPy(code, { input: input, args: args || [] });
}

/** 异步执行内联 Python 代码：不阻塞 Node 事件循环（HTTP mock 场景必需）。 */
function runPythonAsync(code, args) {
  return new Promise((resolve, reject) => {
    const pyc = pickPy() || { cmd: 'python3', pre: [] };
    const p = spawn(pyc.cmd, pyc.pre.concat(['-c', code]).concat(args || []), {
      env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' })
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code2) => {
      if (code2 === 0) resolve(out);
      else reject(new Error('python exit ' + code2 + '\n' + err));
    });
    p.stdin.end();
  });
}

/** 载入模块的 Python 前缀代码。 */
function loadPyModule(varName, pyPath) {
  return [
    'import sys, importlib.util',
    'spec = importlib.util.spec_from_file_location("' + varName + 'mod", ' + JSON.stringify(pyPath) + ')',
    varName + ' = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(' + varName + ')',
  ].join('\n');
}

module.exports = {
  SEED_DIR, PY_DIR, MIGRATIONS_DIR, BASE_DB,
  PY_MASTER, PY_MODULES, PY_FINANCE,
  IGNORE_COLS,
  tmpDir, openDb, buildFreshDb, copyBaseDb, clearTables,
  tableSnapshot, assertTablesEqual, countWhere, runPython, runPythonAsync, loadPyModule,
};
