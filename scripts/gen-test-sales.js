#!/usr/bin/env node
'use strict';
/*
 * scripts/gen-test-sales.js — 临时为 BFF 快照补充 35 天销售流水（仅本地测试 M1-T5 的「样本≥4周」分支）
 *
 * 作用：把 bff/data/snapshot.json 的 data.sales 追加合成流水，覆盖今天往前 35 天，
 *       使 analysis 的 trend.length≈35 → weeks≈5，从而消除「天气样本不足(<4周)」黄条。
 * 安全：
 *   - 首次运行自动备份原文件为 snapshot.json.bak（仅一份）；
 *   - 只新增「当前缺失日期」的流水，不改动已有销售记录；
 *   - 用 --restore 还原。
 * 说明：这是对云端快照副本(snapshot.json)的临时改动；下次店内 pusher 推送真实快照会被覆盖，
 *       所以本就是「临时测试数据」，绝不触碰店内主库 餐厅系统.db。
 */
const fs = require('fs');
const path = require('path');

const SNAP = path.resolve(__dirname, '..', 'bff', 'data', 'snapshot.json');
const BAK = SNAP + '.bak';
const DAYS = 35;

function pad(n) { return String(n).padStart(2, '0'); }
function fmt(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function tsOf(date, h, m) { return fmt(date) + ' ' + pad(h) + ':' + pad(m) + ':00'; }
function rnd(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
function dayOf(r) {
  const t = String((r && (r.ts || r.time || r.date || r.created_at)) || '');
  const m = t.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function backupIfNeeded() {
  if (!fs.existsSync(SNAP)) { console.error('找不到 snapshot.json:', SNAP); process.exit(1); }
  if (!fs.existsSync(BAK)) { fs.copyFileSync(SNAP, BAK); console.log('已备份原快照 → snapshot.json.bak'); }
}

function daySet(sales) { return new Set(sales.map(dayOf).filter(Boolean)); }

function runGen() {
  backupIfNeeded();
  const snap = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
  snap.data = snap.data || {};
  const sales = Array.isArray(snap.data.sales) ? snap.data.sales.slice() : [];
  const have = daySet(sales);

  const today = new Date();
  let added = 0;
  for (let i = 0; i < DAYS; i++) {
    const d = new Date(today.getTime() - i * 86400000);
    if (have.has(fmt(d))) continue;          // 该日已有真实流水则跳过
    const cnt = rnd(22, 38);
    for (let k = 0; k < cnt; k++) {
      const hour = rnd(8, 21);
      const min = rnd(0, 59);
      const amount = rnd(28, 320) + Math.round(Math.random() * 100) / 10;
      sales.push({ ts: tsOf(d, hour, min), revenue: +amount.toFixed(2) });
    }
    added += cnt;
  }
  snap.data.sales = sales;
  fs.writeFileSync(SNAP, JSON.stringify(snap));   // 原子性要求不高：BFF 只读快照

  console.log('新增合成笔数=' + added + '；累计不重复天数=' + daySet(sales).size
    + '（weeks≈' + Math.floor(daySet(sales).size / 7) + '）');
  console.log('刷新页面即可生效（BFF 每次请求重读 snapshot.json，无需重启）。');
  console.log('还原：node scripts/gen-test-sales.js --restore');
}

function runRestore() {
  if (!fs.existsSync(BAK)) { console.error('没有备份 snapshot.json.bak，无法还原'); process.exit(1); }
  fs.copyFileSync(BAK, SNAP);
  fs.unlinkSync(BAK);
  console.log('已还原 snapshot.json 并删除备份。');
}

if (process.argv.includes('--restore')) runRestore();
else runGen();
