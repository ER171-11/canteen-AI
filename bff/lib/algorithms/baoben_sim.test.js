'use strict';
/*
 * 结构测算「模拟态」只读推演测试（ADR-007）
 *
 * 覆盖三件事：
 *   ① 公式单一来源：`computeModel()` 抽出的算术与 `computeBaobenSummary()` 逐字段自洽；
 *   ② 口径照抄旧版：日销量三口径（估算 / 近30天 / 近7天）+ 无销量回落开关；
 *   ③ 零写库（可测断言，非声明）：推演前后 data/*.json 的 mtime 与 actions 队列内容不变，
 *      且传入的行数组不被 mutate。
 * 用法：node bff/lib/algorithms/baoben_sim.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '../../data');
const mb = require('../menu_baoben');
const simRoute = require('../../routes/analysis_sim');

const SNAP_PATH = path.join(DATA, 'snapshot.json');
const BAOBEN_PATH = path.join(DATA, 'menu-baoben.json');
const QUEUE_PATH = path.join(DATA, 'actions_queue.json');

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}
function stamp(p) {
  try { return fs.statSync(p).mtimeMs; } catch (e) { return null; }
}
function digest(p) {
  try { return require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch (e) { return null; }
}

/** 直接驱动路由处理器（与线上同一条代码路径），返回响应体 */
async function callSim(body) {
  const ctx = {
    query: new URLSearchParams(''),
    auth: { role: 'admin', account: 'test' },
    storeId: null,
    readBody: () => Promise.resolve({ tooLarge: false, buf: Buffer.from(JSON.stringify(body || {})) }),
    sendJSON: (res, status, obj) => { res.__out = { status, obj }; },
    kimiLog: () => {}
  };
  const res = {};
  const handled = await simRoute.handle(  // handle 为 async，必须 await 才能拿到响应
    { method: 'POST', headers: {}, url: simRoute.SIM_PATH },
    res, ctx, simRoute.SIM_PATH
  );
  assert.ok(handled, '路由未接管 ' + simRoute.SIM_PATH);
  assert.deepStrictEqual(res.__out.status, 200, '响应码应为 200');
  return res.__out.obj;
}

async function main() {
  const snap = readJSON(SNAP_PATH);
  assert.ok(snap && Array.isArray(snap.data.dishes), '缺少 data/snapshot.json');
  const sales = Array.isArray(snap.data.sales) ? snap.data.sales : [];
  const dishes = snap.data.dishes;

  /* ---------- ① 抽出的 computeModel 与基线汇总自洽 ---------- */
  const summary = mb.computeBaobenSummary();
  assert.ok(summary, 'computeBaobenSummary 应返回结果');
  const doc = mb.loadMenuBaoben();
  const M = mb.computeModel(
    doc.items.map((d) => ({ price: d.price, cost: d.cost, qty: d.daily_qty, type: d.type })),
    mb.DEFAULT_PARAMS
  );
  assert.strictEqual(M.types.length, summary.types.length, '类型数应一致');
  for (let i = 0; i < M.types.length; i++) {
    assert.deepStrictEqual(M.types[i], summary.types[i], `types[${i}] 应逐字段一致`);
  }
  assert.deepStrictEqual(mb.kpiOf(M, mb.DEFAULT_PARAMS), summary.kpi, 'kpi 应逐字段一致');
  assert.strictEqual(summary.count, doc.items.length, '基线行数 = 保本价盘条目数');

  /* ---------- ② 日销量口径照抄旧版 ---------- */
  assert.strictEqual(mb.DEFAULT_QMODE, 'real30', '默认口径应照抄旧版 SC_QMODE');
  assert.strictEqual(mb.DEFAULT_QFALLBACK, true, '默认回落应照抄旧版 SC_QFALLBACK');
  assert.strictEqual(mb.scQDays('real7'), 7);
  assert.strictEqual(mb.scQDays('real30'), 30);
  assert.strictEqual(mb.scQDays('est'), 30); // 旧版 scQDays() 的非 real7 分支即 30

  const merged = mb.mergeDishesWithBaoben(dishes);
  const shopNames = new Set(dishes.filter((d) => d && d.name != null).map((d) => String(d.name)));
  const shopRows = merged.dishes.filter((d) => d && shopNames.has(String(d.name || '')));

  const rowsEst = mb.toCalcRows(shopRows, { qmode: 'est', sales });
  const rowsR30 = mb.toCalcRows(shopRows, { qmode: 'real30', sales });
  const rowsR7 = mb.toCalcRows(shopRows, { qmode: 'real7', sales });
  assert.strictEqual(rowsEst.length, rowsR30.length, '口径不应改变行数');
  assert.strictEqual(rowsEst.length, rowsR7.length, '口径不应改变行数');
  for (const r of rowsEst) assert.strictEqual(r.src, 'est', '估算口径不应出现真实来源');

  // 真实口径 = 近 N 天总份数 ÷ N；无销量时按回落开关
  let nReal = 0;
  for (const r of rowsR30) {
    if (r.sq > 0) {
      nReal += 1;
      assert.strictEqual(r.src, 'real', `菜 ${r.name} 有真实销量应标记 real`);
      assert.strictEqual(r.qty, Math.round((r.sq / 30) * 100) / 100, `菜 ${r.name} 日销量应 = 近30天总份数/30`);
    } else {
      assert.strictEqual(r.qty, r.est, `菜 ${r.name} 无销量应回落估算值`);
    }
  }
  const rowsNoFb = mb.toCalcRows(shopRows, { qmode: 'real30', qfallback: false, sales });
  for (const r of rowsNoFb) {
    if (r.sq > 0) continue;
    assert.strictEqual(r.qty, 0, `关闭回落时无销量菜 ${r.name} 应为 0`);
  }
  // 近 7 天口径与近 30 天口径解耦（同菜可能在 7 天内有销量、30 天内更多）
  assert.ok(rowsR7.every((r, i) => r.name === rowsR30[i].name), '三口径行序应一致');

  /* ---------- ③ 零写库 + 不 mutate ---------- */
  const before = {
    snapStamp: stamp(SNAP_PATH),
    baobenStamp: stamp(BAOBEN_PATH),
    queueDigest: digest(QUEUE_PATH),
    snapDigest: digest(SNAP_PATH)
  };
  const body = {
    qmode: 'real30',
    qfallback: true,
    params: { days: 26, area: 380 },
    rows: { '老虎菜': { p: 21, q: 9 }, '酱黄瓜': { on: false }, '不存在的菜': { p: 1 } }
  };
  const out1 = await callSim(body);
  const out2 = await callSim(body);
  assert.strictEqual(out1.ok, true, 'ok 应为 true');
  assert.strictEqual(out1.sim, true, 'sim 标记应为 true');
  assert.strictEqual(out1.basis, 'shop_dishes', '模拟态基准行集应为本店在售菜品');
  assert.ok(out1.baoben_summary && out1.baoben_summary.kpi, '应回传 baoben_summary.kpi');
  assert.strictEqual(out1.qdays, 30, '默认口径天数应为 30');
  assert.strictEqual(out1.calc_dishes.length, rowsEst.length, '推演行集应与逐菜表行集同长');
  assert.strictEqual(out1.baoben_summary.params.days, 26, 'query 键名店参应生效');
  assert.strictEqual(out1.baoben_summary.params.area, 380, 'query 键名店参应生效');
  // 幂等：同入参两次输出一致（只读推演，无隐藏状态）
  assert.deepStrictEqual(out2, out1, '同入参两次推演输出应一致');

  const after = {
    snapStamp: stamp(SNAP_PATH),
    baobenStamp: stamp(BAOBEN_PATH),
    queueDigest: digest(QUEUE_PATH),
    snapDigest: digest(SNAP_PATH)
  };
  assert.deepStrictEqual(after, before, '推演不得改动 data/*.json（mtime/内容）');
  assert.strictEqual(after.snapDigest, before.snapDigest, 'snapshot.json 内容不得变化');

  /* ---------- 覆盖生效 ---------- */
  const outBase = await callSim({ qmode: 'est' });
  const baseRow = outBase.calc_dishes.find((r) => r.name === '老虎菜');
  assert.ok(baseRow, '应存在菜「老虎菜」');
  const overRow = out1.calc_dishes.find((r) => r.name === '老虎菜');
  assert.strictEqual(overRow.price, 21, '行内改价应生效');
  assert.strictEqual(overRow.qty, 9, '行内改量应生效');
  const offRow = out1.calc_dishes.find((r) => r.name === '酱黄瓜');
  assert.strictEqual(offRow.on, false, '模拟下架标记应生效');
  assert.strictEqual(out1.qstat.n_active, outBase.qstat.n_active - 1, '下架一行应少一道参与测算');
  // 改量/改价/下架都应改变店级模型（旧版 calcModel 即时重算）
  assert.notStrictEqual(outBase.baoben_summary.kpi.be_day, out1.baoben_summary.kpi.be_day,
    '覆盖应影响店级保本点');
  assert.notStrictEqual(outBase.baoben_summary.kpi.be_day, (await callSim({ qmode: 'est', rows: { '酱黄瓜': { on: false } } })).baoben_summary.kpi.be_day,
    '下架应影响店级保本点');

  // 传入的覆盖对象不被 mutate
  const bodySnapshot = JSON.stringify(body);
  await callSim(body);
  assert.strictEqual(JSON.stringify(body), bodySnapshot, '请求体不得被 mutate');

  /* ---------- 只认 POST / 只认本路径 ---------- */
  const ctxNoop = {
    query: new URLSearchParams(''),
    readBody: () => Promise.resolve({ tooLarge: false, buf: Buffer.from('{}') }),
    sendJSON: () => {},
    kimiLog: () => {}
  };
  assert.strictEqual(await simRoute.handle({ method: 'GET', headers: {} }, {}, ctxNoop, simRoute.SIM_PATH), false,
    '非 POST 不应接管（交外层 404）');
  assert.strictEqual(await simRoute.handle({ method: 'POST', headers: {} }, {}, ctxNoop, '/api/modules/analysis'), false,
    '其他路径不应接管');

  console.log('[baoben_sim.test] PASS  行集 ' + out1.calc_dishes.length
    + ' 道 · 真实口径命中 ' + out1.qstat.n_real + ' 道 · 未上架 ' + (out1.qstat.n_total - out1.qstat.n_active)
    + ' 道 · 默认口径 ' + mb.DEFAULT_QMODE + ' · 零写库校验通过');
}

if (require.main === module) {
  // main 为 async（路由 handle 异步）：必须走 then/catch，否则 FAIL 会被吞成 unhandledRejection
  main().catch((e) => {
    console.error('[baoben_sim.test] FAIL:', e && e.message);
    process.exit(1);
  });
}
