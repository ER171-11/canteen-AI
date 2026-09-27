'use strict';
/*
 * seed_safety_runthrough.test.js — 差分测试
 * 用两份临时 sqlite（从真实库复制），分别跑 Python 原实现与 Node 移植的
 * sqlite 回退路径（店内 store 指向不可达端口），比较 docs.data（忽略 _u 时间戳）
 * 与 snapshot_rev。
 * 用法：node bff/store-node/seed/seed_safety_runthrough.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const lib = require('./testlib');
const node = require('./seed_safety_runthrough');

const PY_SCRIPT = path.join(lib.REPO_ROOT, 'old', 'store-inventory-legacy', 'python-seed', 'seed_safety_runthrough.py');

const PY_CODE = `
import importlib.util, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("safety", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.DB = Path(sys.argv[2])
m.STORE_URL = sys.argv[3] if len(sys.argv) > 3 else "http://127.0.0.1:1"
m.main()
`;

const NORM = { dropKeys: new Set(['_u']) };

function snapshotRev(dbPath) {
  const conn = new DatabaseSync(dbPath);
  try {
    const row = conn.prepare('SELECT rev FROM snapshot_rev').get();
    return row ? row.rev : null;
  } finally {
    conn.close();
  }
}

async function main() {
  const tmp = lib.tmpdir('safety-test-');
  const pyDb = lib.copyDb(path.join(tmp, 'py', '餐厅系统.db'));
  const nodeDb = lib.copyDb(path.join(tmp, 'node', '餐厅系统.db'));

  execFileSync('python3', ['-c', PY_CODE, PY_SCRIPT, pyDb], { encoding: 'utf8' });
  await node.main(['--db', nodeDb, '--store-url', 'http://127.0.0.1:1']);

  const n = lib.normalize(lib.loadDocData(nodeDb), NORM);
  const p = lib.normalize(lib.loadDocData(pyDb), NORM);
  try {
    assert.deepStrictEqual(n, p);
  } catch (e) {
    console.error('Node  :', JSON.stringify(n).slice(0, 1500));
    console.error('Python:', JSON.stringify(p).slice(0, 1500));
    throw e;
  }

  assert.strictEqual(snapshotRev(nodeDb), snapshotRev(pyDb), 'snapshot_rev 应一致');
  const hlg = (n.ings || []).find((i) => i.name === '火龙果汁');
  assert.ok(hlg, '应有火龙果汁');
  assert.strictEqual(Number(hlg.safe), 2, '火龙果汁安全线=2kg');
  const rev = snapshotRev(nodeDb);

  // 场景 2：店内 store 可达，走 /api/sync
  const pyDb2 = lib.copyDb(path.join(tmp, 'py2', '餐厅系统.db'));
  const nodeDb2 = lib.copyDb(path.join(tmp, 'node2', '餐厅系统.db'));
  const pyStore = await lib.startMockStore(pyDb2);
  const nodeStore = await lib.startMockStore(nodeDb2);
  let n2;
  try {
    await lib.runPython(['-c', PY_CODE, PY_SCRIPT, pyDb2, pyStore.url]);
    await node.main(['--db', nodeDb2, '--store-url', nodeStore.url]);
    n2 = lib.normalize(lib.loadDocData(nodeDb2), NORM);
    const p2 = lib.normalize(lib.loadDocData(pyDb2), NORM);
    assert.deepStrictEqual(n2, p2, 'store(/api/sync) 路径 docs.data 应一致');
  } finally {
    await pyStore.close();
    await nodeStore.close();
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(
    '[seed_safety_runthrough.test] PASS  sqlite ings=' + (n.ings || []).length + ' snapshot_rev=' + rev +
      ' | store ings=' + (n2.ings || []).length
  );
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[seed_safety_runthrough.test] FAIL:', e && e.stack ? e.stack : e);
    process.exit(1);
  });
}
