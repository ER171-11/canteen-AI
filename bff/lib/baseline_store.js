'use strict';
/*
 * lib/baseline_store.js — 「真实数据基线」制品读取（ADR-013 D4-4 / W4-02 / FP-SET-16）。
 *
 * 背景（见 ADR-013 §2.4）：产品内此前**没有**可用的真实数据基线——
 *   `bff/data.seed/snapshot.json` 是空快照（rev 1，0 条），真实基线只躺在开发机的遗留库里。
 * 决策（D4-4 选 A）：把基线做成**随包发布的制品** `bff/baselines/baseline-<ver>.json`，
 *   由 `scripts/gen-baseline.js` 从遗留库导出一次，带 `baseline_version` + 校验和。
 *
 * 制品形态：
 *   {
 *     baseline_version: 'v1',           // 一旦发布即不可变，后续变更须新增版本号（ADR-013 §9）
 *     generated_at, source, schema_version, note,
 *     checksum: 'sha256:<hex>',         // 对 {data, ext} 的规范化序列化取 sha256
 *     counts: { ings, dishes, recv, orders, sales, quotes, logs, ext_tables },
 *     data: {...}, ext: {...}
 *   }
 *
 * 红线：
 *   · 本模块**只读**（不写任何文件、不写业务库、不入队）——重置的写由 `snapshot.reset_baseline` 执行器负责；
 *   · 校验和不匹配 → 显式抛错（红线⑦不静默降级），绝不把「可能被改坏的基线」写进业务库。
 *
 * 目录优先级：`data/baselines/`（本机现场放入，优先）→ `bff/baselines/`（随包制品）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

/** 版本号白名单（防路径穿越）：v1 / 2026-10-30 之类 */
const VERSION_RX = /^[0-9A-Za-z._-]{1,40}$/;

function dirs() {
  return [
    path.join(store.DATA_DIR, 'baselines'),
    path.join(__dirname, '..', 'baselines'),
  ];
}

/** 基线内容校验和（与 scripts/gen-baseline.js 必须逐字一致） */
function checksumOf(data, ext) {
  const text = JSON.stringify({ data: data === undefined ? null : data, ext: ext === undefined ? null : ext });
  return 'sha256:' + crypto.createHash('sha256').update(text).digest('hex');
}

function readFileSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function countsOf(obj) {
  const data = (obj && obj.data) || {};
  const ext = (obj && obj.ext) || {};
  const n = (v) => (Array.isArray(v) ? v.length : 0);
  return {
    ings: n(data.ings),
    dishes: n(data.dishes),
    recv: n(data.recv),
    orders: n(data.orders),
    sales: n(data.sales),
    quotes: n(data.quotes),
    logs: n(data.logs),
    ext_tables: Object.keys(ext).filter((k) => Array.isArray(ext[k]) && ext[k].length).length,
  };
}

/**
 * 列出可用基线（按版本倒序；坏文件跳过，不让列表把页面打挂）。
 * @returns {Array<{version:string, file:string, generated_at, source, note, size, counts, checksum_ok}>}
 */
function list() {
  const seen = new Set();
  const out = [];
  for (const dir of dirs()) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { continue; }
    for (const name of names) {
      if (!/^baseline-.+\.json$/.test(name)) continue;
      const version = name.slice('baseline-'.length, -'.json'.length);
      if (!VERSION_RX.test(version) || seen.has(version)) continue;
      const p = path.join(dir, name);
      const obj = readFileSafe(p);
      if (!obj || !obj.data || typeof obj.data !== 'object') continue;
      seen.add(version);
      const st = (() => { try { return fs.statSync(p); } catch (e) { return null; } })();
      out.push({
        version: String(obj.baseline_version || version),
        file: p,
        generated_at: obj.generated_at || null,
        source: obj.source || null,
        note: obj.note || '',
        size: st ? st.size : 0,
        counts: obj.counts || countsOf(obj),
        checksum_ok: !obj.checksum || obj.checksum === checksumOf(obj.data, obj.ext),
      });
    }
  }
  out.sort((a, b) => String(b.version).localeCompare(String(a.version), 'en', { numeric: true }));
  return out;
}

/** 版本 → 文件路径（不存在返回 null） */
function pathOf(version) {
  for (const dir of dirs()) {
    const p = path.join(dir, 'baseline-' + version + '.json');
    try { if (fs.statSync(p).isFile()) return p; } catch (e) { /* next */ }
  }
  return null;
}

/**
 * 读某版本基线（默认取最新）。
 * @param {string} [version]
 * @param {object} [opts] {verify=true}
 * @returns {{version:string, data:object, ext:object, checksum_ok:boolean, item:object}}
 * @throws 基线不存在 / 缺 data / 校验和不匹配
 */
function read(version, opts) {
  const o = opts || {};
  let ver = version == null ? '' : String(version).trim();
  if (ver && !VERSION_RX.test(ver)) throw new Error('基线版本号非法：' + ver);
  if (!ver) {
    const first = list()[0];
    if (!first) throw new Error('没有任何基线制品（bff/baselines/baseline-<ver>.json），请先运行 scripts/gen-baseline.js');
    ver = first.version;
  }
  const p = pathOf(ver);
  if (!p) throw new Error('基线不存在：' + ver);
  const obj = readFileSafe(p);
  if (!obj || !obj.data || typeof obj.data !== 'object') throw new Error('基线文件损坏或缺 data 字段：' + ver);
  const md = checksumOf(obj.data, obj.ext);
  const checksumOk = !obj.checksum || obj.checksum === md;
  if (o.verify !== false && !checksumOk) {
    throw new Error('基线校验和不匹配（文件可能被改动）：' + ver + '，期望 ' + obj.checksum + '，实际 ' + md);
  }
  return {
    version: String(obj.baseline_version || ver),
    data: obj.data,
    ext: obj.ext === undefined || obj.ext === null ? {} : obj.ext,
    checksum_ok: checksumOk,
    item: {
      version: String(obj.baseline_version || ver),
      file: p,
      generated_at: obj.generated_at || null,
      source: obj.source || null,
      note: obj.note || '',
      counts: obj.counts || countsOf(obj),
    },
  };
}

module.exports = { checksumOf, countsOf, list, read, pathOf, dirs };
