# 食安点位统筹 — 跨对话实现规格文档

> 本文档用于「跨对话/跨 Agent」接续实现。**无需重新通读整个仓库**即可照此落地。
> 所有改造遵循既有架构与红线，最小化改动面，保证历史台账与空态兼容。

> **实现状态（2026-10-10）：后端与前端改造均已落地，测试与构建全绿；本文件转为「实现说明 + 回归清单」。**
> 相对下方规格的补充：
> - 新增 `safety_point.seed` 算法与 `POST /api/safety/points/seed`——把内置默认点位一次性导入为可编辑点位（幂等、一次审批），
>   使「首次预置默认、后续可增删改」闭环可用（`resolvePoints` 仍保持「自定义优先、空态回退默认」语义）。
> - 新增单测 `bff/lib/algorithms/safety_point.test.js`（8 组）与 `points_rewire.test.js`（4 组）；`bff/routes/run-tests.js` 增加 `testSafetyPointsRoute`（20 条）。
> - 验证命令：`node bff/lib/algorithms/run-tests.js`（17/17）、`node bff/routes/run-tests.js`、`node bff/store-node/run-tests.js`（4/4）、
>   `node bff/lib/foodsafety.test.js`、`node bff/lib/price.test.js`、`node scripts/lint-zero-dep.js`，前端 `npm --prefix apps/admin-web run build`。

---

## 0. 目标与背景

将现有「食安设备」下的**巡检统筹**与**消毒记录**两个独立页面合并为一个**食安点位统筹**页面（页内 `Tabs` 切换两个视图），并引入一套**可维护的食安点位主数据**，解决现有区域划分不真实的问题。

核心：
- 新增统一点位主数据 `fs_points`，按 `kind` 区分 `inspection`（巡检点）/ `disinfect`（消毒点），作为巡检与消毒统计的**唯一事实来源**。
- 巡检看板（板块完成率、漏项、30 分钟轮次缺口）与消毒达标率（应做区域、今日完成、趋势）改为**读取可配置点位**，替代后端硬编码与历史记录反推。
- 每个点位可上传一张**规范演示图**（管理端配置，走对象存储预签名直传，符合「图片不经过 BFF、不落盘、不入库」红线）。
- 写操作（点位增删改）统一进入审批中心队列，确认后落库。

### 红线（务必遵守）
- 红线②：所有写操作一律 `enqueue` 进 `actions` 队列，BFF 不直接写店内 DB。
- 图片红线：`qc_media.js` / `objstore.js` 严禁 base64 过 BFF，只签发预签名 URL；**图片本体不落盘、不入库**，数据库只存 `photo_key` / `photo_url` 引用。
- 演示图 vs 现场照片区分：**现场巡检照片仍只存手机本地**（见 `algorithms/inspection.js`），**演示图是管理端配置主数据**，走 OSS 直传。两者字段不可混淆。
- 巡检记录 `inspection_records` 仍**不含任何图片列**（历史契约不变）。

---

## 1. 架构与数据流

```
admin-web 食安点位统筹页
   │  GET  /api/safety/points?kind=           读取点位列表（聚合层 resolvePoints）
   │  POST /api/safety/points                 增/改点位 → enqueue('safety_point.upsert')
   │  POST /api/safety/points/remove          删除点位 → enqueue('safety_point.remove')
   │  POST /api/safety/points/presign         演示图上传预签名（PUT 直传）
   │  POST /api/safety/points/sign            读图预签名（私有 bucket）
   ▼
BFF routes/safety_points.js
   │  读 → snapshot.ext.fs_points
   │  写 → actions 队列 → 审批确认 → executeAction
   ▼
BFF lib/algorithms/safety_point.js   (safety_point.upsert / safety_point.remove)
   │  ctx.store.upsert('fs_points', row, ['id']) / ctx.store.update('fs_points', {enabled:0}, {...})
   ▼
snapshot.ext.fs_points  ←→  店内 SQLite fs_points 表（迁移 005）

聚合消费方（读取点位）：
   lib/inspection_board.js  buildBoard        → resolvePoints(ext,'inspection')
   lib/foodsafety.js        disinfectReport   → resolvePoints(ext,'disinfect')
   lib/algorithms/inspection.js recordInspection → pointById(ext,'inspection',id)（默认兜底 nodes.byId）
```

### 点位行结构（ext.fs_points 元素 / SQLite 表同构）
```js
{
  id: 'K01',                       // 稳定标识；巡检沿用 K01..K50，消毒 D01..D05；自定义可任意唯一串
  name: '外门锁闭',                // 点位名
  zone: '后厨',                    // 巡检=板块(后厨/前厅/仓库)；消毒=区域分组
  kind: 'inspection',              // 'inspection' | 'disinfect'
  every30: 0,                      // 1=需每30分钟记录（仅巡检卫生间类）
  demo_image_key: null,            // 演示图对象键（OSS）
  demo_image_url: null,            // 演示图访问地址（OSS_PUBLIC_BASE 配置时）
  enabled: 1,                      // 1=启用；0=逻辑删除（保留历史台账引用）
  sort: 0,                         // 排序权重，升序
  note: null,
  ts: null                         // 最近更新时刻 ISO
}
```

---

## 2. 后端实现清单（todo: backend-points-module）

### 2.1 新增 `bff/lib/safety_points.js`（点位纯函数主数据）

纯函数，无 IO。内置默认点位 + `resolvePoints` 兜底逻辑。

```js
'use strict';
// 内置默认巡检点：直接复用 inspection_nodes 的 50 节点（id/name/board/every30）
const nodes = require('./inspection_nodes');

const DISINFECT_DEFAULTS = [
  { id: 'D01', name: '前厅公共区域', zone: '前厅', every30: 0 },
  { id: 'D02', name: '后厨操作间',   zone: '后厨', every30: 0 },
  { id: 'D03', name: '餐具洗消间',   zone: '洗消', every30: 0 },
  { id: 'D04', name: '仓库存储区',   zone: '仓库', every30: 0 },
  { id: 'D05', name: '卫生间',       zone: '前厅', every30: 0 }
];

function arr(v){ return Array.isArray(v)?v:[]; }
function toPoint(n, kind){
  return {
    id: n.id, name: n.name, zone: n.board || n.zone || '', kind,
    every30: n.every30 === true ? 1 : (n.every30 ? 1 : 0),
    demo_image_key: null, demo_image_url: null, enabled: 1, sort: 0, note: null, ts: null
  };
}

function defaultPoints(kind){
  if (kind === 'disinfect') return DISINFECT_DEFAULTS.map((d)=>toPoint(d,'disinfect'));
  // 巡检默认：内置 50 节点（兼容 inspection_records.node_id）
  return nodes.all().map((n)=>toPoint(n,'inspection'));
}

// 优先 ext.fs_points（enabled=1 且 kind 匹配，按 sort 升序）；
// 该 kind 无有效点位时回退 defaultPoints(kind)
function resolvePoints(ext, kind){
  const rows = arr(ext && ext.fs_points)
    .filter((p)=> p && p.kind === kind && p.enabled !== 0);
  if (!rows.length) return defaultPoints(kind);
  return rows.slice().sort((a,b)=> (a.sort||0) - (b.sort||0));
}

function pointById(ext, kind, id){
  const s = String(id == null ? '' : id).trim();
  const hit = arr(ext && ext.fs_points).find((p)=> p && p.kind === kind && p.enabled !== 0 && String(p.id) === s);
  if (hit) return hit;
  // 默认兜底
  return defaultPoints(kind).find((p)=> String(p.id) === s) || null;
}

module.exports = { defaultPoints, resolvePoints, pointById, DISINFECT_DEFAULTS, KINDS: ['inspection','disinfect'] };
```

### 2.2 新增 `bff/lib/algorithms/safety_point.js`（点位写算法）

算法约定（全项目统一）：`handler(ctx, data, payload) → msg 字符串`；抛错 = 动作被驳回。

```js
'use strict';
const { pointById } = require('../safety_points');

function normInt(v, d){ const n = parseInt(v,10); return isFinite(n)?n:(d==null?0:d); }

// safety_point.upsert：按 id 幂等新增/更新
function upsertSafetyPoint(ctx, data, payload){
  const p = payload || {};
  const kind = String(p.kind || '').trim();
  if (kind !== 'inspection' && kind !== 'disinfect') throw new Error('safety_point kind 必填(inspection|disinfect)');
  const name = String(p.name || '').trim();
  if (!name) throw new Error('safety_point name 必填');

  const row = {
    id: p.id != null ? String(p.id).trim() : null, // 为空由 store 补自增（见 execute.makeExtStore）
    name,
    zone: String(p.zone || '').trim(),
    kind,
    every30: p.every30 ? 1 : 0,
    demo_image_key: p.demo_image_key != null ? p.demo_image_key : null,
    demo_image_url: p.demo_image_url != null ? p.demo_image_url : null,
    enabled: 1,
    sort: normInt(p.sort, 0),
    note: p.note != null ? String(p.note) : null,
    ts: new Date().toISOString()
  };
  const rid = ctx.store.upsert('fs_points', row, ['id']);
  return 'fs_points upsert rowid=' + (rid == null ? '-' : rid.rowid);
}

// safety_point.remove：enabled=0 逻辑删除（保留历史台账引用，不断 node_id）
function removeSafetyPoint(ctx, data, payload){
  const p = payload || {};
  const id = String(p.id == null ? '' : p.id).trim();
  const kind = String(p.kind || '').trim();
  if (!id || (kind !== 'inspection' && kind !== 'disinfect')) throw new Error('safety_point remove 需 id+kind');
  // 默认内置点位不存在于 ext，无法删除（符合「默认兜底不预置写库」约束）
  const n = ctx.store.update('fs_points', { enabled: 0, ts: new Date().toISOString() }, { id, kind });
  if (!n || n.count === 0) throw new Error('未找到可删除的自定义点位: ' + id);
  return 'fs_points disabled id=' + id;
}

module.exports = { upsertSafetyPoint, removeSafetyPoint };
```

> 注意：`execute.js` 的 `makeExtStore` 提供 `ctx.store.upsert(table,row,keys)`（默认 keys=['id']）与 `update(table,patch,where)`。`upsert` 在缺 `id` 时会补递增 id；此处自定义点位建议由前端生成稳定 id（如 `U<时间戳>`）传入，避免 ext 内 id 漂移。

### 2.3 修改 `bff/lib/algorithms/registry.js`

在 `registerAll` 区块（参考现有 `inspection` 区块）新增：

```js
const safetyPoint = require('./safety_point');
registerAll({
  'safety_point.upsert': (ctx, data, payload) => safetyPoint.upsertSafetyPoint(ctx, data, payload),
  'safety_point.remove': (ctx, data, payload) => safetyPoint.removeSafetyPoint(ctx, data, payload)
});
```
并在文件顶部 `require` 列表与 `module.exports` 中导出 `safetyPoint`（与 `inspection` 一致）。

### 2.4 修改 `bff/lib/objstore.js`（演示图对象键）

仿 `buildQcKey`（第 143 行）新增：

```js
// 生成点位演示图对象键：points/{store}/{date}/{kind}-{id}-{stamp}-{rand}.{ext}
function buildPointDemoKey(opt){
  const o = opt || {};
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(o.date || '')) ? String(o.date) : new Date().toISOString().slice(0,10);
  const kind = safeSeg(o.kind === undefined || o.kind === null ? 'na' : o.kind);
  const id   = safeSeg(o.id === undefined || o.id === null ? 'na' : o.id);
  const stamp = safeSeg(o.stamp === undefined || o.stamp === null ? Date.now() : o.stamp);
  const rand = crypto.randomBytes(3).toString('hex');
  return ['points', safeSeg(o.store_id || o.storeId || 'default'), date, kind + '-' + id + '-' + stamp + '-' + rand + '.' + safeExt(o.ext)].join('/');
}
```
在 `module.exports` 中加入 `buildPointDemoKey`。

### 2.5 新增 `bff/routes/safety_points.js`（读写路由）

参考 `routes/foodsafe.js` 的权限闸门与 `routes/actions.js` 的 `enqueue` 签名（`enqueue(type,payload,operator,traceId,meta)`）。复用 `qc_media.js` 的 `hasImagePayload` 守卫（夹带 base64 一律 400）。

```js
'use strict';
const store = require('../lib/store');
const { enqueue } = require('./actions');
const { mayWriteActions } = require('../lib/auth');
const { loadSnapshot } = require('./snapshot');
const { resolvePoints } = require('../lib/safety_points');
const objstore = require('../lib/objstore');
const { hasImagePayload } = require('./qc_media'); // 复用图片载荷守卫

function arr(v){ return Array.isArray(v)?v:[]; }
function q1(url,k){ const v = url && url.get ? url.get(k) : null; return v==null?null:String(v); }

function handle(req, res, ctx, pathname){
  if (pathname.indexOf('/api/safety/points') !== 0) return false;

  /* 只读 */
  if (req.method === 'GET'){
    if (pathname === '/api/safety/points'){
      const kind = q1(ctx.query, 'kind') || 'inspection';
      if (kind !== 'inspection' && kind !== 'disinfect'){ ctx.sendJSON(res,400,{ok:false,error:'kind 非法'}); return true; }
      const snap = loadSnapshot();
      const points = resolvePoints((snap && snap.ext) || {}, kind).map((p)=>({
        id:p.id, name:p.name, zone:p.zone, kind:p.kind, every30:p.every30,
        demo_image_key:p.demo_image_key, demo_image_url:p.demo_image_url, enabled:p.enabled, sort:p.sort, note:p.note
      }));
      ctx.sendJSON(res,200,{ ok:true, kind, points, rev: snap?snap.rev:null,
        configured: objstore.configured() });
      return true;
    }
    return false;
  }

  if (req.method !== 'POST') return false;

  /* 写操作统一权限闸门 */
  const WRITE = ['/api/safety/points','/api/safety/points/remove',
    '/api/safety/points/presign','/api/safety/points/sign'];
  if (WRITE.indexOf(pathname) >= 0 && (!ctx.auth || !mayWriteActions(ctx.auth))){
    ctx.sendJSON(res,403,{ok:false,error:'forbidden: actions.write required'}); return true;
  }

  (async ()=>{
    const body = await (async()=>{ try{ const {buf}=await ctx.readBody(req); return JSON.parse(buf.toString('utf8')); }catch(e){ return {}; } })();
    const snap = loadSnapshot();
    const rev = snap ? snap.rev : null;
    const operator = body.operator || (ctx.auth && (ctx.auth.account||ctx.auth.role)) || null;

    /* 演示图预签名（PUT 直传）；不接收任何图片体 */
    if (pathname === '/api/safety/points/presign'){
      const key = objstore.buildPointDemoKey({ kind:body.kind, id:body.id, store_id:body.store_id, ext:body.ext||'jpg' });
      const r = objstore.presignPut(key, { contentType: body.content_type || 'image/jpeg' });
      if (!r) { ctx.sendJSON(res,200,{ ok:true, configured:false, key:null, upload_url:null,
        note:'对象存储未配置（OSS_* 环境变量缺失），演示图不可用' }); return; }
      ctx.sendJSON(res,200,{ ok:true, configured:true, key:r.key, method:'PUT', upload_url:r.url,
        headers:r.headers, expires_in:r.expires_in, photo_url: objstore.publicUrl(r.key) });
      return;
    }

    /* 读图预签名（私有 bucket） */
    if (pathname === '/api/safety/points/sign'){
      const keys = Array.isArray(body.keys) ? body.keys : [];
      const items = keys.map((k)=>({ key:k, url: objstore.presignGet(k) ? objstore.presignGet(k).url : null,
        public_url: objstore.publicUrl(k) }));
      ctx.sendJSON(res,200,{ ok:true, items });
      return;
    }

    /* 增/改点位：夹带图片载荷直接驳回 */
    if (pathname === '/api/safety/points'){
      if (hasImagePayload(body)){ ctx.sendJSON(res,400,{ok:false,error:'图片禁止过 BFF，请先 presign 直传'}); return; }
      const id = enqueue('safety_point.upsert', {
        id: body.id, name: body.name, zone: body.zone, kind: body.kind,
        every30: body.every30, demo_image_key: body.demo_image_key,
        demo_image_url: body.demo_image_url, sort: body.sort, note: body.note
      }, operator, ctx.traceId, {}).action.id;
      ctx.sendJSON(res,200,{ ok:true, action_id:id, rev, note:'点位变更已入队 → 审批中心确认' });
      return;
    }

    /* 删除（逻辑删除） */
    if (pathname === '/api/safety/points/remove'){
      if (!body.id || !body.kind){ ctx.sendJSON(res,400,{ok:false,error:'id 与 kind 必填'}); return; }
      const id = enqueue('safety_point.remove', { id: body.id, kind: body.kind }, operator, ctx.traceId, {}).action.id;
      ctx.sendJSON(res,200,{ ok:true, action_id:id, rev, note:'点位删除已入队 → 审批中心确认' });
      return;
    }

    ctx.sendJSON(res,404,{ ok:false, error:'not found' });
  })();
  return true;
}
module.exports = { handle };
```

### 2.6 修改 `bff/server.js`

在 `ROUTES` 数组（第 58–90 行）末尾追加一项（放在 `sop_media` 之后即可）：

```js
require('./routes/safety_points')
```

### 2.7 新增迁移 `store-inventory/migrations/005_safety_points.sql`

仿 `004_inspection.sql` 风格（CREATE ... IF NOT EXISTS + 索引，可重复执行）：

```sql
-- =============================================================
-- 食安点位主数据（巡检点 / 消毒点 统一事实来源）
-- kind: inspection | disinfect；enabled=0 为逻辑删除（保留历史台账）
-- 演示图只存对象键引用，图片本体在对象存储，不落库。
-- =============================================================

CREATE TABLE IF NOT EXISTS fs_points (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  zone            TEXT,
  kind            TEXT NOT NULL,          -- inspection | disinfect
  every30         INTEGER DEFAULT 0,      -- 1=需每30分钟记录
  demo_image_key  TEXT,                   -- OSS 对象键（演示图）
  demo_image_url  TEXT,                   -- 公开读地址（OSS_PUBLIC_BASE 配置时）
  enabled         INTEGER DEFAULT 1,      -- 0=逻辑删除
  sort            INTEGER DEFAULT 0,
  note            TEXT,
  ts              TEXT
);

CREATE INDEX IF NOT EXISTS idx_fs_points_kind ON fs_points(kind);
CREATE INDEX IF NOT EXISTS idx_fs_points_enabled ON fs_points(enabled);
```

---

## 3. 数据源改造（todo: backend-board-rewire）

> 仅改解析层，不重构聚合口径与前端业务视图结构；保留「无快照/无点位」空态与默认兜底。

### 3.1 `bff/lib/inspection_board.js` — `buildBoard`

现状（第 11、69–119 行）：用 `nodes.BOARDS` 固定板块、`nodes.NODES` 固定节点列表。

改造：
1. 顶部新增 `const sp = require('./safety_points');`
2. `buildBoard(ext, opt)` 开头计算：
   ```js
   const points = sp.resolvePoints(ext, 'inspection').map((p)=>({
     id: p.id, name: p.name, board: p.zone, node_group: p.zone, every30: p.every30 === 1
   }));
   ```
3. **板块集合动态生成**：将 `nodes.BOARDS.forEach(...)` 初始化改为基于 `uniq(points.map(p=>p.board))`：
   ```js
   const boardKeys = Array.from(new Set(points.map((p)=>p.board)));
   const boardOf = {};
   boardKeys.forEach((b)=>{ boardOf[b] = {...默认结构...}; });
   ```
4. 遍历节点：`nodes.NODES.forEach((n)=>{...})` 改为 `points.forEach((n)=>{...})`（`n` 字段已映射为 `{id,name,board,node_group,every30}`）。
5. `summary.total = nodes.NODES.length` → `summary.total = points.length`。
6. `nodes.all()` / `nodes.groups()` 输出兼容：返回 `points` 映射数组；`groups()` 返回 `boardKeys`。
7. 保留 `nodes.byId` 仅用于 `inspection.js` 算法校验兜底（见 3.3），`buildBoard` 不再依赖 `nodes` 的节点/板块常量。

> 注意：`node_group` 在新点位结构中不存在，用 `zone` 兜底即可（`inspection_records` 的 `node_group` 列由算法层在登记时按节点补，见 3.3）。

### 3.2 `bff/lib/foodsafety.js` — `disinfectReport`

现状（第 282 行）：`const areas = uniq(all.map((r) => str(r && r.area) || '未分区'));`
改为优先点位：
```js
const sp = require('./safety_points'); // 顶部新增
// 在 disinfectReport 内替换 areas 计算：
const pointAreas = sp.resolvePoints(ext, 'disinfect').map((p)=> str(p.name) || '未分区');
const areas = pointAreas.length ? uniq(pointAreas) : uniq(all.map((r)=> str(r && r.area) || '未分区'));
```
含义：有配置点位时用点位 name 作为应做区域；无点位（空态/历史环境）回退历史 `fs_disinfect.area` 去重，保持兼容。

### 3.3 `bff/lib/algorithms/inspection.js` — `recordInspection` 节点校验

现状（第 101 行）：`const node = nodes.byId(p.node_id);`
改为**优先点位、默认兜底内置节点**（算法 handler 签名 `(ctx,data,payload)`，`ctx.store.query('fs_points')` 可读 ext 点位）：
```js
const sp = require('../safety_points');
// 在 recordInspection 内：
let node = null;
const extPts = (ctx.store && ctx.store.query) ? ctx.store.query('fs_points') : [];
const pt = extPts.find((x)=> x && x.kind === 'inspection' && x.enabled !== 0 && String(x.id) === String(p.node_id));
if (pt) node = { id: pt.id, name: pt.name, board: pt.zone, node_group: pt.zone, every30: pt.every30 === 1 };
if (!node) node = nodes.byId(p.node_id); // 默认兜底（内置50）
if (!node) throw new Error('未知巡检节点: ' + String(p.node_id === undefined ? '' : p.node_id));
```
> 当直接单测 `registry.run` 未注入 `ctx.store` 时，`ctx.store` 可能为空，需防御（`ctx.store && ctx.store.query`）。`nodes.byId` 兜底保证历史/空态仍可用。

---

## 4. 前端实现（todo: frontend-api-page / frontend-route-menu）

技术栈：React + TypeScript + antd（沿用 admin-web），Tailwind 可选。演示图上传用 antd `Upload` `customRequest` 先 `presign` 拿 `upload_url` 再 `PUT` 直传。

### 4.1 `apps/admin-web/src/api/types.ts` 新增类型
```ts
export type SafetyPointKind = 'inspection' | 'disinfect';
export interface SafetyPoint {
  id: string; name: string; zone: string; kind: SafetyPointKind;
  every30: number; demo_image_key: string | null; demo_image_url: string | null;
  enabled: number; sort: number; note: string | null;
}
export interface SafetyPointsResp { ok: boolean; kind: SafetyPointKind; points: SafetyPoint[]; rev: number | null; configured: boolean; }
export interface SafetyPointEnqueueResp { ok: boolean; action_id: string; rev: number | null; note?: string; }
export interface PresignResp { ok: boolean; configured: boolean; key: string | null; method: 'PUT'; upload_url: string | null; headers: Record<string,string>; expires_in: number; photo_url: string | null; note?: string; }
export interface SignResp { ok: boolean; items: { key: string; url: string | null; public_url: string | null }[]; }
```

### 4.2 `apps/admin-web/src/api/index.ts` 新增请求函数
- `fetchSafetyPoints(kind)` → `GET /api/safety/points?kind=`
- `upsertSafetyPoint(body)` → `POST /api/safety/points`
- `removeSafetyPoint(id, kind)` → `POST /api/safety/points/remove`
- `presignSafetyPointDemo({kind,id,store_id,ext})` → `POST /api/safety/points/presign`
- `signSafetyPointImages(keys)` → `POST /api/safety/points/sign`

### 4.3 `apps/admin-web/src/pages/safety/SafetyPointsPage.tsx`（NEW，合并页）
- 顶部 antd `Tabs`：`巡检统筹` / `消毒记录`。
- 每个 Tab 自上而下：统计卡片行（完成率/漏项/达标率等，复用现有 `InspectionBoardPage` / `DisinfectPage` 的聚合数据）→ `点位清单` 卡片（Table 展示点位；缩略图列预览 `demo_image_url` 或经 `sign` 拿私有读图 URL；操作列含 编辑/删除/上传演示图 按钮）→ 业务明细视图（板块完成度与漏项 / 每日达标率趋势与今日区域明细）。
- 点位编辑：Modal 表单（name/zone/kind/every30/sort/note），提交调 `upsertSafetyPoint`。
- 演示图上传：antd `Upload` `customRequest` → `presignSafetyPointDemo` → `PUT upload_url` 直传 → 回填 `demo_image_key`/`demo_image_url` 后 `upsertSafetyPoint` 提交。
- 对象存储未配置（`configured=false`）时展示「图片不可用」降级提示（不报错）。
- 视觉：沿用五福色系（主色 `#5BA85B`/`#4A9350`）、卡片分层、Tag，保持后台风格。

### 4.4 子组件化
- `InspectionBoardPage.tsx`、`DisinfectPage.tsx` 改造为被 `SafetyPointsPage` 内嵌的子组件（数据源已改为点位，无需改其聚合逻辑，仅调整入口/标题）。

### 4.5 路由与菜单
- `config/menu.tsx`：合并原「巡检统筹」「消毒记录」两个菜单项为单一「食安点位统筹」，更新 `ROUTE_MAP` 深链。
- `App.tsx`：移除 `/safety/disinfect`、`/safety/inspection`，新增 `/safety/points` → `SafetyPointsPage`。

---

## 5. 实现顺序与检查清单

| 步骤 | 文件 | 类型 | 验证点 |
|---|---|---|---|
| 1 | `lib/safety_points.js` | 新增 | `resolvePoints` 空态回退默认 50/5；`pointById` 默认兜底 |
| 2 | `lib/algorithms/safety_point.js` | 新增 | upsert/remove 抛错条件正确 |
| 3 | `lib/algorithms/registry.js` | 改 | 注册 `safety_point.upsert` / `.remove` |
| 4 | `lib/objstore.js` | 改 | `buildPointDemoKey` 生成合法 key |
| 5 | `routes/safety_points.js` | 新增 | GET 只读 / POST 入队 / presign / sign |
| 6 | `server.js` | 改 | ROUTES 挂载 |
| 7 | `migrations/005_safety_points.sql` | 新增 | 可重复执行 |
| 8 | `inspection_board.js` | 改 | 板块/节点来自点位，默认兜底 |
| 9 | `foodsafety.js` | 改 | 消毒 areas 来自点位 |
| 10 | `algorithms/inspection.js` | 改 | 节点校验优先点位 |
| 11 | 前端 types/api | 改 | 类型与请求函数 |
| 12 | `SafetyPointsPage.tsx` | 新增 | Tabs + 点位管理 + 演示图上传 |
| 13 | menu/App | 改 | 合并菜单入口 |
| 14 | 单测 + 联调 | 验证 | 见第 6 节 |

---

## 6. 验证清单（todo: tests-verify）

后端单测（`bff/lib/safety_points.test.js` 等）：
- `defaultPoints('inspection')` 长度 50；`defaultPoints('disinfect')` 长度 5。
- `resolvePoints({}, 'inspection')` 回退默认；传入 `ext.fs_points` 含该 kind 时优先返回且按 sort 升序。
- `pointById(ext,'inspection','K01')` 命中默认；自定义 id 命中 ext；不存在返回 null。
- 算法：`safety_point.upsert` 经 `executeAction` 后 `ext.fs_points` 含该行；重复 upsert 同 id 为更新（enabled 不变）。
- `safety_point.remove` 后 `enabled=0`，`resolvePoints` 不再列出。
- `recordInspection` 用自定义点位 id 能登记；未知 id 仍抛错（兜底内置）。

前后端联调：
- `GET /api/safety/points?kind=inspection` 返回默认 50 点（含 `configured`）。
- `POST /api/safety/points` 夹带 base64 字段 → 400。
- 演示图上传链路：presign → PUT → sign 读图 URL 可用。
- 审批中心确认 upsert 后，`GET /api/safety/points` 出现新点位；巡检看板/消毒达标率随之以新点位计算。
- 未配置 OSS 时页面降级提示，不阻断其余功能。

---

## 7. 关键约束速记（防止后续对话偏离）

1. 默认内置点位**不预置写库**；`remove` 只能禁用已写入 ext 的自定义点位（默认点位不可删，符合兜底意图）。
2. 巡检点 id 沿用 `K01..K50`，消毒默认 `D01..D05`，与 `inspection_records.node_id` 历史台账兼容。
3. 演示图只存 key/url 引用；现场巡检照片红线不动（`inspection_records` 无图片列）。
4. 所有写路径走 `enqueue` → 审批确认 → `executeAction`；路由写操作需 `mayWriteActions` 权限。
5. `buildBoard` / `disinfectReport` 改造只动「数据来源解析」，不动聚合口径与前端视图结构。
6. 迁移 SQL 全部 `IF NOT EXISTS`，可重复执行（CI 幂等检查）。
