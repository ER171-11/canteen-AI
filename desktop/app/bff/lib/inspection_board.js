'use strict';
/*
 * lib/inspection_board.js — 闭店巡检完成情况聚合（后台统筹看板 D 块 / App 进度环共用）
 *
 * 纯函数：输入快照 ext（形如 { inspection_records: [...], inspection_assignments: [...] }）
 * 与筛选条件，输出可直接下发的汇总结构。不读文件、不写库、无副作用，
 * 便于单测覆盖，也便于 modules.js 路由与 App 端复用同一套口径。
 *
 * 图片不出现在任何输出字段里 —— 巡检照片只存在手机本地（见 algorithms/inspection.js）。
 */
const nodes = require('./inspection_nodes');
const sp = require('./safety_points');

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function uniq(list) {
  const out = [];
  for (const x of list) if (out.indexOf(x) < 0) out.push(x);
  return out;
}

/** 巡检点位归一：board 取 zone；node_group 优先取内置节点分组，自定义点位回落 zone */
function pointOf(p) {
  const known = nodes.byId(p.id);
  return {
    id: p.id,
    name: p.name,
    board: p.zone || '未分区',
    node_group: (known && known.node_group) || p.zone || '未分区',
    every30: p.every30 === 1 || p.every30 === '1' || p.every30 === true
  };
}

/** 解析巡检点位：优先 ext.fs_points(inspection)，空态回退内置 50 节点（见 safety_points） */
function pointsOf(ext) {
  return sp.resolvePoints(ext, 'inspection').map(pointOf);
}

/** 记录归属日：优先 date 字段，缺失时取 ts 前 10 位 */
function dayOf(r) {
  const d = String((r && r.date) || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const ts = String((r && r.ts) || '');
  return /^\d{4}-\d{2}-\d{2}/.test(ts) ? ts.slice(0, 10) : '';
}

function strEq(a, b) {
  return String(a === undefined || a === null ? '' : a).trim() === String(b === undefined || b === null ? '' : b).trim();
}

/** 至今尚未记录的 30 分钟轮次（卫生间类节点替代纸质签到的核对依据） */
function missingRounds(recorded, nowDate) {
  const now = nowDate ? new Date(nowDate) : new Date();
  const cur = Math.floor((now.getHours() * 60 + now.getMinutes()) / 30);
  const out = [];
  for (let i = 0; i <= cur; i += 1) {
    if (recorded.indexOf(i) < 0) out.push(i);
  }
  return out;
}

/**
 * 构建巡检看板。
 * opt: { date, board, operator, node_id, limit, now }
 *   - date 缺省取今天；board/operator/node_id 为筛选条件，缺省不筛
 *   - limit 控制返回的记录条数（默认 200，上限 1000）
 */
function buildBoard(ext, opt) {
  const o = opt || {};
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(o.date || ''))
    ? String(o.date)
    : new Date().toISOString().slice(0, 10);

  const allRecords = arr(ext && ext.inspection_records);
  const assigns = arr(ext && ext.inspection_assignments);

  let recs = allRecords.filter((r) => dayOf(r) === date);
  if (o.board) recs = recs.filter((r) => strEq(r.board, o.board));
  if (o.operator) recs = recs.filter((r) => strEq(r.operator, o.operator));
  if (o.node_id) recs = recs.filter((r) => strEq(r.node_id, o.node_id));

  // 每节点只认最新一条记录
  const latest = {};
  recs.forEach((r) => {
    const id = String(r.node_id || '');
    if (!id) return;
    const cur = latest[id];
    if (!cur || String(r.ts || '') >= String(cur.ts || '')) latest[id] = r;
  });

  // 板块/节点来源改为可配置点位（空态回退内置 50 节点）
  const points = pointsOf(ext);

  const boardOf = {};
  points.forEach((n) => {
    if (!boardOf[n.board]) {
      boardOf[n.board] = {
        board: n.board,
        total: 0,
        done: 0,
        missing_count: 0,
        rate: 0,
        operator: null,
        last_ts: null,
        every30_pending: 0,
        missing: []
      };
    }
  });

  points.forEach((n) => {
    const b = boardOf[n.board];
    if (!b) return;
    b.total += 1;
    const r = latest[n.id];
    if (r && Number(r.done) === 1) {
      b.done += 1;
      const ts = String(r.ts || '');
      if (ts && (!b.last_ts || ts > b.last_ts)) b.last_ts = ts;
      return;
    }
    b.missing_count += 1;
    if (n.every30 === true) b.every30_pending += 1;
    b.missing.push({
      node_id: n.id,
      name: n.name,
      node_group: n.node_group,
      every30: n.every30 === true,
      photo_taken: r ? Number(r.photo_taken) === 1 : false,
      operator: r ? (r.operator || null) : null,
      ts: r ? (r.ts || null) : null
    });
  });

  assigns.forEach((a) => {
    const b = boardOf[String(a.board || '').trim()];
    if (!b) return;
    if (a.operator) b.operator = a.operator;
  });

  const boards = Object.keys(boardOf).map((x) => boardOf[x]);
  boards.forEach((b) => {
    b.rate = b.total ? Math.round((b.done / b.total) * 100) : 0;
  });

  const total = points.length;
  const done = boards.reduce((s, b) => s + b.done, 0);

  const roundsRecorded = [];
  recs.forEach((r) => {
    if (Number(r.every30) !== 1) return;
    const rn = r.round;
    if (rn === null || rn === undefined || rn === '') return;
    const n = Number(rn);
    if (isFinite(n) && roundsRecorded.indexOf(n) < 0) roundsRecorded.push(n);
  });
  roundsRecorded.sort((a, b) => a - b);

  const limit = Math.max(1, Math.min(1000, parseInt(o.limit, 10) || 200));
  const list = recs
    .slice()
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
    .slice(0, limit);

  return {
    date: date,
    updated_at: new Date().toISOString(),
    summary: {
      total: total,
      done: done,
      missing: total - done,
      rate: total ? Math.round((done / total) * 100) : 0
    },
    boards: boards,
    nodes: points,
    groups: uniq(points.map((p) => p.node_group)),
    records: list,
    records_total: recs.length,
    every30: {
      node_total: points.filter((p) => p.every30 === true).length,
      rounds_per_day: 48,
      rounds_recorded: roundsRecorded,
      rounds_missing: missingRounds(roundsRecorded, o.now)
    }
  };
}

module.exports = { buildBoard, dayOf, missingRounds };
