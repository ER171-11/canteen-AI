'use strict';
/*
 * lib/skill_matrix.js — 培训 ↔ SKU 映射与「禁接单」校验（M2-T6 单一事实来源）
 *
 * 口径：某些 SKU 只允许「已通过对应培训」的岗位人员承接（建/接工单）。
 *   - 映射默认内置（按五色 SOP 课程 ↔ SKU），可由 config.skill_matrix 覆盖；
 *   - 校验读培训记录（staff_id + course + passed/remark）；
 *   - 无可判定信息（无映射 / 未传 staff_id / 无培训数据）→ 放行，避免误伤历史链路；
 *   - 只有「有映射 + 指定了人 + 确认未通过」才拒绝。
 *
 * 红线：只读培训记录，不产生写操作。
 */
const DEFAULT_MATRIX = {
  'SKU-WF-HONG': '红饺 SOP',
  'SKU-WF-HEI': '黑饺 SOP'
};

/** 取生效映射：config.skill_matrix（对象）覆盖默认 */
function matrixOf(config) {
  const m = config && config.skill_matrix;
  if (m && typeof m === 'object' && !Array.isArray(m) && Object.keys(m).length) return m;
  return DEFAULT_MATRIX;
}

/** 培训记录是否「通过」：passed 兼容 1/true/'1'/'true'，或 remark 含通过字样 */
function passedOf(row) {
  if (!row) return false;
  const p = row.passed;
  if (p === 1 || p === true || p === '1' || String(p).toLowerCase() === 'true') return true;
  return /通过|已过|合格|pass/i.test(String(row.remark || ''));
}

/** 某 SKU 需要哪门培训（无则 null） */
function requiredCourse(config, skuId) {
  return matrixOf(config)[String(skuId || '')] || null;
}

/**
 * 校验某岗位人员能否承接某 SKU 工单。
 * @param rows  培训记录数组（已按 staff_id/course 过滤，或传全量由本函数过滤）
 * @param config 快照 data.config（可含 skill_matrix）
 * @param p    {sku_id, staff_id}
 * @returns {{ok:boolean, gated:boolean, course?:string, error?:string, reason?:string}}
 */
function checkSkill(rows, config, p) {
  const o = p || {};
  const course = requiredCourse(config, o.sku_id);
  if (!course) return { ok: true, gated: false };
  if (!o.staff_id) {
    return { ok: true, gated: false, course, reason: '未指定岗位人员，跳过培训校验' };
  }
  if (!Array.isArray(rows)) {
    return { ok: true, gated: false, course, reason: '无培训数据，跳过培训校验' };
  }
  const hit = rows.filter(
    (r) => String((r && r.staff_id) || '') === String(o.staff_id)
      && String((r && (r.course || r.name)) || '') === course
  );
  if (hit.some(passedOf)) return { ok: true, gated: true, course };
  return {
    ok: false,
    gated: true,
    course,
    error: '未通过「' + course + '」培训，禁止承接 ' + o.sku_id + ' 工单（岗位 ' + o.staff_id + '）'
  };
}

/** 某员工已通过 / 未通过的课程列表（供 UI 展示） */
function staffCourses(rows, staffId) {
  if (!Array.isArray(rows) || !staffId) return [];
  return rows
    .filter((r) => String((r && r.staff_id) || '') === String(staffId))
    .map((r) => ({
      course: (r && (r.course || r.name)) || '',
      passed: passedOf(r),
      remark: (r && r.remark) || '',
      ts: (r && r.ts) || null
    }));
}

/** SOP 进度 n/5：按课程聚合已通过步数（同一课程多条记录取通过数，上限 5） */
const SOP_TOTAL = 5;
function trainProgress(rows, config) {
  const list = Array.isArray(rows) ? rows : [];
  const byStaff = {};
  for (const r of list) {
    if (!r || r.staff_id == null) continue;
    const sid = String(r.staff_id);
    const course = String((r.course || r.name) || '未命名课程');
    if (!byStaff[sid]) byStaff[sid] = { staff_id: sid, staff_name: (r.staff_name || r.name || null), courses: {} };
    const c = byStaff[sid].courses[course] || { course, passed: 0, total: SOP_TOTAL, last_ts: null, pending: false };
    if (passedOf(r)) c.passed = Math.min(c.total, c.passed + 1);
    else c.pending = true;
    const ts = (r && r.ts) || null;
    if (ts && (!c.last_ts || String(ts) > String(c.last_ts))) c.last_ts = ts;
    byStaff[sid].courses[course] = c;
  }
  const matrix = matrixOf(config);
  return Object.keys(byStaff).sort().map((sid) => {
    const s = byStaff[sid];
    const courses = Object.keys(s.courses).map((k) => {
      const c = s.courses[k];
      return {
        course: c.course,
        done: c.passed,
        total: c.total,
        pct: Math.round((c.passed / c.total) * 100),
        passed: c.passed >= c.total && !c.pending,
        last_ts: c.last_ts
      };
    });
    const gatedSkus = Object.keys(matrix).filter((sku) => matrix[sku] && courses.some((c) => c.course === matrix[sku]));
    return {
      staff_id: sid,
      staff_name: s.staff_name,
      courses,
      gated_skus: gatedSkus,
      blocked_skus: gatedSkus.filter((sku) => {
        const need = matrix[sku];
        const c = courses.find((x) => x.course === need);
        return c ? !c.passed : true;
      })
    };
  });
}

module.exports = {
  DEFAULT_MATRIX,
  SOP_TOTAL,
  matrixOf,
  passedOf,
  checkSkill,
  requiredCourse,
  staffCourses,
  trainProgress
};
