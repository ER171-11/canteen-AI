'use strict';
/*
 * lib/store-adapter/contract.test.js — StoreAdapter 接口契约测试（ADR-010 Phase 0）
 *
 * 同一套断言连续跑在 json 与 sqlite 两个实现上，证明「接缝可用、可替换」：
 *   · 快照 read/write/casWrite（乐观锁：基准 rev 不符 → conflict）
 *   · 队列 enqueue/loadQueue/saveQueue
 *   · claim 原子认领（只取「待执行」，不重复取已认领）
 *   · ack 状态回写
 *   · appendAudit / listAudit
 *   · worker 端到端：claim → 跑算法 → casWrite → ack（rev 递增、副作用落库、动作置已执行）
 *
 * 运行：node lib/store-adapter/contract.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/* 隔离数据目录：必须在 require 适配器（会 require lib/store）之前设置 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canteen_adapter_'));
process.env.BFF_DATA_DIR = TMP;

const { createAdapter } = require('./index');

let failed = 0;
function ok(name, cond, got) {
  if (cond) { console.log('  ✓ ' + name); return; }
  failed++;
  console.error('  ✗ ' + name + '  got=' + JSON.stringify(got));
}

/* ---------------- 适配器契约 ---------------- */
function runAdapterSuite(name, adp) {
  const t = (label, cond, got) => ok('[' + name + '] ' + label, cond, got);

  t('空库 readSnapshot = null', adp.readSnapshot() === null, adp.readSnapshot());

  adp.writeSnapshot(null, {
    rev: 3,
    generated_at: '2026-01-01T00:00:00.000Z',
    data: { ings: [{ id: 'I1', name: '面粉' }] },
    ext: { recipes: [{ id: 'R1' }] }
  });
  const s1 = adp.readSnapshot();
  t('writeSnapshot 可读回（data/ext/rev）',
    !!s1 && s1.rev === 3 && s1.data.ings[0].id === 'I1'
    && Array.isArray(s1.ext.recipes) && s1.ext.recipes[0].id === 'R1', s1);

  const bad = adp.casWrite(null, 2, { data: { ings: [] } });
  t('casWrite 基准 rev 不符 → conflict 且带当前 rev',
    bad.ok === false && bad.conflict === true && bad.rev === 3, bad);
  t('conflict 不修改快照', adp.readSnapshot().rev === 3, adp.readSnapshot().rev);

  const good = adp.casWrite(null, 3, { data: { ings: [{ id: 'I2' }] }, ext: null });
  t('casWrite 基准 rev 相符 → rev+1', good.ok === true && good.rev === 4, good);
  const s2 = adp.readSnapshot();
  t('casWrite 落库生效', s2.rev === 4 && s2.data.ings[0].id === 'I2', s2);

  t('loadQueue 空返回 []', Array.isArray(adp.loadQueue()) && adp.loadQueue().length === 0);
  adp.enqueue({ id: 'a1', type: 't.x', status: '待执行', created_at: '2026-01-01T00:00:00.000Z' });
  adp.enqueue({ id: 'a2', type: 't.y', status: '待执行', created_at: '2026-01-01T00:00:01.000Z' });
  adp.enqueue({ id: 'a3', type: 't.z', status: 'queued', created_at: '2026-01-01T00:00:02.000Z' });
  t('enqueue 后 loadQueue = 3', adp.loadQueue().length === 3, adp.loadQueue().length);

  const c1 = adp.claim('w1', 1);
  t('claim 只取待执行并置执行中',
    c1.length === 1 && c1[0].status === '执行中'
    && c1[0].claimed_by === 'w1' && c1[0].attempts === 1, c1);
  const c2 = adp.claim('w2', 10);
  t('二次 claim 不重复取已认领（与上一次 id 不同）',
    c2.length === 1 && c2[0].id !== c1[0].id, c2.map((x) => x.id));
  const c3 = adp.claim('w3', 10);
  t('待执行取尽后 claim = []', c3.length === 0, c3);

  adp.ack(c1[0].id, { status: '已执行', executed_rev: 9 });
  const after = adp.loadQueue().find((x) => x.id === c1[0].id);
  t('ack 回写状态/结果/revision',
    !!after && after.status === '已执行' && after.executed_rev === 9 && !!after.updated_at, after);

  adp.appendAudit({ trace_id: 'tr1', decision: 'ok', rev: 4 });
  const au = adp.listAudit(10);
  t('appendAudit / listAudit 可回读',
    au.some((x) => x && x.trace_id === 'tr1'), au);

  adp.saveQueue([{ id: 'only', status: 'queued', created_at: '2026-01-01T00:00:00.000Z' }]);
  t('saveQueue 整体替换', adp.loadQueue().length === 1 && adp.loadQueue()[0].id === 'only', adp.loadQueue());
}

/* ---------------- worker 端到端 ---------------- */
async function runWorkerSuite(name, adp) {
  const t = (label, cond, got) => ok('[' + name + '] ' + label, cond, got);
  const registry = require('../algorithms/index');
  registry.register('test.noop', (ctx, data) => {
    data.pings = (data.pings || 0) + 1;
    return { ok: true, pings: data.pings };
  });

  adp.saveQueue([]);
  adp.writeSnapshot(null, { rev: 10, data: {}, ext: {} });
  adp.enqueue({
    id: 'wk_' + name,
    type: 'test.noop',
    payload: {},
    status: '待执行',
    created_at: new Date().toISOString(),
    attempts: 0
  });

  const { runOnce } = require('../worker');
  const results = await runOnce(adp, { workerId: 'wtest', limit: 5, maxAttempts: 3 });

  t('worker 处理 1 条且 outcome=executed',
    results.length === 1 && results[0].outcome === 'executed', results);
  const snap = adp.readSnapshot();
  t('worker 落库 rev 递增（10 → 11）', !!snap && snap.rev === 11, snap && snap.rev);
  t('算法副作用写入主存', !!snap && snap.data.pings === 1, snap && snap.data);
  const a = adp.loadQueue().find((x) => x.id === 'wk_' + name);
  t('动作置「已执行」via=worker、executed_rev=11',
    !!a && a.status === '已执行' && a.via === 'worker' && a.executed_rev === 11, a);
}

(async function main() {
  const jsonAdapter = createAdapter('json');
  const sqliteAdapter = createAdapter('sqlite', { dbPath: path.join(TMP, 'contract.db') });

  console.log('== StoreAdapter 契约测试 ==');
  runAdapterSuite('json', jsonAdapter);
  runAdapterSuite('sqlite', sqliteAdapter);
  await runWorkerSuite('json', jsonAdapter);
  await runWorkerSuite('sqlite', sqliteAdapter);

  try { jsonAdapter.close(); } catch (e) { /* ignore */ }
  try { sqliteAdapter.close(); } catch (e) { /* ignore */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  if (failed) {
    console.error('\n✗ ' + failed + ' 项失败');
    process.exit(1);
  }
  console.log('\n✓ store-adapter 契约测试全部通过（json + sqlite） PASS');
})();
