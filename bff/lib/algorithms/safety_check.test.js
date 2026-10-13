'use strict';
/*
 * 食安拍照上报测试：lib/safety_plan.js 纯函数 + safety.check / safety.ai_judge / safety.review 算法（经 executeAction）。
 * 用法：node bff/lib/algorithms/safety_check.test.js
 *
 * 守护四条硬红线与口径：
 *   1) 员工上报不等待 AI（safety.check 只写 pending，绝不调用外部 AI）；
 *   2) AI 初判失败写 error 且**不删记录**、**不覆盖 final_result**；
 *   3) 人工复核保留 ai_result（AI 初判不得被覆盖），可多次复核以最新为准；
 *   4) safety.review 在 policy.NEVER_AUTO 中（不可自动执行）；进度口径与 docs/safety-schema.md §3 一致。
 */
const assert = require('assert');
const plan = require('../safety_plan');
const policy = require('../policy');
const { executeAction } = require('./execute');

let pass = 0;
function ok(name) {
  pass += 1;
  console.log('  PASS ' + name);
}

function snap(data, ext) {
  return { rev: 1, generated_at: '2026-10-12T00:00:00', data: data || {}, ext: ext || {} };
}

const NOW = '2026-10-12T02:00:00.000Z';
const DAY = '2026-10-12';

/* ---------- 1. 内置种子点位（任务 11） ---------- */
{
  const pts = plan.DEFAULT_POINTS;
  assert.ok(pts.length >= 6 && pts.length <= 8, '种子点位应为 6~8 个，实为 ' + pts.length);
  const zones = new Set(pts.map((p) => p.zone));
  ['冷藏', '清洗', '备餐', '垃圾区'].forEach((z) => {
    assert.ok(zones.has(z), '种子点位须覆盖区域：' + z);
  });
  assert.ok(pts.every((p) => p.id && p.name && p.target && p.enabled === 1), '种子点位字段齐全且启用');
  assert.ok(
    pts.every((p) => p.demo_image_url == null || /^https?:\/\//.test(p.demo_image_url)),
    '样图只用占位 URL（不含真实照片）'
  );
  assert.ok(pts.every((p) => !/^data:/.test(String(p.demo_image_url || ''))), '不含任何 base64 图片');
  ok('内置种子点位 8 个、覆盖冷藏/清洗/备餐/垃圾区、仅占位样图');
}

/* ---------- 2. pointsOf：空态回退 + 自定义优先 + kind 排序 ---------- */
{
  assert.strictEqual(plan.pointsOf({}).length, plan.DEFAULT_POINTS.length, '空态回退内置种子');
  assert.strictEqual(plan.usingDefaultPoints({}), true);

  const custom = plan.pointsOf({
    safety: {
      points: [
        { id: 'SC-09', name: 'B点', zone: '冷藏', enabled: 1, sort: 20 },
        { id: 'SC-10', name: 'A点', zone: '清洗', enabled: 1, sort: 10 },
        { id: 'SC-11', name: '已删', zone: '清洗', enabled: 0, sort: 5 }
      ]
    }
  });
  assert.deepStrictEqual(custom.map((p) => p.id), ['SC-10', 'SC-09'], '自定义优先且按 sort 升序');
  assert.strictEqual(plan.usingDefaultPoints({ safety: { points: custom } }), false);
  assert.strictEqual(plan.findPoint({}, 'SC-01').name, '冷藏柜 A 内部', '内置兜底命中');
  assert.strictEqual(plan.findPoint({}, 'NOPE'), null);
  ok('pointsOf 空态回退 / 自定义优先 / 排序 / findPoint 兜底');
}

/* ---------- 3. safety.check：上报只写 pending，不调用外部 AI ---------- */
{
  const out = executeAction(snap({}), {
    type: 'safety.check',
    payload: { point_id: 'SC-01', photo_url: 'https://cdn.example.com/a.jpg', operator: '张三', taken_at: NOW },
    operator: '张三'
  }, { now: NOW });
  assert.strictEqual(out.ok, true, out.error);
  assert.strictEqual(out.handled, true);
  const rows = out.snapshot.data.safety.checks;
  assert.strictEqual(rows.length, 1, '应落 1 条核验记录');
  assert.strictEqual(rows[0].point_id, 'SC-01');
  assert.strictEqual(rows[0].operator, '张三');
  assert.strictEqual(rows[0].ai_result, 'pending', '上报不等待 AI：初判置 pending');
  assert.strictEqual(rows[0].final_result, null);
  assert.strictEqual(rows[0].status, 'pending');
  assert.strictEqual(rows[0].created_at, NOW);
  assert.ok(/^chk_/.test(rows[0].id), 'check_id 前缀 chk_');
  assert.strictEqual(out.result.ok, true);
  assert.strictEqual(out.result.check_id, rows[0].id);
  assert.ok(out.result.data && out.result.data.safety, '返回 data 子树');
  ok('safety.check 落 data.safety.checks（ai_result=pending，不调外部 AI）');

  // 未知点位 / 缺 point_id → 驳回
  assert.strictEqual(executeAction(snap({}), { type: 'safety.check', payload: { point_id: 'NOPE' } }).ok, false);
  assert.strictEqual(executeAction(snap({}), { type: 'safety.check', payload: {} }).ok, false);
  ok('safety.check 未知点位 / 缺 point_id 被驳回');
}

/* ---------- 4. safety.ai_judge：成功更新初判；失败写 error 不删记录 ---------- */
async function testAiJudge() {
  const base = executeAction(snap({}), {
    type: 'safety.check',
    payload: { point_id: 'SC-07', photo_url: 'https://cdn.example.com/g.jpg', operator: '李四', check_id: 'chk_fixed_1' }
  }, { now: NOW }).snapshot;

  /* 4.1 成功：注入视觉桩 */
  const visionOk = (input) => {
    assert.strictEqual(input.photo_url, 'https://cdn.example.com/g.jpg');
    assert.strictEqual(input.point.id, 'SC-07');
    return { ai_result: 'fail', ai_reason: '垃圾桶未加盖', ai_confidence: 88.5, model: 'stub-model', low_conf: false };
  };
  const out = await executeAction(base, { type: 'safety.ai_judge', payload: { check_id: 'chk_fixed_1' } }, { vision: visionOk, now: NOW });
  assert.strictEqual(out.ok, true, out.error);
  const row = out.snapshot.data.safety.checks[0];
  assert.strictEqual(row.ai_result, 'fail');
  assert.strictEqual(row.ai_reason, '垃圾桶未加盖');
  assert.strictEqual(row.ai_confidence, 88.5);
  assert.strictEqual(row.model, 'stub-model');
  assert.strictEqual(row.status, 'ai_done');
  assert.strictEqual(row.final_result, null, 'AI 初判绝不写 final_result');
  assert.strictEqual(out.result.need_review, true, 'AI 判 fail → 需人工复核');
  ok('safety.ai_judge 成功：写 ai_* 且不动 final_result');

  /* 4.2 失败：视觉桩返回 null → 记 error，保留原记录 */
  const outErr = await executeAction(base, { type: 'safety.ai_judge', payload: { check_id: 'chk_fixed_1' } }, { vision: () => null, now: NOW });
  assert.strictEqual(outErr.ok, true, outErr.error);
  const rowErr = outErr.snapshot.data.safety.checks[0];
  assert.strictEqual(rowErr.ai_result, 'error');
  assert.ok(/未配置或不可用/.test(rowErr.ai_reason), rowErr.ai_reason);
  assert.strictEqual(rowErr.status, 'error');
  assert.strictEqual(rowErr.final_result, null);
  assert.strictEqual(outErr.snapshot.data.safety.checks.length, 1, '失败不删除原记录');
  ok('safety.ai_judge 失败：写 error 且不删除原记录');

  /* 4.3 抛错的视觉桩同样落 error，不把动作判成驳回 */
  const outThrow = await executeAction(base, { type: 'safety.ai_judge', payload: { check_id: 'chk_fixed_1' } }, {
    vision: () => { throw new Error('取图超时'); }, now: NOW
  });
  assert.strictEqual(outThrow.ok, true);
  assert.ok(/取图超时/.test(outThrow.snapshot.data.safety.checks[0].ai_reason));
  ok('safety.ai_judge 视觉抛错：错误写进 ai_reason');

  /* 4.4 未知 check_id → 驳回 */
  const miss = await executeAction(base, { type: 'safety.ai_judge', payload: { check_id: 'nope' } }, { vision: visionOk });
  assert.strictEqual(miss.ok, false);
  assert.strictEqual(miss.handled, true);
  ok('safety.ai_judge 未知 check_id 被驳回');
}

/* ---------- 5. safety.review：人工改判保留 ai_result，可多次复核 ---------- */
function testReview() {
  const base = executeAction(snap({}), {
    type: 'safety.check',
    payload: { point_id: 'SC-03', photo_url: 'https://cdn.example.com/c.jpg', check_id: 'chk_fixed_2' }
  }, { now: NOW }).snapshot;
  base.data.safety.checks[0].ai_result = 'pass';
  base.data.safety.checks[0].ai_reason = '三步池洁净';
  base.data.safety.checks[0].status = 'ai_done';

  const r1 = executeAction(base, {
    type: 'safety.review',
    payload: { check_id: 'chk_fixed_2', final_result: 'fail', reason: '池底有残渣', reviewer: '店长' }
  }, { now: NOW });
  assert.strictEqual(r1.ok, true, r1.error);
  const row = r1.snapshot.data.safety.checks[0];
  assert.strictEqual(row.final_result, 'fail');
  assert.strictEqual(row.review_reason, '池底有残渣');
  assert.strictEqual(row.status, 'reviewed');
  assert.strictEqual(row.reviewed_by, '店长');
  assert.strictEqual(row.reviewed_at, NOW);
  assert.strictEqual(row.ai_result, 'pass', '红线：复核不得清空/覆盖 ai_result');
  assert.strictEqual(row.ai_reason, '三步池洁净');
  ok('safety.review 人工改判：写 final_result，ai_result 原样保留');

  // 多次复核：以最新为准
  const r2 = executeAction(r1.snapshot, {
    type: 'safety.review',
    payload: { check_id: 'chk_fixed_2', final_result: 'pass', reason: '已当场整改，复核通过' }
  }, { now: '2026-10-12T03:00:00.000Z' });
  const row2 = r2.snapshot.data.safety.checks[0];
  assert.strictEqual(row2.final_result, 'pass', '以最新一次复核为准');
  assert.strictEqual(row2.review_reason, '已当场整改，复核通过');
  assert.strictEqual(row2.ai_result, 'pass');
  assert.strictEqual(r2.snapshot.data.safety.checks.length, 1, '复核不改条数');
  ok('safety.review 多次复核以最新为准');

  // 非法 final_result / 未知 check → 驳回
  assert.strictEqual(executeAction(base, { type: 'safety.review', payload: { check_id: 'chk_fixed_2', final_result: 'maybe' } }).ok, false);
  assert.strictEqual(executeAction(base, { type: 'safety.review', payload: { check_id: 'nope', final_result: 'pass' } }).ok, false);
  ok('safety.review 非法结论 / 未知记录被驳回');

  // AI 未回（pending）仍可由人工下结论：人工优先，ai_result 保持 pending 不被改写
  const pendingSnap = executeAction(snap({}), {
    type: 'safety.check', payload: { point_id: 'SC-01', check_id: 'chk_fixed_3', operator: '王五' }
  }, { now: NOW }).snapshot;
  const rPend = executeAction(pendingSnap, {
    type: 'safety.review', payload: { check_id: 'chk_fixed_3', final_result: 'pass', reason: 'AI 未回，现场确认合格' }
  }, { now: NOW });
  assert.strictEqual(rPend.ok, true, rPend.error);
  assert.strictEqual(rPend.snapshot.data.safety.checks[0].final_result, 'pass');
  assert.strictEqual(rPend.snapshot.data.safety.checks[0].ai_result, 'pending', '不得伪造/覆盖 AI 初判');
  assert.strictEqual(rPend.snapshot.data.safety.checks[0].status, 'reviewed');
  ok('safety.review AI 未回时人工可下结论（人工优先，不伪造 AI 初判）');
}

/* ---------- 6. 分级授权：safety.review ∈ NEVER_AUTO ---------- */
{
  assert.strictEqual(policy.NEVER_AUTO.has('safety.review'), true);
  assert.strictEqual(policy.NEVER_AUTO.has('safety.check'), false, 'safety.check 允许自动执行');
  assert.strictEqual(policy.NEVER_AUTO.has('safety.ai_judge'), false, 'safety.ai_judge 允许自动执行');
  const cfg = {
    auto_enabled: true,
    caps: { daily_auto_max: 20 },
    policies: [{ id: 'p1', name: '全放开', enabled: true, match: { origin: 'si', types: [], max_amount: 0 } }]
  };
  const rev = policy.evaluate({ origin: 'si', type: 'safety.review', payload: {} }, cfg);
  assert.strictEqual(rev.auto, false, 'safety.review 不得自动执行');
  assert.strictEqual(rev.reason, '该类型禁止自动执行');
  const chk = policy.evaluate({ origin: 'si', type: 'safety.check', payload: {} }, cfg);
  assert.strictEqual(chk.auto, true, 'safety.check 命中政策可自动执行');
  ok('policy：safety.review 不可自动执行，safety.check 可自动执行');
}

/* ---------- 7. 进度口径 ---------- */
{
  const data = {
    safety: {
      points: [
        { id: 'SC-01', name: '冷藏柜 A 内部', zone: '冷藏', enabled: 1, sort: 10 },
        { id: 'SC-02', name: '冷冻柜 B 内部', zone: '冷藏', enabled: 1, sort: 20 },
        { id: 'SC-03', name: '洗消池', zone: '清洗', enabled: 1, sort: 30 }
      ],
      checks: [
        // 未复核 + AI pass → pass
        { id: 'c1', point_id: 'SC-01', ai_result: 'pass', final_result: null, created_at: DAY + 'T01:00:00.000Z', status: 'ai_done' },
        // 已复核改判 fail（AI 原判 pass）→ fail，不计 review（已复核）
        { id: 'c2', point_id: 'SC-02', ai_result: 'pass', final_result: 'fail', created_at: DAY + 'T01:10:00.000Z', status: 'reviewed' },
        // 未复核 + AI fail → fail 且计入 review_count
        { id: 'c3', point_id: 'SC-03', ai_result: 'fail', final_result: null, created_at: DAY + 'T01:20:00.000Z', status: 'ai_done' },
        // 未复核 + AI error → error_count
        { id: 'c4', point_id: 'SC-03', ai_result: 'error', final_result: null, created_at: DAY + 'T01:30:00.000Z', status: 'error' },
        // 非当日：不得计入
        { id: 'c5', point_id: 'SC-01', ai_result: 'press-not-valid', final_result: null, created_at: '2026-10-11T23:00:00.000Z' },
        // 脏数据（无 created_at）：不得计入
        { id: 'c6', point_id: 'SC-01', ai_result: 'fail' }
      ]
    }
  };
  const rep = plan.progressReport(data, DAY);
  assert.strictEqual(rep.date, DAY);
  assert.strictEqual(rep.total_points, 3);
  assert.strictEqual(rep.completed_points, 3, 'SC-01/02/03 当日均有记录');
  assert.strictEqual(rep.pass_count, 1, 'c1 pass');
  assert.strictEqual(rep.fail_count, 2, 'c2 人工 fail + c3 AI fail');
  assert.strictEqual(rep.review_count, 1, '仅 c3（未复核且 AI fail）');
  assert.strictEqual(rep.error_count, 1, 'c4');
  assert.strictEqual(rep.using_defaults, false);

  const byId = (id) => rep.points.filter((p) => p.point_id === id)[0];
  assert.strictEqual(byId('SC-01').status, 'pass');
  assert.strictEqual(byId('SC-02').status, 'fail', '人工改判后展示人工结论');
  assert.strictEqual(byId('SC-02').effective_result, 'fail');
  assert.strictEqual(byId('SC-03').status, 'error', '取最新一条记录（c4）');
  assert.strictEqual(byId('SC-03').check_id, 'c4');

  // 空快照：仍回满内置种子点位，计数全 0
  const empty = plan.progressReport({}, DAY);
  assert.strictEqual(empty.total_points, plan.DEFAULT_POINTS.length);
  assert.strictEqual(empty.completed_points, 0);
  assert.ok(empty.points.every((p) => p.status === 'none' && p.effective_result === null));
  ok('progressReport：pass/fail/review/error 口径与当日过滤正确');
}

async function main() {
  await testAiJudge();
  testReview();
  console.log('== safety_check 测试: ' + pass + ' 组全部通过 ==');
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
