'use strict';
/*
 * lib/worker.js — 独立动作执行 worker（ADR-010 Phase 0 接缝层 / D2）
 *
 * 流程（与旧 store-node/consumer.js 的「执行体」一致，但不依赖店内 SQLite）：
 *   1) adapter.claim(workerId, limit)  原子认领「待执行」→「执行中」
 *   2) applyAction(adapter, action)    跑算法 + casWrite 落主存
 *   3) adapter.ack(id, patch)          按结果置 已执行 / 待执行（重试）/ 已驳回
 *
 * 与 refresh 的边界：
 *   - Phase 0 本地演练：STORE_ADAPTER=sqlite 起一个 worker，真事务真 CAS；
 *   - 生产（桌面 json）：仍由 BFF 进程内 CANTEEN_LOCAL_APPLY=1 直接执行，
 *     本 worker **不参与**（避免同一动作被 BFF 与 worker 双执行）。
 *
 * 命令行：
 *   node lib/worker.js --once
 *   node lib/worker.js --adapter=sqlite --db=./worker.db --interval=5
 *   node lib/worker.js --adapter=json --limit=20 --once
 */
const { applyAction } = require('./action-runner');
const provider = require('./provider');

const MAX_ATTEMPTS = 5;

function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

/** 处理一条已认领的动作，返回 {id, outcome, ...} */
async function handleOne(adapter, action, opts) {
  const o = opts || {};
  const now = () => new Date().toISOString();

  // 前厅动作：美团承接模式下不写库（与 consumer.js / BFF confirm 同口径）
  if (action.front_house && !provider.isSelf()) {
    adapter.ack(action.id, {
      status: '已驳回',
      error: 'pending_provider: 前厅动作在美团承接模式下不写库，置 FRONT_OF_HOUSE_PROVIDER=self 后启用',
      executed_at: now()
    });
    return { id: action.id, outcome: 'pending-provider' };
  }

  const res = await applyAction(adapter, action, o);

  if (res.outcome === 'executed') {
    adapter.ack(action.id, {
      status: '已执行',
      executed_rev: res.rev,
      via: 'worker',
      result: res.result == null ? null : res.result,
      error: null,
      executed_at: now()
    });
    return { id: action.id, outcome: 'executed', rev: res.rev };
  }

  // 终态失败：不重试，显式驳回（红线「不静默降级」）
  if (res.outcome === 'need-manual' || res.outcome === 'rejected') {
    adapter.ack(action.id, {
      status: '已驳回',
      error: res.error || res.outcome,
      executed_at: now()
    });
    return { id: action.id, outcome: 'rejected', error: res.error };
  }

  // 可重试：no-snapshot / conflict（他人已改 rev，重取新快照再算）
  const attempts = Number(action.attempts) || 1;
  const max = (o.maxAttempts != null) ? o.maxAttempts : MAX_ATTEMPTS;
  const reason = res.error || res.outcome;
  if (attempts >= max) {
    adapter.ack(action.id, {
      status: '已驳回',
      error: reason + '（重试 ' + attempts + ' 次后放弃）',
      executed_at: now()
    });
    return { id: action.id, outcome: 'rejected', error: res.outcome };
  }
  adapter.ack(action.id, {
    status: '待执行',
    error: reason + '（待重试 ' + attempts + '/' + max + '）',
    claimed_by: null,
    claimed_at: null
  });
  return { id: action.id, outcome: 'retry', error: res.outcome };
}

/** 跑一轮：认领 + 逐条执行 */
async function runOnce(adapter, opts) {
  const o = opts || {};
  const workerId = o.workerId || ('worker-' + process.pid);
  const limit = o.limit || 10;
  const claimed = adapter.claim(workerId, limit);
  const results = [];
  for (const action of claimed) {
    results.push(await handleOne(adapter, clone(action), o));
  }
  return results;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(argv) {
  const { parseArgs } = require('node:util');
  let values;
  try {
    values = parseArgs({
      args: argv || process.argv.slice(2),
      options: {
        adapter: { type: 'string' },
        db: { type: 'string' },
        interval: { type: 'string' },
        limit: { type: 'string' },
        once: { type: 'boolean' },
        help: { type: 'boolean' }
      },
      allowPositionals: true
    }).values;
  } catch (e) {
    console.error('参数解析失败: ' + e.message);
    return 2;
  }
  if (values.help) {
    console.log('用法: node lib/worker.js [--adapter=json|sqlite] [--db PATH]'
      + ' [--interval 秒] [--limit N] [--once]');
    return 0;
  }

  const { createAdapter } = require('./store-adapter');
  const kind = values.adapter || process.env.STORE_ADAPTER || 'json';
  const interval = values.interval !== undefined ? Number(values.interval) : 5;
  const limit = values.limit !== undefined ? Number(values.limit) : 10;
  let adapter;
  try {
    adapter = createAdapter(kind, { dbPath: values.db });
  } catch (e) {
    console.error('[worker] 适配器创建失败: ' + ((e && e.message) || e));
    return 1;
  }

  console.log('[worker] 启动 adapter=' + kind + ' interval=' + interval + 's limit=' + limit
    + ' once=' + Boolean(values.once) + (values.db ? ' db=' + values.db : ''));

  if (values.once) {
    const r = await runOnce(adapter, { limit });
    console.log('[worker] 本轮结果 ' + JSON.stringify(r));
    if (adapter.close) adapter.close();
    return 0;
  }

  for (;;) {
    try {
      const r = await runOnce(adapter, { limit });
      if (r.length) console.log('[worker] 本轮处理 ' + r.length + ' 条: ' + JSON.stringify(r));
    } catch (e) {
      console.error('[worker] 本轮异常（继续循环）: ' + ((e && e.stack) || e));
    }
    await sleep(interval * 1000);
  }
}

module.exports = { runOnce, handleOne, MAX_ATTEMPTS };

if (require.main === module) {
  Promise.resolve(main()).then((code) => { process.exitCode = code || 0; });
}
