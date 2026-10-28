#!/usr/bin/env node
'use strict';
/*
 * scripts/seed-w3-demo.js — 给 BFF 快照(bff/data/snapshot.json) 灌 W3 演示数据
 *
 *   1) 给一个供应商证照补 url（VendorsPage「资质超链接」可点）
 *   2) 给一个原料补 qc_report_url（StockPage 原料详情「质检报告」可点）
 *
 * 用法：
 *   node scripts/seed-w3-demo.js          灌数据（先自动备份 snapshot.json -> snapshot.json.bak）
 *   node scripts/seed-w3-demo.js --restore 从 snapshot.json.bak 还原
 *   node scripts/seed-w3-demo.js --inspect 只打印现状，不写
 */
const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '..', 'bff', 'data', 'snapshot.json');
const BAK = FILE + '.bak';
const MODE = process.argv.includes('--restore') ? 'restore'
  : process.argv.includes('--inspect') ? 'inspect' : 'seed';

if (MODE === 'restore') {
  if (!fs.existsSync(BAK)) { console.error('✗ 无备份文件 snapshot.json.bak'); process.exit(1); }
  fs.copyFileSync(BAK, FILE);
  console.log('✓ 已从 snapshot.json.bak 还原 snapshot.json');
  process.exit(0);
}

if (!fs.existsSync(FILE)) { console.error('✗ 找不到 ' + FILE); process.exit(1); }
const snap = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const data = snap.data || {};
const ext = snap.ext || {};

/* ---------- 1. 供应商证照 url ---------- */
const vendors = Array.isArray(ext.sup_vendors) ? ext.sup_vendors : [];
const vendor = vendors.find((v) => v && Array.isArray(v.certs) && v.certs.length > 0);

if (MODE === 'inspect') {
  console.log('=== ext.sup_vendors 证照现状 ===');
  vendors.forEach((v) => console.log('· ' + v.name + '  certs=' + JSON.stringify(v.certs)));
  const withQc = (data.ings || []).filter((i) => i && i.qc_report_url);
  console.log('=== data.ings 质检报告现状 ===');
  console.log('总原料=' + (data.ings || []).length + '，已有 qc_report_url=' + withQc.length);
  (data.ings || []).slice(0, 5).forEach((i) => console.log('· ' + i.name + ' -> ' + (i.qc_report_url || '-')));
  process.exit(0);
}

if (!vendor) { console.error('✗ ext.sup_vendors 里没有带 certs 的供应商'); process.exit(1); }
const demoCertUrl = 'https://img.example.com/certs/' + vendor.vendor_id + '-yyzz.pdf';
vendor.certs.forEach((c) => { if (c && !c.url) c.url = demoCertUrl; });

/* ---------- 2. 原料 qc_report_url ---------- */
const ings = Array.isArray(data.ings) ? data.ings : [];
if (!ings.length) { console.error('✗ data.ings 为空'); process.exit(1); }
const ing = ings.find((i) => i && i.on !== false) || ings[0];
const demoQcUrl = 'https://img.example.com/qc/' + (ing.id || ing.name) + '-report.pdf';
ing.qc_report_url = demoQcUrl;

/* ---------- 写回（先备份） ---------- */
if (!fs.existsSync(BAK)) fs.copyFileSync(FILE, BAK);
fs.writeFileSync(FILE, JSON.stringify(snap));

console.log('✓ 备份已存 ' + BAK);
console.log('✓ 供应商「' + vendor.name + '」证照已补 url: ' + demoCertUrl);
console.log('  certs=' + JSON.stringify(vendor.certs));
console.log('✓ 原料「' + ing.name + '」已补 qc_report_url: ' + demoQcUrl);
