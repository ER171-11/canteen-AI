'use strict';
/*
 * shared/recipe-cost/index.cjs — Node CommonJS 入口（薄壳）
 * 逻辑唯一来源是 index.mjs；此处通过 require(esm)（Node ≥ 22.12 稳定支持）同步转出命名导出，
 * 保持后端既有 `require('.../index.cjs')` 解构用法不变。
 */
module.exports = require('./index.mjs');
