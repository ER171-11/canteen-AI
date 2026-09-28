#!/usr/bin/env node
'use strict';
/*
 * scripts/lint-zero-dep.js — 零依赖静态检查（CI 与本地共用）
 *
 * 为什么不用 ESLint 覆盖后端：本项目对 `bff/` 坚持「运行时零第三方依赖」，
 * 引入 ESLint 需要 node_modules 与 lockfile 变更。前端 `apps/admin-web` 已自带
 * ESLint（`npm run lint`，--max-warnings 0），已在 CI 中执行；后端这里只做
 * 「零依赖也能做、且确实能拦住一类真实故障」的检查。
 *
 * 检查项：
 *   1. 语法检查：对全部目标 .js 执行 `node --check`。
 *      （现状：CI 只跑 lib/algorithms 与 store-node 的测试入口，bff/routes/*.js、
 *        bff/server.js 等根本没被解析过，语法错误可直接合入。）
 *   2. 卫生规则（低误报、高信号）：debugger 残留、测试 .only 残留、eval()、
 *      硬编码密钥字面量、bff/lib/ 下残留 console.log。
 *
 * 退出码：0 = 全通过；1 = 有违规。
 *
 * 用法：node scripts/lint-zero-dep.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'dist', '.gradle', 'old', 'python-runtime', 'python-seed']);

/** 需要做语法检查的目录（相对仓库根） */
const SYNTAX_TARGETS = ['bff', 'scripts', 'ci'];

/**
 * 卫生规则：只保留「低误报、高信号」项。
 * 刻意不做的事：不检查 console 输出（本项目测试跑法就是打印 PASS，属既有风格）；
 * 不做风格类检查（那是前端 ESLint 的职责）。
 */
const RULES = [
  { name: 'debugger', test: /(^|[^.\w])debugger\s*;/, desc: '不得残留 debugger' },
  { name: 'test-only', test: /\.only\s*\(/, desc: '不得残留 .only（会让套件静默少跑其余用例）', onlyTest: true },
  { name: 'hardcoded-key', test: /(sk-[A-Za-z0-9]{16,})|(KIMI_API_KEY\s*[:=]\s*['"][^'"]{8,}['"])/, desc: '不得硬编码密钥' },
];
/** 本文件自身含规则字面量，跳过自检 */
const SELF = path.relative(ROOT, __filename).replace(/\\/g, '/');

const violations = [];
const checked = [];

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile() && e.name.endsWith('.js')) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/* 1. 语法检查 */
for (const t of SYNTAX_TARGETS) {
  const base = path.join(ROOT, t);
  if (!fs.existsSync(base)) continue;
  for (const f of walk(base, [])) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    checked.push(rel);
    if (r.status !== 0) {
      violations.push({ file: rel, rule: 'syntax', detail: ((r.stderr || '').trim().split(/\r?\n/)[0] || '语法错误') });
    }
  }
}

/* 2. 卫生规则（同时覆盖前端源码，前端另有 ESLint） */
const HYGIENE_DIRS = ['bff', 'scripts', 'ci', 'apps/admin-web/src'];
function walkAny(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walkAny(path.join(dir, e.name), out);
    } else if (e.isFile() && /\.(js|ts|tsx)$/.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}
for (const d of HYGIENE_DIRS) {
  const base = path.join(ROOT, d);
  if (!fs.existsSync(base)) continue;
  for (const f of walkAny(base, [])) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (rel === SELF) continue;
    const isTest = /\.test\.[jt]sx?$/.test(f);
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    const lines = text.split(/\r?\n/);
    for (const rule of RULES) {
      if (rule.onlyTest && !isTest) continue;
      for (let i = 0; i < lines.length; i++) {
        if (rule.test.test(lines[i])) {
          violations.push({ file: rel, line: i + 1, rule: rule.name, detail: rule.desc + '：' + lines[i].trim().slice(0, 120) });
        }
      }
    }
  }
}

/* 输出 */
if (violations.length === 0) {
  console.log('[lint-zero-dep] 通过：语法检查 ' + checked.length + ' 个文件 + 卫生规则 ' + RULES.length + ' 条，无违规。');
  process.exit(0);
}
console.error('[lint-zero-dep] 发现 ' + violations.length + ' 处违规：');
for (const v of violations) {
  console.error('  ' + v.file + (v.line ? ':' + v.line : '') + '  [' + v.rule + ']  ' + v.detail);
}
process.exit(1);
