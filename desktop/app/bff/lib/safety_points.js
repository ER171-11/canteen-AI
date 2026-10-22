'use strict';
/*
 * lib/safety_points.js — 食安点位主数据（巡检 / 消毒 统一事实来源）
 *
 * 为什么需要它：
 *   原「巡检统筹」与「消毒记录」把区域/节点写死在后端（inspection_nodes.js）或
 *   从历史记录反推，导致区域划分不真实、不可维护。本模块引入统一「食安点位」
 *   主数据 fs_points（按 kind 区分 inspection / disinfect 两套独立清单），作为
 *   巡检看板与消毒达标率的唯一事实来源。
 *
 * 纯函数，无 IO：便于单测与各聚合层（inspection_board / foodsafety / inspection 算法）
 * 复用同一套解析口径。
 *
 * 读取优先级（关键决策）：
 *   1) ext.fs_points 中该 kind 的有效点位（enabled !== 0）优先，按 sort 升序；
 *   2) 若该 kind 一个有效点位都没有 → 回退内置默认（巡检 50 节点 / 消毒 5 区域），
 *      保证首次空态与历史环境可用。
 *   默认点位不预置写库：由本模块纯函数兜底，避免迁移脚本与审批初始化的复杂度。
 *   前端可调用 POST /api/safety/points/seed 把内置默认「导入」为可编辑点位（一次审批）。
 *
 * 字段（与 SQLite fs_points 表同构）：
 *   id             稳定标识：巡检沿用 K01..K50（兼容 inspection_records.node_id），消毒 D01..D05
 *   name           点位名
 *   zone           巡检=板块(后厨/前厅/仓库)；消毒=区域分组
 *   kind           'inspection' | 'disinfect'
 *   every30        1=需每 30 分钟记录（仅巡检卫生间类）
 *   demo_image_key 规范演示图对象键（OSS，图片本体不落库）
 *   demo_image_url 演示图公开读地址（OSS_PUBLIC_BASE 配置时）
 *   enabled        1=启用；0=逻辑删除（保留历史台账引用）
 *   sort           排序权重，升序
 *   note           备注
 *   ts             最近更新时刻 ISO
 */

const nodes = require('./inspection_nodes');

const KIND_INSPECTION = 'inspection';
const KIND_DISINFECT = 'disinfect';
const KINDS = [KIND_INSPECTION, KIND_DISINFECT];

/** 内置默认消毒区域（首次空态兜底；后续可 seed 为可编辑点位） */
const DISINFECT_DEFAULTS = [
  { id: 'D01', name: '前厅公共区域', zone: '前厅', every30: 0 },
  { id: 'D02', name: '后厨操作间', zone: '后厨', every30: 0 },
  { id: 'D03', name: '餐具洗消间', zone: '洗消', every30: 0 },
  { id: 'D04', name: '仓库存储区', zone: '仓库', every30: 0 },
  { id: 'D05', name: '卫生间', zone: '前厅', every30: 0 }
];

function isKind(kind) {
  return KINDS.indexOf(String(kind === undefined || kind === null ? '' : kind).trim()) >= 0;
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function str(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

function numSort(v) {
  const n = parseInt(v, 10);
  return isFinite(n) ? n : 0;
}

function isEnabled(row) {
  return String(row && row.enabled) !== '0';
}

function isTruthy(v) {
  return v === true || v === 1 || String(v) === '1';
}

/** 把内置节点 / 区域对象归一为点位行结构 */
function toPoint(src, kind) {
  const s = src || {};
  return {
    id: str(s.id),
    name: str(s.name || s.node_name),
    zone: str(s.zone || s.board || s.node_group),
    kind: kind,
    every30: isTruthy(s.every30) ? 1 : 0,
    demo_image_key: null,
    demo_image_url: null,
    enabled: 1,
    sort: numSort(s.sort),
    note: null,
    ts: null
  };
}

/**
 * 内置默认点位。
 *   kind='inspection' → 50 个标准巡检节点（含 zone=board、every30）
 *   kind='disinfect'  → 5 个默认消毒区域
 */
function defaultPoints(kind) {
  if (kind === KIND_DISINFECT) {
    return DISINFECT_DEFAULTS.map((d) => toPoint(d, KIND_DISINFECT));
  }
  return nodes.all().map((n) => toPoint(n, KIND_INSPECTION));
}

/** 该 kind 是否仍在使用内置默认（ext 中无有效点位） */
function usingDefaultPoints(ext, kind) {
  const rows = arr(ext && ext.fs_points);
  for (const p of rows) {
    if (p && p.kind === kind && isEnabled(p)) return false;
  }
  return true;
}

/**
 * 解析某 kind 的有效点位：
 *   优先 ext.fs_points（enabled !== 0 且 kind 匹配，按 sort 升序）；
 *   该 kind 无有效点位时回退 defaultPoints(kind)。
 */
function resolvePoints(ext, kind) {
  const rows = arr(ext && ext.fs_points)
    .filter((p) => p && p.kind === kind && isEnabled(p));
  if (!rows.length) return defaultPoints(kind);
  return rows.slice().sort((a, b) => numSort(a.sort) - numSort(b.sort));
}

/** 单点查找（含默认兜底）；不存在返回 null */
function pointById(ext, kind, id) {
  const s = str(id);
  if (!s) return null;
  const hit = arr(ext && ext.fs_points)
    .find((p) => p && p.kind === kind && isEnabled(p) && String(p.id) === s);
  if (hit) return hit;
  return defaultPoints(kind).find((p) => String(p.id) === s) || null;
}

module.exports = {
  KIND_INSPECTION,
  KIND_DISINFECT,
  KINDS,
  DISINFECT_DEFAULTS,
  isKind,
  isEnabled,
  toPoint,
  defaultPoints,
  usingDefaultPoints,
  resolvePoints,
  pointById
};
