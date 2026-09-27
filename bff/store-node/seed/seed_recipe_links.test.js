'use strict';
/*
 * seed_recipe_links.test.js — 差分测试（最重）
 * 用两份临时 sqlite（从真实库复制）各起一个 mock 店内服务，
 * 分别跑 Python 原实现与 Node 移植，比较写库后的 docs.data
 * （归一化 _u / genAt / BYseed id / _recU 时间戳）。
 *
 * 场景：
 *   1) 原库原样（已有 pending 补货单 → 跳过生成、sales 已带 lines）
 *   2) 清空 plans 与 sales.lines（强制走 补货单生成 + sales 补 lines + ings.est 回填 分支）
 * 用法：node bff/store-node/seed/seed_recipe_links.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const lib = require('./testlib');
const node = require('./seed_recipe_links');

const PY_SCRIPT = path.join(lib.REPO_ROOT, 'old', 'store-inventory-legacy', 'python-seed', 'seed_recipe_links.py');

/** 修改复制库 docs.data（保留 rev 等其他列）。 */
function mutateDocs(dbPath, fn) {
  const conn = new DatabaseSync(dbPath);
  try {
    const row = conn.prepare('SELECT data FROM docs WHERE id=1').get();
    const d = JSON.parse(row.data);
    fn(d);
    conn.prepare('UPDATE docs SET data=? WHERE id=1').run(JSON.stringify(d));
  } finally {
    conn.close();
  }
}

async function runScenario(label, prepare) {
  const tmp = lib.tmpdir('recipe-test-');
  const pyDb = lib.copyDb(path.join(tmp, 'py', '餐厅系统.db'));
  const nodeDb = lib.copyDb(path.join(tmp, 'node', '餐厅系统.db'));
  if (prepare) {
    mutateDocs(pyDb, prepare);
    mutateDocs(nodeDb, prepare);
  }

  const pyStore = await lib.startMockStore(pyDb);
  const nodeStore = await lib.startMockStore(nodeDb);
  let n;
  try {
    try {
      await lib.runPython([PY_SCRIPT, '--db', pyDb, '--store-url', pyStore.url]);
    } catch (e) {
      const pyOut = String((e && e.stdout) || '') + String((e && e.stderr) || '');
      throw new Error('Python seed_recipe_links 退出非 0：\n' + pyOut.slice(-2000));
    }
    await node.main(['--db', nodeDb, '--store-url', nodeStore.url]);

    const opts = { dropKeys: new Set(['_u']), placeholderKeys: new Set(['genAt']) };
    n = lib.normalize(lib.loadDocData(nodeDb), opts);
    const p = lib.normalize(lib.loadDocData(pyDb), opts);
    try {
      assert.deepStrictEqual(n, p);
    } catch (e) {
      for (const k of Object.keys(n)) {
        try {
          assert.deepStrictEqual(n[k], p[k]);
        } catch (e2) {
          console.error('[' + label + '] 首个不一致字段: ' + k);
          console.error('Node  :', JSON.stringify(n[k]).slice(0, 1200));
          console.error('Python:', JSON.stringify(p[k]).slice(0, 1200));
          break;
        }
      }
      throw e;
    }
  } finally {
    await pyStore.close();
    await nodeStore.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 关键断言
  assert.ok(Object.keys(n.rec || {}).length > 0, 'DB.rec 菜品数 >0');
  assert.ok(Object.keys((n.config || {}).ing_alias || {}).length > 0, 'ing_alias >0');
  assert.ok(Object.keys(n.dishAlias || {}).length >= 5, 'dishAlias ≥5');
  const priced = (n.dishes || []).filter(
    (d) => String(d.id || '').startsWith('SKU-WF-') && Number(d.price) > 0
  ).length;
  assert.strictEqual(priced, 9, 'SKU-WF-* price>0 应为 9');
  return n;
}

async function main() {
  const n1 = await runScenario('原样', null);
  console.log(
    '[seed_recipe_links.test] PASS(原样)  rec=' + Object.keys(n1.rec || {}).length +
      ' alias=' + Object.keys((n1.config || {}).ing_alias || {}).length +
      ' dishAlias=' + Object.keys(n1.dishAlias || {}).length +
      ' salesLines=' + (n1.sales || []).filter((s) => s.lines).length +
      ' pendingPlans=' + (n1.plans || []).filter((p) => p.status === 'pending').length
  );

  const n2 = await runScenario('空 plans+lines', (d) => {
    d.plans = [];
    for (const s of d.sales || []) delete s.lines;
  });
  const pending2 = (n2.plans || []).filter((p) => p.status === 'pending');
  assert.strictEqual(pending2.length, 1, '应生成 1 张 pending 补货单');
  assert.ok(pending2[0].lines.length > 0, '补货单应有明细');
  assert.ok((n2.sales || []).some((s) => s.lines), 'sales 应补出 lines');
  console.log(
    '[seed_recipe_links.test] PASS(空 plans+lines)  planLines=' + pending2[0].lines.length +
      ' salesLines=' + (n2.sales || []).filter((s) => s.lines).length
  );

  console.log('[seed_recipe_links.test] PASS');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[seed_recipe_links.test] FAIL:', e && e.stack ? e.stack : e);
    process.exit(1);
  });
}
