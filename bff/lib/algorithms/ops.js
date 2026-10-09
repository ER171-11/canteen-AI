'use strict';
/*
 * lib/algorithms/ops.js — 餐饮运营/人员/食安/会员/财务/设备算法
 * 忠实迁移自 store-inventory/queue_consumer.py：
 *   insert_qc_record           (:366)   qc.record / qc.pass / plate.pass
 *   apply_queue_serve          (:1617) + insert_queue_serve (:1664)   queue.serve
 *   insert_loss_report         (:1791)   loss.report（旁路）
 *   insert_sample              (:1823)   sample.log
 *   insert_workorder           (:1847) + _norm_wo_status (:1880)
 *     + advance_workorder (:1895) + clock_workorder_step (:1984)
 *   insert_fs_cert             (:2295)   fs.cert.upsert
 *   apply_day_close            (:2325)   day.close
 *   apply_finance_recon        (:2380)   finance.recon
 *   upsert_booking             (:2440)   booking.upsert
 *   update_queue_call          (:2475)   queue.call
 *   insert_queue_join          (:2494)   queue.join
 *   insert_staff_clock         (:2529)   staff.clock
 *   upsert_staff_shift         (:2555)   staff.shift_upsert
 *   insert_uniform_log         (:2574)   uniform.log
 *   insert_disinfect           (:2591)   fs.disinfect
 *   insert_fs_trace            (:2620)   fs.trace_scan
 *   insert_eq_maintain         (:2645)   equipment.maintain
 *   insert_vip_campaign        (:2664)   vip.campaign
 *   redeem_vip_coupon          (:2699)   vip.coupon_redeem
 *   insert_week_export         (:2721)   analysis.export_week
 *   insert_takeout_ack         (:3100)   takeout.ack
 *   insert_review_followup     (:3127)   review.followup
 *   insert_vip_checkin         (:3183)   vip.checkin
 *   insert_fin_split           (:3284)   finance.freeze / finance.approve
 *
 * 约定：纯函数优先，直接原地修改 data（与 Python 版一致）；写库统一走 ctx.store：
 *   ctx.store.insert(table, row)   → rowid 或 {rowid}
 *   ctx.store.upsert(table, row, keys)
 *   ctx.store.update(table, sets, where)
 *   ctx.store.query(sql, params)   → 行数组（对象数组）
 * ctx.store 缺失时优雅降级（不写库、把行落到 data.ext.<table>），绝不崩溃、不静默丢动作。
 */

const crypto = require('crypto');
const { today, nowIso, num, arr } = require('./util');
const { findPosTable, deductBomForWorkorder } = require('./pos');
const { rebuildStock } = require('./stock');

/* ---------- 公共辅助 ---------- */

/** Python json.dumps 等价（默认分隔符 ", " / ": "，ensure_ascii=False） */
function pyJson(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(pyJson).join(', ') + ']';
  if (typeof v === 'object') {
    const parts = [];
    for (const k of Object.keys(v)) parts.push(JSON.stringify(k) + ': ' + pyJson(v[k]));
    return '{' + parts.join(', ') + '}';
  }
  return JSON.stringify(String(v));
}

/** Python 浮点转字符串（整数 float 保留 .0）：str(5.0)='5.0' */
function pf(x) {
  if (typeof x !== 'number' || !isFinite(x)) return String(x);
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}

/** uuid.uuid4().hex[:n] */
function hex(n) {
  return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}

/** dict.get 缺键 → None：undefined → null（避免 JSON 丢键） */
function pt(v) {
  return v === undefined ? null : v;
}

/** Python 真值判断：None/False/0/''/[]/{} 为假 */
function truthy(v) {
  if (v === null || v === undefined || v === false) return false;
  if (v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

/** Python `x or default`：x 为假值时取 default */
function orDefault(x, d) {
  return truthy(x) ? x : d;
}

/** Python str(strip)：x or '' 后 trim */
function strTrim(v) {
  return String(v === null || v === undefined ? '' : v).trim();
}

/** Python float(x)：失败抛错 */
function toFloat(v) {
  if (typeof v === 'number') {
    if (isFinite(v)) return v;
    throw new Error('invalid float');
  }
  const s = String(v).trim();
  if (s === '') throw new Error('invalid float');
  const n = Number(s);
  if (Number.isNaN(n)) throw new Error('invalid float');
  return n;
}

/** Python float(x or 0)：x 为假取 0，失败抛错（对齐 Python float() 语义） */
function toFloatOr0(v) {
  if (!truthy(v)) return 0;
  return toFloat(v);
}

/** Python int(x)：向零截断 */
function pint(v) {
  return Math.trunc(toFloat(v));
}

/** 写库入口：ctx.store.insert(table,row) → rowid；无 ctx.store 时把行落到 data.ext 并返回 null */
function storeInsert(ctx, table, row) {
  if (ctx && ctx.store && typeof ctx.store.insert === 'function') {
    const r = ctx.store.insert(table, row);
    if (r && typeof r === 'object' && r.rowid !== undefined) return r.rowid;
    return r === undefined ? null : r;
  }
  return null;
}

function storeUpsert(ctx, table, row, keys) {
  if (ctx && ctx.store && typeof ctx.store.upsert === 'function') {
    const r = ctx.store.upsert(table, row, keys);
    if (r && typeof r === 'object' && r.rowid !== undefined) return r.rowid;
    return r === undefined ? null : r;
  }
  return null;
}

function storeUpdate(ctx, table, sets, where) {
  if (ctx && ctx.store && typeof ctx.store.update === 'function') {
    return ctx.store.update(table, sets, where);
  }
  return 0;
}

/** 降级：把未落库的行备份到 data.ext.<table>（对齐 data.setdefault 语义） */
function fallback(ctx, data, table, row) {
  if (data && typeof data === 'object') {
    if (!data.ext || typeof data.ext !== 'object' || Array.isArray(data.ext)) data.ext = {};
    if (!Array.isArray(data.ext[table])) data.ext[table] = [];
    data.ext[table].push(row);
  }
  return null;
}

/** 统一写库：有 store 用 store，无则回落 data.ext（返回 rowid 或 null） */
function persist(ctx, data, table, row) {
  const rid = storeInsert(ctx, table, row);
  if (rid === null) fallback(ctx, data, table, row);
  return rid;
}

/** rowid 展示：有值 " id=N"，无值 "" */
function ridSuffix(rid) {
  return rid !== null && rid !== undefined ? ' id=' + rid : '';
}

/* ---------- qc.record / qc.pass / plate.pass ---------- */

/**
 * 缺陷项归一：数组 → JSON 字符串。
 * 空值（undefined/null/''）与空数组视为「未提供」，返回 null，避免产生空缺陷行。
 * 也接受 "裂纹, 开口" 这类分隔字符串。
 */
function normDefectItems(v) {
  if (v === undefined || v === null || v === '') return null;
  const list = Array.isArray(v) ? v : String(v).split(/[,，、;；]/);
  const out = list.map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
  return out.length ? JSON.stringify(out) : null;
}

/** 取第一个非空文本（主字段为空时回落别名），全空返回 null */
function firstText(primary, alias) {
  for (const v of [primary, alias]) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

/** 取第一个可解析为有限数值的值（conf 为 0 时也应写入） */
function firstNum(primary, alias) {
  for (const v of [primary, alias]) {
    if (v === undefined || v === null || v === '') continue;
    const n = num(v, null);
    if (n !== null) return n;
  }
  return null;
}

/** 缺陷项：defect_items 优先，为空时回落 defects 别名 */
function firstDefects(primary, alias) {
  for (const v of [primary, alias]) {
    const s = normDefectItems(v);
    if (s !== null) return s;
  }
  return null;
}

/**
 * 品控拍照识别扩展字段（A 块）：缺陷项 / 工序环节 / 责任人 / 照片引用 / 判定依据。
 *
 * 只在 payload 实际提供该字段时写入对应列 —— 历史只传 6 字段的调用方
 * （含 ops.test.js 里以 Python queue_consumer.py 为基准的平价对拍）落库行
 * 保持逐列一致，不会凭空多出 NULL 列导致对拍失败。
 */
function applyQcExtras(row, payload) {
  const items = firstDefects(payload.defect_items, payload.defects);
  if (items !== null) row.defect_items = items;

  const stage = firstText(payload.stage, payload.step);
  if (stage !== null) row.stage = stage;

  const operator = firstText(payload.operator, null);
  if (operator !== null) row.operator = operator;

  const photoUrl = firstText(payload.photo_url, payload.photoUrl);
  if (photoUrl !== null) row.photo_url = photoUrl;

  const photoKey = firstText(payload.photo_key, payload.photoKey);
  if (photoKey !== null) row.photo_key = photoKey;

  const conf = firstNum(payload.conf, payload.confidence);
  if (conf !== null) row.conf = conf;

  const manual = payload.manual_review;
  if (manual !== undefined && manual !== null && manual !== '') row.manual_review = truthy(manual) ? 1 : 0;

  const station = firstText(payload.station, payload.point);
  if (station !== null) row.station = station;

  const storeId = firstText(payload.store_id, payload.storeId);
  if (storeId !== null) row.store_id = storeId;

  return row;
}

/**
 * qc.record：插入本地 qc_records 表，返回 rowid。
 * pass ∈ (1, True, "1", "合格") → 1，否则 0。
 * 扩展字段见 applyQcExtras（迁移 003 加列）；未提供的列不写入。
 */
function insertQcRecord(ctx, data, payload) {
  const row = {
    workorder_id: pt(payload.workorder_id),
    sku_id: pt(payload.sku_id),
    sample_weight: pt(payload.sample_weight),
    pass: [1, true, '1', '合格'].indexOf(payload.pass) >= 0 ? 1 : 0,
    ts: payload.ts || nowIso(),
    source: payload.source || 'auto'
  };
  applyQcExtras(row, payload);
  const rid = persist(ctx, data, 'qc_records', row);
  return 'qc_records rowid=' + (rid === null ? '-' : rid);
}

/* ---------- qc.force_pass ---------- */

/**
 * qc.force_pass：不合格工单强制放行留痕（A 块）。
 * 必须填写原因并指明工单，记录操作人与时刻；缺任一项直接驳回（抛错 = 动作被拒）。
 */
function insertQcForcePass(ctx, data, payload) {
  const wid = payload.workorder_id;
  if (wid === undefined || wid === null || wid === '') throw new Error('强制放行缺少 workorder_id');
  const reason = String(payload.reason === null || payload.reason === undefined ? '' : payload.reason).trim();
  if (!reason) throw new Error('强制放行必须填写原因');
  const row = {
    workorder_id: pt(wid),
    reason: reason,
    operator: pt(payload.operator),
    ts: payload.ts || nowIso(),
    source: payload.source || 'manual'
  };
  const rid = persist(ctx, data, 'qc_force_pass', row);
  return 'qc_force_pass rowid=' + (rid === null ? '-' : rid);
}

/* ---------- queue.serve ---------- */

/**
 * queue.serve：候餐发茶/小食 → logs + queue_serves 表（modules/booking 回读）。
 */
function applyQueueServe(ctx, data, payload) {
  const action = payload.action || '候餐服务';
  const item = payload.item || payload['品名'];
  const qty = payload.qty || 1;
  const day = payload.date || today();
  const ts = payload.ts || nowIso();
  const note = pt(payload.note);
  const qno = payload.queue_no || payload.queueNo;
  const waitEta = pt(payload.wait_eta_min);
  const qcount = pt(payload.queue_count);

  if (data.logs === undefined || data.logs === null) data.logs = [];
  if (Array.isArray(data.logs)) {
    data.logs.push({
      id: 'QS' + hex(8),
      kind: 'queue_serve',
      action: action,
      qty: qty,
      item: pt(item),
      note: note,
      queue_no: pt(qno),
      wait_eta_min: waitEta,
      queue_count: qcount,
      date: day,
      ts: ts,
      source: 'queue'
    });
  }

  const rid = persist(ctx, data, 'queue_serves', {
    date: day,
    action: action,
    item: pt(item),
    qty: qty,
    note: note,
    queue_no: pt(qno),
    wait_eta_min: waitEta,
    queue_count: qcount,
    ts: ts,
    source: 'queue'
  });
  return 'queue.serve ' + action + ' ×' + qty + (rid !== null ? ' id=' + rid : '');
}

/**
 * insert_queue_serve：queue.serve → queue_serves（缺表按 005 兜底；store 层负责建表）。
 */
function insertQueueServe(ctx, data, payload) {
  const rid = persist(ctx, data, 'queue_serves', {
    date: payload.date || today(),
    action: payload.action || '候餐服务',
    item: pt(payload.item),
    qty: payload.qty || 1,
    note: pt(payload.note),
    queue_no: pt(payload.queue_no),
    wait_eta_min: pt(payload.wait_eta_min),
    queue_count: pt(payload.queue_count),
    ts: payload.ts || nowIso(),
    source: 'queue'
  });
  return rid;
}

/* ---------- loss.report 旁路 ---------- */

/**
 * insert_loss_report：loss_reports 落库（source 列缺失时由 store 层兜底回落）。
 * 返回 rowid。
 */
function insertLossReport(ctx, data, payload) {
  const row = {
    date: payload.date || today(),
    ing_name: payload.ing_name || payload.name || '',
    qty: pt(payload.qty),
    reason: payload.reason || '',
    reporter: payload.reporter || 'QUEUE',
    status: payload.status || '待审核',
    source: 'queue'
  };
  return persist(ctx, data, 'loss_reports', row);
}

/* ---------- sample.log ---------- */

/**
 * sample.log：取样留样 → fs_samples（source 列缺失时由 store 层回落）。
 */
function insertSample(ctx, data, payload) {
  const rid = persist(ctx, data, 'fs_samples', {
    date: payload.date || today(),
    meal: payload.meal || '',
    dish: payload.dish || payload.name || '',
    weight_g: payload.weight_g || payload.weight,
    keeper: payload.keeper || 'QUEUE',
    kept_at: payload.kept_at || nowIso(),
    source: 'queue'
  });
  return 'fs_samples 插入 rowid=' + (rid === null ? '-' : rid);
}

/**
 * fs.sample_clear：留样销毁登记 → fs_samples.cleared_at（M4-T4 留样状态机收尾）。
 */
function clearSample(ctx, data, payload) {
  const sid = payload.id;
  if (sid === null || sid === undefined || sid === '') return 'fs_samples 销毁登记缺 id，跳过';
  const clearedAt = payload.cleared_at || nowIso();
  const r = storeUpdate(ctx, 'fs_samples', { cleared_at: clearedAt }, { id: sid });
  if (r === 0 && !(ctx && ctx.store)) {
    fallback(ctx, data, 'fs_samples', {
      id: sid,
      dish: payload.dish || '',
      cleared_at: clearedAt,
      note: payload.note || 'queue clear'
    });
  }
  return 'fs_samples#' + sid + ' 销毁登记 ' + clearedAt;
}

/* ---------- 工单 ---------- */

const WO_FLOW = ['待开始', '制作中', '待传', '已完成'];

/** _norm_wo_status：工单状态归一 */
function normWoStatus(st) {
  const s = strTrim(st);
  if (['pending', 'todo', '待备'].indexOf(s) >= 0) return '待开始';
  if (['doing', 'in_progress', '进行中', '制作'].indexOf(s) >= 0) return '制作中';
  if (['ready', 'pass_ready', '待出', '齐'].indexOf(s) >= 0) return '待传';
  if (['done', '完成', 'finished', 'passed', '已传'].indexOf(s) >= 0) return '已完成';
  if (WO_FLOW.indexOf(s) >= 0) return s;
  return s || '待开始';
}

/**
 * workorder.create → sop_workorders（可挂 table_id/table_no 供前厅传菜对桌）。
 * table_id 有值而 table_no 缺失时，table_no 取 table_id。
 */
function insertWorkorder(ctx, data, payload) {
  const sku = payload.sku_id || payload.sku || 'SKU001';
  const qty = payload.qty || 20;
  const day = payload.date || today();
  const start = payload.planned_start || (day + 'T10:00');
  const status = payload.status || '待开始';
  let tid = strTrim(payload.table_id);
  if (!tid) tid = null;
  let tno = strTrim(payload.table_no || payload.no);
  if (!tno) tno = null;
  if (tid && !tno) tno = tid;
  const rid = persist(ctx, data, 'sop_workorders', {
    date: day,
    sku_id: sku,
    qty: qty,
    planned_start: start,
    status: status,
    qc_records: '[]',
    table_id: tid,
    table_no: tno
  });
  return 'sop_workorders 插入 rowid=' + (rid === null ? '-' : rid);
}

/** 查工单行：优先 ctx.store.get('sop_workorders', id)，其次 ctx.store.query(sql,[id]) */
function getWorkorder(ctx, wid) {
  if (ctx && ctx.store) {
    if (typeof ctx.store.get === 'function') {
      const r = ctx.store.get('sop_workorders', wid);
      if (r) return r;
    }
    if (typeof ctx.store.query === 'function') {
      const rows = ctx.store.query(
        'SELECT id, status, sku_id, qty, COALESCE(bom_deducted,0) AS bom_deducted, actual_yield, steps_state FROM sop_workorders WHERE id=?',
        [wid]
      );
      if (Array.isArray(rows) && rows.length) return rows[0];
    }
  }
  return null;
}

/**
 * workorder.advance：三态推进；进入「制作中」时按菜谱 BOM 备料扣一次，并打 bom_deducted=1。
 * 结账遇同桌同 sku 已备料则跳过售卖扣（互斥）。完成时可带 actual_yield 写入出成。
 */
function advanceWorkorder(ctx, data, payload) {
  const wid = payload.id || payload.workorder_id;
  if (wid === null || wid === undefined || strTrim(wid) === '') {
    throw new Error('缺少 workorder id');
  }
  const row = getWorkorder(ctx, wid);
  if (!row) throw new Error('工单不存在: ' + wid);

  const curSt = normWoStatus(row.status);
  const sku = row.sku_id;
  const already = pint(row.bom_deducted || 0);
  let woQty = 0;
  try {
    woQty = toFloatOr0(row.qty);
  } catch (e) {
    woQty = 0.0;
  }

  const want = payload.status || payload.to;
  let newSt;
  if (truthy(want)) {
    newSt = normWoStatus(want);
  } else {
    let idx = WO_FLOW.indexOf(curSt);
    if (idx < 0) idx = 0;
    if (idx >= WO_FLOW.length - 1) {
      return 'workorder#' + wid + ' 已是终态 ' + curSt;
    }
    newSt = WO_FLOW[idx + 1];
  }

  storeUpdate(ctx, 'sop_workorders', { status: newSt }, { id: wid });

  const ay = payload.actual_yield;
  if (ay !== null && ay !== undefined && strTrim(ay) !== '') {
    let ayF;
    try {
      ayF = toFloat(ay);
    } catch (e) {
      throw new Error('actual_yield 非法: ' + ay);
    }
    storeUpdate(ctx, 'sop_workorders', { actual_yield: ayF }, { id: wid });
  }

  let desc = 'workorder#' + wid + ' ' + curSt + ' → ' + newSt;
  if (ay !== null && ay !== undefined && strTrim(ay) !== '') desc += ' ·出成=' + ay;

  // 首次进入制作中且未备料扣：按 BOM 扣料一次
  if (newSt === '制作中' && curSt !== '制作中' && !already
    && payload.deduct !== false) {
    try {
      const deduct = deductBomForWorkorder(ctx, data, sku, woQty, wid);
      if (deduct) desc += '；备料扣 ' + deduct;
      // 无论是否匹配到原料，标记已处理，避免重复推进再扣
      storeUpdate(ctx, 'sop_workorders', { bom_deducted: 1 }, { id: wid });
      desc += ' ·已标记备料';
    } catch (exc) {
      desc += '；BOM扣料跳过(' + (exc && exc.message ? exc.message : exc) + ')';
    }
  } else if (newSt === '制作中' && already) {
    desc += ' ·备料已扣跳过';
  }
  return desc;
}

/** 读取 steps_state（兼容字符串 JSON / 对象） */
function parseStepsState(raw) {
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (e) {
      return {};
    }
    return {};
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return Object.assign({}, raw);
  return {};
}

/**
 * workorder.step_clock：SOP 逐步打卡，写入 steps_state JSON。
 * 待开始工单首次打卡 → 自动切到制作中（不扣 BOM；扣料仍走 advance）。
 */
function clockWorkorderStep(ctx, data, payload) {
  const wid = payload.id || payload.workorder_id;
  const stepNo = payload.step_no;
  if (wid === null || wid === undefined || strTrim(wid) === '') {
    throw new Error('缺少 workorder id');
  }
  if (stepNo === null || stepNo === undefined || strTrim(stepNo) === '') {
    throw new Error('缺少 step_no');
  }
  const key = /^\d+$/.test(strTrim(stepNo)) ? String(pint(stepNo)) : strTrim(stepNo);
  const operator = payload.operator || payload.staff || '店员';
  const doneAt = payload.done_at || nowIso();
  const undo = !!(payload.undo || payload.clear);

  const row = getWorkorder(ctx, wid);
  if (!row) throw new Error('工单不存在: ' + wid);

  const state = parseStepsState(row.steps_state);
  let action;
  if (undo) {
    delete state[key];
    action = '撤销';
  } else {
    state[key] = { done_at: doneAt, operator: operator };
    action = '打卡';
  }
  storeUpdate(ctx, 'sop_workorders', { steps_state: pyJson(state) }, { id: wid });

  const st = normWoStatus(row.status);
  let bumped = '';
  if (!undo && st === '待开始') {
    storeUpdate(ctx, 'sop_workorders', { status: '制作中' }, { id: wid });
    bumped = ' ·状态待开始→制作中';
  }
  return 'workorder#' + wid + ' step ' + key + ' ' + action + ' by ' + operator + bumped;
}

/* ---------- 食安证照 ---------- */

/**
 * fs.cert.upsert：登记/续期证照。有 id → 更新；无 id → 新建。
 */
function insertFsCert(ctx, data, payload) {
  const cid = payload.id;
  const ctype = payload.cert_type || payload.type || '食品经营许可';
  const holder = payload.holder || payload.name || '本店';
  const certNo = payload.cert_no || payload.no || '';
  const expire = payload.expire_at || payload.expire || '';
  const status = payload.status || '有效';
  const issued = payload.issued_at || today();
  if (cid) {
    const r = storeUpdate(ctx, 'fs_certs', {
      cert_type: ctype, holder: holder, cert_no: certNo,
      expire_at: expire, status: status, issued_at: issued
    }, { id: cid });
    if (r === 0 && !(ctx && ctx.store)) {
      fallback(ctx, data, 'fs_certs', {
        id: cid, cert_type: ctype, holder: holder, cert_no: certNo,
        expire_at: expire, status: status, issued_at: issued
      });
    }
    return 'fs_certs#' + cid + ' 续期至 ' + (expire || '-');
  }
  const rid = persist(ctx, data, 'fs_certs', {
    cert_type: ctype, holder: holder, cert_no: certNo,
    issued_at: issued, expire_at: expire, status: status
  });
  return 'fs_certs 新建 id=' + (rid === null ? '-' : rid) + ' ' + ctype;
}

/* ---------- day.close ---------- */

/**
 * day.close：老板确认打烊日清 → app_audit + fin_cash 登记 + data.config.last_day_close。
 * 金额口径：sold_amount 经 float(x or 0) 强转，非法回落 0。
 */
function applyDayClose(ctx, data, payload) {
  const date = payload.date || today();
  const soldC = pt(payload.sold_count);
  const soldA = pt(payload.sold_amount);
  const inboundC = pt(payload.inbound_count);
  const lossC = pt(payload.loss_count);
  const openWo = pt(payload.workorders_open);
  const note = payload.note || 'App 确认打烊';
  const body = '售出' + soldC + '笔¥' + soldA + ' · 入库' + inboundC
    + '笔 · 报损' + lossC + '笔 · 未完工单' + openWo + ' · ' + note;

  persist(ctx, data, 'app_audit', {
    kind: 'day_close', title: '打烊日清 ' + date, body: body
  });

  let amt = 0.0;
  try {
    amt = toFloatOr0(soldA);
  } catch (e) {
    amt = 0.0;
  }
  persist(ctx, data, 'fin_cash', {
    ts: nowIso(), kind: '打烊日清', amount: amt, account: '堂食+外卖', note: body
  });

  if (data.config === undefined || data.config === null) data.config = {};
  if (data.config && typeof data.config === 'object' && !Array.isArray(data.config)) {
    data.config.last_day_close = {
      date: date,
      sold_count: soldC,
      sold_amount: soldA,
      inbound_count: inboundC,
      loss_count: lossC,
      workorders_open: openWo,
      ts: nowIso(),
      note: note
    };
  }
  return 'day.close ' + date + ' ' + body;
}

/* ---------- finance.recon ---------- */

/**
 * finance.recon：老板确认当日堂食/外卖/采购三方勾兑 → fin_cash + app_audit + config 标记。
 * _f(k,*alts)：按序取第一个非 None/"" 的键，float 失败回落 0，全缺回落 0。
 */
function applyFinanceRecon(ctx, data, payload) {
  const date = payload.date || today();

  const f = function () {
    const keys = Array.prototype.slice.call(arguments);
    for (const key of keys) {
      const v = payload[key];
      if (v !== null && v !== undefined && v !== '') {
        try {
          return toFloat(v);
        } catch (e) {
          return 0.0;
        }
      }
    }
    return 0.0;
  };

  const dine = f('dine_in', 'dine', '堂食');
  const takeout = f('takeout', '外卖');
  const purchase = f('purchase', '采购');
  const note = payload.note || 'App三方勾兑确认';
  const salesSum = dine + takeout;
  const body = '堂食¥' + dine.toFixed(2) + ' · 外卖¥' + takeout.toFixed(2)
    + ' · 采购¥' + purchase.toFixed(2) + ' · 差¥' + (salesSum - purchase).toFixed(2)
    + ' · ' + note;

  persist(ctx, data, 'fin_cash', {
    ts: nowIso(), kind: '三方勾兑', amount: salesSum, account: '收银vs采购', note: body
  });
  persist(ctx, data, 'app_audit', {
    kind: 'finance_recon', title: '三方勾兑 ' + date, body: body
  });

  if (data.config === undefined || data.config === null) data.config = {};
  if (data.config && typeof data.config === 'object' && !Array.isArray(data.config)) {
    data.config.last_finance_recon = {
      date: date,
      dine_in: dine,
      takeout: takeout,
      purchase: purchase,
      gap: Math.round((salesSum - purchase) * 100) / 100,
      ts: nowIso(),
      note: note
    };
  }
  return 'finance.recon ' + date + ' ' + body;
}

/* ---------- booking.upsert ---------- */

/**
 * booking.upsert → bookings 表（有 id 则更新状态，否则插入）。
 */
function upsertBooking(ctx, data, payload) {
  const bid = payload.id;
  if (bid) {
    storeUpdate(ctx, 'bookings', { status: payload.status || 'confirmed' }, { id: bid });
    return 'booking#' + bid + ' status=' + pt(payload.status);
  }
  const rid = persist(ctx, data, 'bookings', {
    guest_name: payload.guest_name || payload.name || '散客',
    phone: payload.phone || '',
    date: payload.date || today(),
    time: payload.time || '',
    party_size: payload.party_size || 2,
    table_id: pt(payload.table_id),
    status: payload.status || 'confirmed',
    note: payload.note || '',
    source: 'queue'
  });
  return 'booking 插入 id=' + (rid === null ? '-' : rid);
}

/* ---------- queue.call ---------- */

/**
 * queue.call：更新排队状态为叫号/就餐。
 * 命中 rowcount=0 或 store 缺失且 data.queue 无匹配 → 抛「排队号不存在」。
 */
function updateQueueCall(ctx, data, payload) {
  const qid = payload.id || payload.queue_no;
  const st = payload.status || '叫号';
  if (!qid) throw new Error('缺少 queue id/queue_no');

  let rowcount = 0;
  if (ctx && ctx.store && typeof ctx.store.update === 'function') {
    const r = ctx.store.update('queue', { status: st }, { id: qid, queue_no: String(qid), _op: 'OR' });
    rowcount = typeof r === 'object' && r && r.rowcount !== undefined ? r.rowcount : (r || 0);
  } else {
    // 降级：在 data.queue 上原地更新
    for (const q of arr(data && data.queue)) {
      if (String((q && q.id) || '') === String(qid) || String((q && q.queue_no) || '') === String(qid)) {
        q.status = st;
        rowcount += 1;
      }
    }
  }
  if (rowcount === 0) throw new Error('排队号不存在: ' + qid);
  return 'queue ' + qid + ' → ' + st;
}

/* ---------- queue.join ---------- */

/**
 * queue.join：现场取号入队。号序为当日已有条数 +1（Q%02d）。
 */
function insertQueueJoin(ctx, data, payload) {
  const date = payload.date || today();
  let party = 2;
  try {
    party = pint(payload.party_size || payload.party || 2);
  } catch (e) {
    party = 2;
  }

  let n = 1;
  if (ctx && ctx.store && typeof ctx.store.query === 'function') {
    const rows = ctx.store.query('SELECT COUNT(*) AS c FROM queue WHERE date=?', [date]);
    if (Array.isArray(rows) && rows.length && rows[0]) {
      const c = rows[0].c !== undefined ? rows[0].c : rows[0]['COUNT(*)'];
      n = pint(c || 0) + 1;
    }
  } else {
    const cnt = arr(data && data.queue).filter((q) => String((q && q.date) || '') === date).length;
    n = cnt + 1;
  }

  let qno = payload.queue_no;
  if (!truthy(qno)) qno = n < 10 ? 'Q0' + n : 'Q' + n;
  else qno = String(qno);
  const status = payload.status || '排队中';
  const ts = payload.ts || nowIso();
  const rid = persist(ctx, data, 'queue', {
    queue_no: qno, date: date, party_size: party,
    status: status, ts: ts, source: 'queue'
  });
  return 'queue.join ' + qno + ' party=' + party + ' id=' + (rid === null ? '-' : rid);
}

/* ---------- staff.clock ---------- */

/**
 * staff.clock：补打卡 → staff_clock。
 */
function insertStaffClock(ctx, data, payload) {
  const rid = persist(ctx, data, 'staff_clock', {
    staff_id: payload.staff_id || '',
    ts: payload.ts || nowIso(),
    kind: payload.kind || '上班',
    status: payload.status || '补录',
    source: 'queue'
  });
  return 'staff_clock rowid=' + (rid === null ? '-' : rid);
}

/* ---------- staff.shift_upsert ---------- */

/**
 * staff.shift_upsert → staff_shifts。
 */
function upsertStaffShift(ctx, data, payload) {
  const row = {
    staff_id: payload.staff_id || '',
    staff_name: payload.staff_name || payload.name || '',
    date: payload.date || today(),
    shift: payload.shift || '早班',
    start_time: payload.start_time || '',
    end_time: payload.end_time || '',
    role: payload.role || ''
  };
  let rid = storeUpsert(ctx, 'staff_shifts', row, ['staff_id', 'date', 'shift']);
  if (rid === null && !(ctx && ctx.store)) rid = fallback(ctx, data, 'staff_shifts', row);
  return 'staff_shifts rowid=' + (rid === null ? '-' : rid);
}

/* ---------- uniform.log ---------- */

/**
 * uniform.log → staff_train（工服合规检查）。
 * pass ∈ (1, True, "1", "合格", "pass") → 1，否则 0。
 */
function insertUniformLog(ctx, data, payload) {
  const row = {
    staff_id: payload.staff_id || 'uniform',
    course: payload.course || '工服合规检查',
    passed: [1, true, '1', '合格', 'pass'].indexOf(payload.pass) >= 0 ? 1 : 0,
    ts: payload.ts || nowIso(),
    remark: payload.note || payload.remark || 'queue'
  };
  const rid = persist(ctx, data, 'staff_train', row);
  return 'uniform/staff_train rowid=' + (rid === null ? '-' : rid);
}

/* ---------- fs.disinfect ---------- */

/**
 * fs.disinfect → fs_disinfect（source 列缺失时由 store 层回落）。
 */
function insertDisinfect(ctx, data, payload) {
  const rid = persist(ctx, data, 'fs_disinfect', {
    date: payload.date || today(),
    area: payload.area || '',
    method: payload.method || '',
    operator: payload.operator || 'QUEUE',
    ts: payload.ts || nowIso(),
    source: 'queue'
  });
  return 'fs_disinfect 插入 rowid=' + (rid === null ? '-' : rid);
}

/* ---------- fs.trace_scan ---------- */

/**
 * fs.trace_scan → fs_trace（扫码溯源登记）：batch 取 batch/batch_no/lot。
 */
function insertFsTrace(ctx, data, payload) {
  const name = payload.name || payload.ing_name || '';
  const batch = payload.batch || payload.batch_no || payload.lot || '';
  const supplier = payload.supplier || '';
  const recv = payload.recv_date || today();
  const check = payload.check_result || '合格';
  const rid = persist(ctx, data, 'fs_trace', {
    batch_no: batch, ing_name: name, supplier: supplier,
    recv_date: recv, check_result: check, source: 'queue'
  });
  return 'fs_trace 扫码 rowid=' + (rid === null ? '-' : rid);
}

/* ---------- equipment.maintain ---------- */

/**
 * equipment.maintain → eq_maintain。
 */
function insertEqMaintain(ctx, data, payload) {
  const rid = persist(ctx, data, 'eq_maintain', {
    device: payload.device || '',
    kind: payload.kind || '保养',
    ts: payload.ts || nowIso(),
    operator: payload.operator || 'QUEUE',
    cost: pt(payload.cost),
    next_due: pt(payload.next_due),
    note: payload.note || ''
  });
  return 'eq_maintain rowid=' + (rid === null ? '-' : rid);
}

/**
 * equipment.temp_log → eq_temp（M8-T2 温度登记）。
 * eq_temp 为红线「不进 rev 体系」的高频时序表：仅走 sqlite store，
 * 无 store 时不回落 data.ext，避免把高频点混入整库 rev 合并。
 */
function insertEqTemp(ctx, data, payload) {
  const row = {
    ts: payload.ts || nowIso(),
    device: payload.device || '',
    temp: pt(payload.temp != null ? payload.temp : payload.celsius)
  };
  const rid = storeInsert(ctx, 'eq_temp', row);
  return 'eq_temp rowid=' + (rid === null ? '-' : rid) + (rid === null ? '（无 store，按红线不回落 rev）' : '');
}

/**
 * equipment.energy_log → eq_energy（M8-T4 能耗抄表）。
 */
function insertEqEnergy(ctx, data, payload) {
  const rid = persist(ctx, data, 'eq_energy', {
    date: payload.date || today(),
    device: payload.device || '',
    kind: payload.kind || '电',
    reading: pt(payload.reading),
    usage: pt(payload.usage)
  });
  return 'eq_energy rowid=' + (rid === null ? '-' : rid);
}

/* ---------- vip.campaign ---------- */

/**
 * vip.campaign：活动草案 → vip_coupons 作为未使用券模板。
 * 折扣文案如「8折」→ type 补充，value 记 0；有 gift 且 type 为活动/生日赠时补进 type。
 */
function insertVipCampaign(ctx, data, payload) {
  const code = payload.code || ('CMP' + hex(8).toUpperCase());
  const gift = payload.gift || payload.note;
  let ctype = payload.type || payload.campaign_type || '活动';
  if (gift && (ctype === '活动' || ctype === '生日赠')) {
    ctype = ctype + '·' + gift;
  }
  let rawVal = payload.value;
  if (rawVal === undefined || rawVal === null) rawVal = payload.amount;
  let value = 0;
  let valueStr = '0'; // Python 异常/缺值分支记 int 0（"%s" → "0"）
  if (rawVal !== null && rawVal !== undefined && rawVal !== '') {
    try {
      value = toFloat(rawVal);
      valueStr = pf(value); // Python "%s" % float 保留 .0
    } catch (e) {
      if (rawVal && !gift) ctype = ctype + '·' + rawVal;
      value = 0;
      valueStr = '0';
    }
  }
  storeUpsert(ctx, 'vip_coupons', {
    code: code,
    member_id: pt(payload.member_id),
    type: ctype,
    value: value,
    status: '未使用',
    valid_to: pt(payload.valid_to)
  }, ['code']);
  return 'vip_coupons code=' + code + ' type=' + ctype + ' value=' + valueStr;
}

/* ---------- vip.coupon_redeem ---------- */

/**
 * vip.coupon_redeem：核销券；不存在则补插一条已核销。
 */
function redeemVipCoupon(ctx, data, payload) {
  const code = strTrim(payload.code);
  if (!code) throw new Error('vip.coupon_redeem 缺 code');
  // 状态机守卫：已核销/已作废 不可重复核销
  let curStatus = null;
  if (ctx && ctx.store && typeof ctx.store.query === 'function') {
    try {
      const rows = ctx.store.query('SELECT status FROM vip_coupons WHERE code = ?', [code]) || [];
      if (rows.length) curStatus = String(rows[0].status || '');
    } catch (e) { curStatus = null; }
  }
  if (curStatus === null) {
    const row = arr(data && data.vip_coupons).find((c) => String((c && c.code) || '') === code);
    if (row) curStatus = String(row.status || '');
  }
  if (curStatus && /已核销|已作废/.test(curStatus)) {
    throw new Error('券已核销/作废，禁止重复核销: ' + code);
  }
  let rowcount;
  if (ctx && ctx.store && typeof ctx.store.update === 'function') {
    const r = ctx.store.update('vip_coupons', { status: '已核销' }, { code: code });
    rowcount = typeof r === 'object' && r && r.rowcount !== undefined ? r.rowcount : (r || 0);
  } else {
    rowcount = 0;
    for (const c of arr(data && data.vip_coupons)) {
      if (String((c && c.code) || '') === code) { c.status = '已核销'; rowcount += 1; }
    }
  }
  if (rowcount <= 0) {
    persist(ctx, data, 'vip_coupons', {
      code: code,
      member_id: pt(payload.member_id),
      type: payload.type || '核销',
      value: payload.value || 0,
      status: '已核销',
      valid_to: null
    });
  }
  return 'vip_coupons redeem ' + code;
}

/**
 * 会员储值扣减（与 POS 结账联动）：
 *   余额不足直接拒绝（绝不出现负余额）；成功后写 vip_visits 作审计。
 */
function deductVipBalance(ctx, data, payload) {
  const memberId = strTrim(payload.member_id);
  const amount = num(payload.amount, 0);
  if (!memberId) throw new Error('vip.balance_deduct 缺 member_id');
  if (!(amount > 0)) throw new Error('vip.balance_deduct 金额需 > 0');

  let balance = null;
  if (ctx && ctx.store && typeof ctx.store.query === 'function') {
    try {
      const rows = ctx.store.query('SELECT balance FROM vip_balance WHERE member_id = ?', [memberId]) || [];
      if (rows.length) balance = num(rows[0].balance, 0);
    } catch (e) { balance = null; }
  }
  if (balance === null) {
    const row = arr(data && data.vip_balance).find((x) => String((x && x.member_id) || '') === memberId);
    if (!row) throw new Error('未找到会员储值: ' + memberId);
    balance = num(row.balance, 0);
  }
  if (balance < amount) throw new Error('余额不足：现 ' + balance + ' < 扣减 ' + amount);

  const next = Math.round((balance - amount) * 100) / 100;
  if (ctx && ctx.store && typeof ctx.store.update === 'function') {
    ctx.store.update('vip_balance', { balance: next, updated_at: nowIso() }, { member_id: memberId });
  }
  for (const row of arr(data && data.vip_balance)) {
    if (String((row && row.member_id) || '') === memberId) row.balance = next;
  }
  persist(ctx, data, 'vip_visits', {
    member_id: memberId,
    name: pt(payload.name),
    phone: pt(payload.phone),
    table_id: pt(payload.table_id),
    note: '储值扣减 ¥' + amount + '（余额 → ' + next + '）',
    ts: nowIso(),
    source: 'si-vip'
  });
  return 'vip_balance deduct ' + memberId + ' -' + amount + ' → ' + next;
}

/* ---------- analysis.export_week ---------- */

/**
 * analysis.export_week → app_audit（week_export）。
 */
function insertWeekExport(ctx, data, payload) {
  const title = payload.title || '经营周报';
  const note = String(payload.note || 'App 导出周报草案');
  persist(ctx, data, 'app_audit', { kind: 'week_export', title: title, body: note });
  return 'app_audit week_export';
}

/* ---------- takeout.ack ---------- */

/**
 * takeout.ack：有 id → 更新 takeout_orders 状态；否则写 takeout_reconcile。
 * 表列差异由 store 层回落；无 store 时仅在 data 上标记。
 */
function insertTakeoutAck(ctx, data, payload) {
  const oid = payload.id || payload.order_id;
  if (oid) {
    storeUpdate(ctx, 'takeout_orders', { status: payload.status || '已确认' }, { id: oid });
    return 'takeout_orders#' + oid + ' ack';
  }
  const rid = persist(ctx, data, 'takeout_reconcile', {
    date: payload.date || today(),
    platform: payload.platform || '',
    amount: pt(payload.amount),
    status: payload.status || '已对账',
    note: payload.note || 'queue ack'
  });
  return 'takeout_reconcile rowid=' + (rid === null ? '-' : rid);
}

/* ---------- review.followup ---------- */

/**
 * review.followup：差评跟进 / 堂食当场客诉。
 * 无 review_id 时先落 rv_reviews（当场客诉），再写 rv_improve。
 * 新建的当场客诉默认待处理；对已有差评做跟进 → 标已处理；显式 handled=1 也标已处理。
 */
function insertReviewFollowup(ctx, data, payload) {
  let rid = payload.review_id;
  let created = null;
  const hasCreate = !rid && (
    payload.content
    || payload.source
    || payload.table_id
    || String(payload.action || '').indexOf('客诉') >= 0
  );
  if (hasCreate) {
    let content = payload.content || payload.note || '堂食客诉';
    const tid = payload.table_id || payload.no;
    if (tid) content = '桌' + tid + ' · ' + content;
    created = persist(ctx, data, 'rv_reviews', {
      source: payload.source || '堂食当场',
      rating: payload.rating !== undefined && payload.rating !== null ? payload.rating : 2.0,
      content: content,
      ts: payload.ts || nowIso(),
      handled: 0
    });
    rid = created;
  }
  if (rid !== null && rid !== undefined) {
    if ([1, true, '1', 'true'].indexOf(payload.handled) >= 0) {
      storeUpdate(ctx, 'rv_reviews', { handled: 1 }, { id: rid });
    } else if (created === null) {
      storeUpdate(ctx, 'rv_reviews', { handled: 1 }, { id: rid });
    }
  }
  const imp = persist(ctx, data, 'rv_improve', {
    review_id: pt(rid),
    action: payload.action || payload.note || '跟进',
    owner: payload.owner || 'QUEUE',
    due: pt(payload.due),
    status: payload.status || (created ? '待处理' : '进行中')
  });
  if (created) {
    return 'rv_reviews#' + created + ' + rv_improve#' + (imp === null ? '-' : imp) + '（当场客诉）';
  }
  return 'rv_improve rowid=' + (imp === null ? '-' : imp);
}

/* ---------- vip.checkin ---------- */

/**
 * vip.checkin：会员到店识别 → vip_visits + 会员状态「在店」+ data.logs 与桌台挂会员。
 */
function insertVipCheckin(ctx, data, payload) {
  let mid = strTrim(payload.member_id || payload.id || payload.phone);
  let name = payload.name || payload.guest_name || '';
  let phone = payload.phone || '';
  if (!mid && !name && !phone) {
    throw new Error('vip.checkin 需 member_id / name / phone 之一');
  }
  if (!mid) {
    mid = 'V' + (phone ? String(phone).slice(-4) : hex(6));
  }
  let tid = strTrim(payload.table_id || payload.no);
  if (!tid) tid = null;
  const ts = payload.ts || nowIso();
  let visitId = null;

  // 尽量挂上已知会员（有 store 时查 vip_members）
  if ((!name || !phone) && ctx && ctx.store && typeof ctx.store.query === 'function') {
    const rows = ctx.store.query(
      'SELECT name, phone FROM vip_members WHERE member_id=? OR phone=?', [mid, phone || mid]
    );
    if (Array.isArray(rows) && rows.length && rows[0]) {
      name = name || (rows[0].name || '');
      phone = phone || (rows[0].phone || '');
    }
  }

  visitId = persist(ctx, data, 'vip_visits', {
    member_id: mid,
    name: name || mid,
    phone: phone,
    table_id: tid,
    note: payload.note || '到店识别',
    ts: ts,
    source: 'queue'
  });

  // 更新/插入会员状态
  let exists = null;
  if (ctx && ctx.store && typeof ctx.store.query === 'function') {
    const rows = ctx.store.query(
      'SELECT member_id FROM vip_members WHERE member_id=? OR (?!=\'\' AND phone=?)',
      [mid, phone, phone]
    );
    if (Array.isArray(rows) && rows.length && rows[0]) exists = rows[0];
  }
  if (exists) {
    storeUpdate(ctx, 'vip_members', { status: '在店' }, { member_id: exists.member_id });
    mid = exists.member_id;
  } else {
    storeUpsert(ctx, 'vip_members', {
      member_id: mid, name: name || mid, phone: phone || null,
      level: '到店客', joined_at: today(), status: '在店'
    }, ['member_id']);
  }

  if (data && typeof data === 'object') {
    if (data.logs === undefined || data.logs === null) data.logs = [];
    if (Array.isArray(data.logs)) {
      data.logs.push({
        id: 'VC' + hex(8),
        kind: 'vip_checkin',
        member_id: mid,
        name: name,
        phone: phone,
        table_id: tid,
        note: pt(payload.note),
        ts: ts,
        source: 'queue'
      });
    }
    if (tid) {
      const t = findPosTable(data, tid);
      if (t !== null) {
        t.vip_member_id = mid;
        t.vip_name = name || mid;
      }
    }
  }
  return 'vip.checkin ' + (name || mid) + (tid ? ' @' + tid : '')
    + ' id=' + (visitId === null ? '-' : visitId);
}

/* ---------- finance.freeze / finance.approve ---------- */

/**
 * insert_fin_split：finance.freeze（approve=false，状态冻结中）/
 * finance.approve（approve=true，有 id 则改状态，否则插入已结算）。
 */
function insertFinSplit(ctx, data, payload, approve) {
  if (approve && payload.id) {
    storeUpdate(ctx, 'fin_split', { status: payload.status || '已结算' }, { id: payload.id });
    return 'fin_split#' + payload.id + ' approved';
  }
  const rid = persist(ctx, data, 'fin_split', {
    period: payload.period || today().slice(0, 7),
    party: payload.party || '',
    amount: pt(payload.amount),
    ratio: pt(payload.ratio),
    frozen_until: pt(payload.frozen_until),
    status: approve ? (payload.status || '已结算') : '冻结中'
  });
  return 'fin_split rowid=' + (rid === null ? '-' : rid);
}

/* ---------- finance.invoice / finance.tax / finance.cash（M9） ---------- */

/**
 * finance.invoice → fin_invoices（M9-T2 开票登记/入账）。
 */
function insertFinInvoice(ctx, data, payload) {
  const rid = persist(ctx, data, 'fin_invoices', {
    invoice_no: payload.invoice_no || payload.no || '',
    kind: payload.kind || '普票',
    direction: payload.direction || '销项',
    amount: pt(payload.amount),
    tax: pt(payload.tax),
    ts: payload.ts || nowIso(),
    status: payload.status || '已开具'
  });
  return 'fin_invoices rowid=' + (rid === null ? '-' : rid);
}

/**
 * finance.tax → fin_tax（M9-T4 税务申报登记：申报/缴款状态）。
 */
function insertFinTax(ctx, data, payload) {
  const rid = persist(ctx, data, 'fin_tax', {
    period: payload.period || today().slice(0, 7),
    kind: payload.kind || '增值税',
    amount: pt(payload.amount),
    filed_at: payload.filed_at || null,
    status: payload.status || '待申报'
  });
  return 'fin_tax rowid=' + (rid === null ? '-' : rid);
}

/**
 * finance.cash → fin_cash（M9-T4 现金流水登记：备用金/找零/存款）。
 */
function insertFinCash(ctx, data, payload) {
  const rid = persist(ctx, data, 'fin_cash', {
    ts: payload.ts || nowIso(),
    kind: payload.kind || '支出',
    amount: pt(payload.amount),
    account: payload.account || '未标',
    note: payload.note || ''
  });
  return 'fin_cash rowid=' + (rid === null ? '-' : rid);
}

module.exports = {
  insertQcRecord,
  insertQcForcePass,
  persist,
  applyQueueServe,
  insertQueueServe,
  insertLossReport,
  insertSample,
  clearSample,
  insertWorkorder,
  normWoStatus,
  advanceWorkorder,
  clockWorkorderStep,
  insertFsCert,
  applyDayClose,
  applyFinanceRecon,
  upsertBooking,
  updateQueueCall,
  insertQueueJoin,
  insertStaffClock,
  upsertStaffShift,
  insertUniformLog,
  insertDisinfect,
  insertFsTrace,
  insertEqMaintain,
  insertEqTemp,
  insertEqEnergy,
  insertVipCampaign,
  redeemVipCoupon,
  deductVipBalance,
  insertWeekExport,
  insertTakeoutAck,
  insertReviewFollowup,
  insertVipCheckin,
  insertFinSplit,
  insertFinInvoice,
  insertFinTax,
  insertFinCash,
  // 内部复用（测试可用）
  _internal: { getWorkorder, fallback, persist, rebuildStock }
};
