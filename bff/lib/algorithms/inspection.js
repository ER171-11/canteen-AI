'use strict';
/*
 * lib/algorithms/inspection.js — 闭店巡检拍照验证（C 块）与板块分工
 *
 * 红线（用户已确认，勿动）：
 *   巡检照片**只存在手机本地**，服务器只存状态与元数据。
 *   本模块**不接收、不保存任何图片字段**。若上层误传 base64 或图片地址，
 *   一律丢弃，并把 photo_local_only 置 1，作为「曾收到图片载荷但已拒绝入库」的留痕。
 *   因此 inspection_records 里没有任何图片列，连设备本地路径也不存 ——
 *   手机端按「时间 / 点位 / 责任人」检索本地库即可，服务器侧只需回答「有没有拍」。
 *
 * 算法约定（全项目统一）：handler(ctx, data, payload) → msg 字符串；抛错 = 动作被驳回。
 */
const nodes = require('../inspection_nodes');
const { persist } = require('./ops');

/* ---------- 归一工具 ---------- */

function nowIso() {
  return new Date().toISOString();
}

function truthy(v) {
  if (v === true || v === 1) return true;
  const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}

/** 取第一个非空文本（主字段为空时回落别名） */
function firstText(primary, alias) {
  for (const v of [primary, alias]) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return isFinite(n) ? n : null;
}

/** 只接受 YYYY-MM-DD */
function normDate(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function todayStr() {
  return nowIso().slice(0, 10);
}

/** 每 30 分钟轮次序号（0-47）：卫生间类节点替代纸质签到用 */
function roundOf30(ts) {
  const m = String(ts === undefined || ts === null ? '' : ts).match(/T(\d{2}):(\d{2})/);
  if (!m) return null;
  return Math.floor((parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) / 30);
}

/** 图片载荷探测：命中任一即视为「上层误传图片」，不得入库 */
const IMAGE_KEYS = [
  'photobase64', 'imagebase64', 'image', 'img', 'base64', 'imagebytes',
  'photourl', 'imgurl', 'imageurl', 'imageuri', 'photouri', 'fileurl',
  'localuri', 'localpath', 'filepath', 'photopath', 'thumb', 'thumbnail'
];

/** 键名归一：小写并抹掉下划线/连字符，避免 photo_base64 / photoUrl 绕过检测 */
function normKeyName(k) {
  return String(k).toLowerCase().replace(/[_-]/g, '');
}

function hasImagePayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const keys = Object.keys(payload);
  for (const k of keys) {
    if (IMAGE_KEYS.indexOf(normKeyName(k)) < 0) continue;
    const v = payload[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && !v.trim()) continue;
    return true;
  }
  return false;
}

/* ---------- inspection.record ---------- */

/**
 * inspection.record：登记一个巡检节点的完成情况。
 *
 * 关键规则：
 *   1) 节点必须存在于内置主数据，否则驳回（防止 App 侧拼错 id 污染台账）。
 *   2) 责任人必填（「负责到人」是需求硬要求）。
 *   3) **未拍照自动标记未完成** —— photo_taken 为假时 done 恒为 0，
 *      即使上层传 done=true 也不认（照片是唯一完成凭据）。
 *   4) 卫生间类节点自动补 30 分钟轮次序号，便于按轮次核对是否漏检。
 */
function recordInspection(ctx, data, payload) {
  const p = payload || {};
  const node = nodes.byId(p.node_id);
  if (!node) throw new Error('未知巡检节点: ' + String(p.node_id === undefined ? '' : p.node_id));

  const operator = firstText(p.operator, p.op);
  if (!operator) throw new Error('巡检记录缺少责任人 operator');

  const ts = p.ts === undefined || p.ts === null || p.ts === '' ? nowIso() : String(p.ts);
  const every30 = node.every30 === true;
  let round = numOrNull(p.round);
  if (every30 && round === null) round = roundOf30(ts);

  const photoTaken = truthy(p.photo_taken);
  const done = photoTaken && p.done !== false ? 1 : 0;

  const row = {
    date: normDate(p.date) || todayStr(),
    node_id: node.id,
    node_name: node.name,
    board: node.board,
    node_group: node.node_group,
    every30: every30 ? 1 : 0,
    round: round,
    photo_taken: photoTaken ? 1 : 0,
    done: done,
    photo_local_only: hasImagePayload(p) ? 1 : 0,
    operator: operator,
    store_id: firstText(p.store_id, p.storeId),
    station: firstText(p.station, p.point),
    note: firstText(p.note),
    ts: ts,
    source: firstText(p.source) || 'app'
  };

  const rid = persist(ctx, data, 'inspection_records', row);
  return 'inspection_records rowid=' + (rid === null ? '-' : rid);
}

/* ---------- inspection.assign ---------- */

/** inspection.assign：把板块负责到人（后厨 / 前厅 / 仓库） */
function assignInspection(ctx, data, payload) {
  const p = payload || {};
  const board = firstText(p.board);
  if (!board || nodes.BOARDS.indexOf(board) < 0) {
    throw new Error('未知巡检板块: ' + String(p.board === undefined ? '' : p.board));
  }
  const operator = firstText(p.operator, p.op);
  if (!operator) throw new Error('巡检分工缺少责任人 operator');

  const row = {
    board: board,
    operator: operator,
    store_id: firstText(p.store_id, p.storeId),
    ts: p.ts === undefined || p.ts === null || p.ts === '' ? nowIso() : String(p.ts),
    source: firstText(p.source) || 'manual'
  };

  const rid = persist(ctx, data, 'inspection_assignments', row);
  return 'inspection_assignments rowid=' + (rid === null ? '-' : rid);
}

module.exports = {
  recordInspection,
  assignInspection,
  hasImagePayload,
  roundOf30,
  IMAGE_KEYS
};
