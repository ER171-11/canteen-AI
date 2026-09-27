'use strict';
/*
 * 食材按标准验收 · 标准库（只读）
 * 优先读快照 ext.accept_standards；否则回落 bff/data/accept_standards.json。
 */
const fs = require('fs');
const path = require('path');

const SEED_PATH = path.join(__dirname, '..', 'data', 'accept_standards.json');

let _seed = null;

function loadSeed() {
  if (_seed) return _seed;
  try {
    const raw = fs.readFileSync(SEED_PATH, 'utf8');
    const arr = JSON.parse(raw);
    _seed = Array.isArray(arr) ? arr : [];
  } catch (e) {
    _seed = [];
  }
  return _seed;
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function normName(s) {
  return String(s || '').trim().replace(/\s+/g, '');
}

/** 从快照 ext 或种子取标准列表 */
function listStandards(snap) {
  const ext = snap && snap.ext && typeof snap.ext === 'object' ? snap.ext : {};
  const fromExt = arr(ext.accept_standards).filter((r) => r && r.ing_name);
  if (fromExt.length) return fromExt;
  return loadSeed();
}

/** name → standard 映射（支持子串命中） */
function indexByName(standards) {
  const exact = new Map();
  for (const s of standards) {
    const k = normName(s.ing_name);
    if (k) exact.set(k, s);
  }
  return {
    get(name) {
      const k = normName(name);
      if (!k) return null;
      if (exact.has(k)) return exact.get(k);
      for (const [key, val] of exact) {
        if (k.indexOf(key) >= 0 || key.indexOf(k) >= 0) return val;
      }
      return null;
    }
  };
}

function specReqFor(name, snap) {
  const idx = indexByName(listStandards(snap));
  const hit = idx.get(name);
  return hit && hit.spec_req ? String(hit.spec_req) : undefined;
}

module.exports = { listStandards, indexByName, specReqFor, loadSeed };
