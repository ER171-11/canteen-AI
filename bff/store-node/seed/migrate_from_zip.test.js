'use strict';
/*
 * migrate_from_zip.test.js — 差分测试
 *   1) ZIP 解析平价：listEntries 数量、必要条目 sha256/长度 与 Python zipfile 一致；
 *   2) 纯函数平价：migrate_v4_from_zip / merge / summarize 喂同一 JSON，逐字段比对；
 *   3) 全量集成平价：对同一份临时 sqlite 跑 Python 原实现与 Node 移植，比较 docs.data。
 * 说明：zip 166MB，但只读 1.8MB 的「餐厅系统/data/餐厅系统.db」条目；
 *       zipread 复用另一并行任务创建的 seed/zipread.js（loads whole file）。
 * 用法：node bff/store-node/seed/migrate_from_zip.test.js
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { runPython: execPy } = require('../../lib/_python');
const { DatabaseSync } = require('node:sqlite');
const lib = require('./testlib');
const mig = require('./migrate_from_zip');
const zipread = require('./zipread');

const PY_SCRIPT = path.join(lib.REPO_ROOT, 'old', 'store-inventory-legacy', 'python-seed', 'migrate_from_zip.py');
const LEGACY_DB = path.join(lib.REPO_ROOT, 'old', 'store-inventory-legacy', 'python-runtime', 'db.py');

const PY_ZIP_INFO = `
import zipfile, hashlib, json, sys
z = zipfile.ZipFile(sys.argv[1])
b = z.read("餐厅系统/data/餐厅系统.db")
sys.stdout.write(json.dumps({"count": len(z.namelist()), "sha": hashlib.sha256(b).hexdigest(), "len": len(b)}))
`;

// 纯函数平价 harness：注入假 db 模块以便 import migrate_from_zip
const PY_PURE = `
import importlib.util, sys, types, json
fake = types.ModuleType("db")
class Store: pass
fake.Store = Store
sys.modules["db"] = fake
spec = importlib.util.spec_from_file_location("mig", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
p = json.loads(sys.stdin.read())
migrated = m.migrate_v4_from_zip(p["zipData"])
merged = m.merge(p["current"], migrated)
sys.stdout.write(json.dumps({"migrated": migrated, "merged": merged, "summary": m.summarize(merged)}, ensure_ascii=False))
`;

// 全量集成 harness：注入 legacy Store 为 db 模块
const PY_FULL = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("dbmod", sys.argv[1])
dbmod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dbmod)
sys.modules["db"] = dbmod
spec2 = importlib.util.spec_from_file_location("mig", sys.argv[2])
m = importlib.util.module_from_spec(spec2)
spec2.loader.exec_module(m)
sys.exit(m.main(["--zip", sys.argv[3], "--db", sys.argv[4]]))
`;

function loadRev(dbPath) {
  const conn = new DatabaseSync(dbPath);
  try {
    return conn.prepare('SELECT rev FROM docs WHERE id=1').get().rev;
  } finally {
    conn.close();
  }
}

function testZipParity() {
  const info = JSON.parse(execPy(PY_ZIP_INFO, { args: [lib.SRC_ZIP] }));
  const list = zipread.listEntries(lib.SRC_ZIP);
  assert.strictEqual(list.length, info.count, 'ZIP 条目数应与 Python 一致');
  const member = list.find((e) => e.name === mig.ZIP_DB_MEMBER);
  assert.ok(member, '应含 ' + mig.ZIP_DB_MEMBER);
  assert.strictEqual(member.uncompressedSize, info.len, 'DB 条目解压长度一致');
  const buf = zipread.openZip(lib.SRC_ZIP).read(mig.ZIP_DB_MEMBER);
  assert.strictEqual(buf.length, info.len);
  assert.strictEqual(crypto.createHash('sha256').update(buf).digest('hex'), info.sha, 'DB 条目 sha256 一致');
  console.log('  PASS ZIP 解析：' + list.length + ' 条目，DB 成员 sha256 一致');
}

function testPureParity() {
  const zipData = {
    seq: 260,
    v: 3,
    rest: [1, 2],
    ings: [
      { id: 'I1', name: '面粉', stock: 2, avg: 5 },
      { id: 'I2', name: '盐', stock: 0, avg: 3 },
    ],
    dishes: [{ id: 'D1', name: '饺' }],
    pos: [
      { id: 'P1', no: 'CG20260913-01', payable: 10 },
      { id: 'P2', no: 'JHX', payable: 5 },
      { id: 'P3', payable: 1 },
    ],
    sales: [{ dish: '饺', qty: 2 }],
    logs: [{ t: 1 }],
    quotes: [{ q: 1 }],
    suppliers: [{ s: 1 }],
    platforms: [{ p: 1 }],
    orders: [{ o: 1 }],
  };
  const current = {
    seq: 1,
    v: 4,
    ings: [{ id: 'OLD', name: '旧' }],
    rec: { D1: [] },
    sales: [],
    logs: [],
    quotes: [],
    platforms: [],
    suppliers: [],
    recv: [{ id: 'R', no: 'JH1' }],
    orders: [{ old: 1 }],
    plans: [{ p: 1 }],
    dishAlias: { 饺: { dish: 'D1', mul: 1 } },
    restock: { days: 30, lead: 1, gap: 1, useOnway: 1 },
    config: { x: 1 },
    _recU: { D1: 't' },
  };

  const p = lib.pyJson(PY_PURE, { zipData, current }, [PY_SCRIPT]);
  const migrated = mig.migrateV4FromZip(zipData);
  const merged = mig.merge(current, migrated);
  const summary = mig.summarize(merged);

  assert.deepStrictEqual(migrated, p.migrated, 'migrateV4FromZip 应一致');
  assert.deepStrictEqual(merged, p.merged, 'merge 应一致');
  assert.strictEqual(summary, p.summary, 'summarize 应一致');
  assert.deepStrictEqual(migrated.recv.map((r) => r.no), ['JH20260913-01', 'JHX', undefined]);
  assert.strictEqual(migrated.v, 4);
  assert.strictEqual(merged.pos.length, 0);
  assert.deepStrictEqual(merged.recv, migrated.recv, 'recv 应来自 zip');
  console.log('  PASS 纯函数：migrate/merge/summarize 与 Python 一致  [' + summary + ']');
}

function testFullIntegration() {
  const tmp = lib.tmpdir('migrate-test-');
  const pyDb = lib.copyDb(path.join(tmp, 'py', '餐厅系统.db'));
  const nodeDb = lib.copyDb(path.join(tmp, 'node', '餐厅系统.db'));
  const pyRev0 = loadRev(pyDb);
  const nodeRev0 = loadRev(nodeDb);

  execPy(PY_FULL, { args: [LEGACY_DB, PY_SCRIPT, lib.SRC_ZIP, pyDb] });
  mig.main(['--zip', lib.SRC_ZIP, '--db', nodeDb]);

  const p = lib.loadDocData(pyDb);
  const n = lib.loadDocData(nodeDb);
  assert.deepStrictEqual(n, p, '迁移后 docs.data 应一致');
  assert.strictEqual(loadRev(nodeDb), nodeRev0 + 1);
  assert.strictEqual(loadRev(pyDb), pyRev0 + 1);
  assert.ok((n.recv || []).length > 0 && (n.recv || []).every((r) => !String(r.no || '').startsWith('CG')), 'recv 单号应无 CG 前缀');
  assert.deepStrictEqual(n.pos, []);
  assert.strictEqual(n.v, 4);
  const nBak = fs.existsSync(path.join(path.dirname(nodeDb), 'backups'));
  const pBak = fs.existsSync(path.join(path.dirname(pyDb), 'backups'));
  assert.ok(nBak && pBak, '两侧均应冷备份');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('  PASS 全量集成：docs.data 一致 recv=' + (n.recv || []).length + ' ings=' + (n.ings || []).length);
}

function main() {
  // 纯函数差分（migrate/merge/summarize）不依赖任何夹具，任何环境都真实执行。
  testPureParity();
  if (lib.SRC_ZIP) {
    testZipParity();
    testFullIntegration();
  } else {
    // 夹具「餐厅系统.zip」约 166MB，不入 VCS（无 .gitignore 之外的获取渠道），CI 上结构性缺失。
    // 这里的 SKIP 是**显式声明**的：打印在输出里，且该测试其余部分（纯函数差分）已真实执行，
    // 不属于「静默跳过却判成功」——历史缺陷见 run-tests.js 头注释。
    console.log('  SKIP ZIP解析/全量集成：夹具 zip 不在 VCS（166MB），仅本机存在夹具时执行');
  }
  console.log('[migrate_from_zip.test] PASS' + (lib.SRC_ZIP ? '' : '（部分：zip 相关 2 个子测试 SKIP）'));
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('[migrate_from_zip.test] FAIL:', e && e.stack ? e.stack : e);
    process.exit(1);
  }
}
