'use strict';
/*
 * lib/_python.js — 平价测试公共助手：调用 Python 原实现（old/store-inventory-legacy/python-*）
 *
 * 解决两个跨平台/跨环境的坑：
 *   1) Windows 的 python3.exe 常是 Microsoft Store 的「应用执行别名」存根：
 *      单独跑 `--version` 正常，但一旦带 stdin 传入代码就静默失败（退出非 0，stdout/stderr 全空）。
 *      → 依次尝试 PARITY_PYTHON / python3 / python / py -3，并用「带 stdin 的真实调用」做探针验证，
 *        取第一个真正可用的解释器，而不是第一个存在的名字。
 *   2) 中文 Windows 下 Python 的 stdin/stdout 默认 GBK，中文字符串（如「已入库」「手工调整」）
 *      在两端之间变乱码 → 平价测试出现**假失败**（曾导致 rebuild_stock 计数 5 vs 6）。
 *      → 强制 PYTHONIOENCODING=utf-8，与 Node 侧 utf8 对齐。
 *
 * 用法：
 *   const { runPython } = require('../lib/_python');
 *   const out = runPython(pyCode, jsonStringInput);          // 简写：第二参为字符串=stdin
 *   const out = runPython(pyCode, { input, args, cwd });     // 完整：args 追加命令行参数
 */
const { execFileSync } = require('child_process');

function candidates() {
  const list = [];
  if (process.env.PARITY_PYTHON) list.push({ cmd: process.env.PARITY_PYTHON, pre: [] });
  list.push({ cmd: 'python3', pre: [] });
  list.push({ cmd: 'python', pre: [] });
  list.push({ cmd: 'py', pre: ['-3'] });
  return list;
}

// 探针必须「带 stdin」，否则无法识别 Store 别名存根（无 stdin 时它表现正常）
const PROBE = 'import sys;sys.stdin.read();print(sys.version_info[0])';

let cached;
function pick() {
  if (cached !== undefined) return cached;
  for (const c of candidates()) {
    try {
      const out = execFileSync(c.cmd, c.pre.concat(['-c', PROBE]), {
        input: '',
        encoding: 'utf8',
        env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' })
      });
      if (String(out).trim() === '3') { cached = c; return c; }
    } catch (e) { /* 该候选不可用，继续 */ }
  }
  cached = null;
  return null;
}

function runPython(pyCode, opts) {
  const o = (opts === undefined || opts === null) ? {}
    : (typeof opts === 'string' ? { input: opts } : opts);
  const c = pick();
  if (!c) {
    throw new Error('[parity] 未找到可用的 Python 3 解释器；请安装 Python 3 或设置环境变量 PARITY_PYTHON 指向 python.exe');
  }
  return execFileSync(c.cmd, c.pre.concat(['-c', pyCode]).concat(o.args || []), {
    input: o.input === undefined ? undefined : o.input,
    encoding: 'utf8',
    cwd: o.cwd,
    env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }),
    maxBuffer: 64 * 1024 * 1024
  });
}

/** 直接跑一个 .py 脚本文件（非 -c 内联代码）。 */
function runPythonArgv(argv, opts) {
  const o = opts || {};
  const c = pick();
  if (!c) {
    throw new Error('[parity] 未找到可用的 Python 3 解释器；请安装 Python 3 或设置环境变量 PARITY_PYTHON 指向 python.exe');
  }
  return execFileSync(c.cmd, c.pre.concat(argv || []), {
    input: o.input,
    encoding: 'utf8',
    cwd: o.cwd,
    env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }),
    maxBuffer: 64 * 1024 * 1024
  });
}

module.exports = { runPython, runPythonArgv, pick };
