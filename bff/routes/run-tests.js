'use strict';
/*
 * routes/run-tests.js — BFF 路由层回归测试（零依赖，node 直跑）
 *
 * 覆盖 routes/settle.js：
 *   · GET/PUT 往返、默认值回落、白名单清洗（未知字段必须丢弃）
 *   · RBAC：只读角色不得写
 *   · 红线：模板不得污染 snapshot.json（结算单是只读输出层）
 *
 * 覆盖 routes/qc_media.js（A 块品控照片通道）：
 *   · 未配置对象存储时降级（configured:false），品控主流程不中断
 *   · 配置后签发 PUT/GET 预签名 URL（SigV4 无需 SDK）
 *   · 红线②-a：请求体带图片 base64 一律 400 驳回，绝不接收图片本体
 *   · RBAC：无 actions.write 不得签发上传 URL
 *
 * 覆盖 routes/actions.js：
 *   · 入队两级幂等：OPEN 复用同一动作；「已执行」后窗口内复投复用原动作（连点两下不产生两条待审批）
 *   · 已驳回 不参与事后幂等（驳回后可重新发起）
 *
 * 覆盖 routes/snapshot.js：
 *   · markRecipeStatus 未配配方标记（FP-SALE-14）：sku_id（或 dish.id）优先、name 兜底；
 *     main/aux/seasoning 全空即视为未配配方；ext.recipes 缺失/为空时不标记（防全店误报）
 *
 * 运行：node routes/run-tests.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bff-routes-'));
process.env.BFF_DATA_DIR = dir;

const settle = require('./settle');
const qcMedia = require('./qc_media');

function mkctx(role) {
  return {
    auth: role ? { role, account: 'u1' } : null,
    traceId: 't-test',
    sendJSON: (res, code, obj) => {
      res.code = code;
      res.body = obj;
    },
    readBody: async (req) => ({ buf: Buffer.from(String(req.__body || '{}'), 'utf8') }),
  };
}

/** 品控/巡检只读与媒体端点需要 ctx.storeId / ctx.query，这里给最小可用桩 */
function mkMediaCtx(role, queryStr) {
  const c = mkctx(role);
  c.storeId = 'ST001';
  c.query = new URLSearchParams(queryStr || '');
  return c;
}

async function testQcMedia(ok) {
  /* 1) 未配置对象存储：必须降级而非报错 */
  const noEnv = ['OSS_ENDPOINT', 'OSS_BUCKET', 'OSS_AK', 'OSS_SK'];
  const saved = {};
  noEnv.forEach((n) => { saved[n] = process.env[n]; delete process.env[n]; });

  let res = {};
  await qcMedia.handle({ method: 'GET' }, res, mkMediaCtx('店长'), '/api/qc/media/status');
  ok('qc_media.status 未配置返回 200 + configured=false',
    res.code === 200 && res.body.configured === false, res.body);
  ok('qc_media.status 列出缺失环境变量（4 项）',
    Array.isArray(res.body.missing) && res.body.missing.length === 4, res.body.missing);
  ok('qc_media.status 绝不回传密钥', JSON.stringify(res.body).indexOf('sk=') < 0);

  res = {};
  await qcMedia.handle(
    { method: 'POST', __body: JSON.stringify({ workorder_id: 1 }) },
    res, mkMediaCtx('店长'), '/api/qc/media/presign',
  );
  ok('qc_media.presign 未配置时降级 200 + objstore_not_configured',
    res.code === 200 && res.body.configured === false
    && res.body.code === 'objstore_not_configured', res.body);
  ok('qc_media.presign 降级时给出提示文案', typeof res.body.hint === 'string');

  /* 2) 红线：图片载荷一律驳回 */
  res = {};
  await qcMedia.handle(
    { method: 'POST', __body: JSON.stringify({ workorder_id: 1, image_base64: 'data:image/jpeg;base64,AAAA' }) },
    res, mkMediaCtx('店长'), '/api/qc/media/presign',
  );
  ok('qc_media.presign 拒收图片 base64（400 image_payload_rejected）',
    res.code === 400 && res.body.code === 'image_payload_rejected', res.body);

  res = {};
  await qcMedia.handle(
    { method: 'POST', __body: JSON.stringify({ workorder_id: 1, photo_base64: 'AAAA' }) },
    res, mkMediaCtx('店长'), '/api/qc/media/presign',
  );
  ok('qc_media.presign 拒收 photo_base64', res.code === 400, res.body);

  ok('hasImagePayload 忽略空字符串字段',
    qcMedia.hasImagePayload({ image_base64: '   ' }) === false);
  ok('hasImagePayload 命中非空图片字段',
    qcMedia.hasImagePayload({ image: 'AAAA' }) === true);

  /* 3) 配置对象存储后：签发预签名 URL */
  process.env.OSS_ENDPOINT = 'https://oss-cn-hangzhou.aliyuncs.com';
  process.env.OSS_BUCKET = 'pandawufu-qc';
  process.env.OSS_AK = 'AKID-TEST-ONLY';
  process.env.OSS_SK = 'SECRET-TEST-ONLY';
  process.env.OSS_REGION = 'cn-hangzhou';
  process.env.OSS_SERVICE = 'oss';

  res = {};
  await qcMedia.handle({ method: 'GET' }, res, mkMediaCtx('店长'), '/api/qc/media/status');
  ok('qc_media.status 配置后 configured=true 且不回传 AK/SK',
    res.code === 200 && res.body.configured === true
    && JSON.stringify(res.body).indexOf('SECRET-TEST-ONLY') < 0, res.body);

  res = {};
  await qcMedia.handle(
    { method: 'POST', __body: JSON.stringify({ workorder_id: 88, ext: 'jpg', content_type: 'image/jpeg' }) },
    res, mkMediaCtx('店长'), '/api/qc/media/presign',
  );
  ok('qc_media.presign 签发 PUT 上传 URL', res.code === 200 && res.body.method === 'PUT', res.body);
  ok('qc_media.presign 对象键落在 qc/{门店}/{日期}/ 前缀下',
    /^qc\/ST001\/\d{4}-\d{2}-\d{2}\/88-\d+-[0-9a-f]{6}\.jpg$/.test(res.body.key || ''), res.body.key);
  ok('qc_media.presign 上传 URL 含 SigV4 签名参数',
    /X-Amz-Algorithm=AWS4-HMAC-SHA256/.test(res.body.upload_url || '')
    && /X-Amz-Signature=[0-9a-f]{64}/.test(res.body.upload_url || ''), res.body.upload_url);
  ok('qc_media.presign 返回 upload 头与过期秒数',
    res.body.headers && res.body.headers['Content-Type'] === 'image/jpeg'
    && res.body.expires_in > 0, res.body.headers);
  ok('qc_media.presign 未配 OSS_PUBLIC_BASE 时 photo_url 为空（走 GET 预签名读图）',
    res.body.photo_url === null && res.body.public_base === false, res.body);

  const key = res.body.key;

  /* 4) 批量换取读取 URL（后台看大图） */
  res = {};
  await qcMedia.handle(
    { method: 'POST', __body: JSON.stringify({ keys: [key, '../etc/passwd', ''] }) },
    res, mkMediaCtx('店长'), '/api/qc/media/sign',
  );
  ok('qc_media.sign 返回 GET 预签名 URL', res.code === 200 && res.body.count === 1, res.body);
  ok('qc_media.sign 读取 URL 为 GET 且带签名',
    res.body.items[0].url.indexOf('X-Amz-Signature=') > 0
    && /X-Amz-Algorithm=AWS4-HMAC-SHA256/.test(res.body.items[0].url), res.body.items[0]);
  ok('qc_media.sign 丢弃路径穿越键', res.body.skipped === 2, res.body);

  /* 5) RBAC：无 actions.write 不得签发上传 URL */
  res = {};
  await qcMedia.handle(
    { method: 'POST', __body: JSON.stringify({ workorder_id: 9 }) },
    res, mkMediaCtx('只读'), '/api/qc/media/presign',
  );
  ok('qc_media.presign 只读角色被拒 403', res.code === 403, res.body);

  /* 6) 非本路由不接管 */
  const other = {};
  const took = await qcMedia.handle({ method: 'POST' }, other, mkMediaCtx('店长'), '/api/other');
  ok('qc_media 非本路由不接管', took === false);

  /* 7) 未知子路径必须显式 404，不静默吞掉 */
  res = {};
  await qcMedia.handle({ method: 'GET' }, res, mkMediaCtx('店长'), '/api/qc/media/nope');
  ok('qc_media 未知子路径 404', res.code === 404, res.body);

  /* 8) 配置后 presign 必须要求 workorder_id */
  res = {};
  await qcMedia.handle(
    { method: 'POST', __body: JSON.stringify({ ext: 'jpg' }) },
    res, mkMediaCtx('店长'), '/api/qc/media/presign',
  );
  ok('qc_media.presign 缺 workorder_id 返回 400', res.code === 400, res.body);

  /* 回收环境变量，避免污染同进程后续用例 */
  noEnv.forEach((n) => { delete process.env[n]; });
  Object.keys(saved).forEach((n) => { if (saved[n] !== undefined) process.env[n] = saved[n]; });
}

/**
 * 巡检统筹看板只读端点（C/D 块后台）。
 * 红线：只读、无写路径；输出里不得出现任何图片字段（巡检照片只存手机本地）。
 */
async function testInspectionBoardRoute(ok) {
  const modules = require('./modules');

  // 无快照：必须空开 200 + hint，而不是整页「加载失败」
  let res = {};
  await modules.handle({ method: 'GET' }, res, mkMediaCtx('店长'), '/api/modules/inspection');
  ok('modules.inspection 无快照空开 200 + no_snapshot',
    res.code === 200 && res.body.ok === true && res.body.hint === 'no_snapshot', res.body && res.body.hint);
  ok('modules.inspection 无快照仍回满 50 个节点主数据',
    Array.isArray(res.body.nodes) && res.body.nodes.length === 50, res.body.nodes && res.body.nodes.length);
  ok('modules.inspection 无快照 summary.done=0', res.body.summary.done === 0, res.body.summary);

  // 打入快照：含 3 条巡检记录（其中 1 条未拍照）
  fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify({
    rev: 7,
    generated_at: '2026-09-29T23:30:00',
    size: 1,
    data: {},
    ext: {
      inspection_records: [
        { node_id: 'K01', board: '后厨', date: '2026-09-29', done: 1, photo_taken: 1, operator: '王师傅', ts: '2026-09-29T21:00:00' },
        { node_id: 'K02', board: '后厨', date: '2026-09-29', done: 0, photo_taken: 0, operator: '王师傅', ts: '2026-09-29T21:02:00' },
        { node_id: 'F11', board: '前厅', date: '2026-09-29', done: 1, photo_taken: 1, every30: 1, round: 42, operator: '小刘', ts: '2026-09-29T21:05:00' }
      ],
      inspection_assignments: [{ board: '后厨', operator: '王师傅' }]
    }
  }), 'utf8');

  res = {};
  await modules.handle({ method: 'GET' }, res, mkMediaCtx('店长', 'date=2026-09-29'), '/api/modules/inspection');
  ok('modules.inspection 读快照聚合完成率',
    res.code === 200 && res.body.summary.done === 2 && res.body.summary.total === 50, res.body.summary);
  ok('modules.inspection rev 透传（前端可判断数据新旧）', res.body.rev === 7, res.body.rev);
  ok('modules.inspection 板块完成率三项齐全',
    Array.isArray(res.body.boards) && res.body.boards.length === 3
    && res.body.boards[0].rate === 5, res.body.boards);
  ok('modules.inspection 漏项清单含未拍照节点',
    res.body.boards.filter((b) => b.board === '后厨')[0].missing
      .some((m) => m.node_id === 'K02' && m.photo_taken === false));
  ok('modules.inspection 输出绝不含图片字段',
    JSON.stringify(res.body).indexOf('photo_url') < 0
    && JSON.stringify(res.body).indexOf('base64') < 0);
  ok('modules.inspection 带 updated_at 供前端标注数据时间',
    typeof res.body.updated_at === 'string' && res.body.updated_at.length >= 10);

  // 筛选：点位维度
  res = {};
  await modules.handle({ method: 'GET' }, res, mkMediaCtx('店长', 'date=2026-09-29&node_id=F11'), '/api/modules/inspection');
  ok('modules.inspection 按点位筛选只回该点位记录', res.body.records.length === 1, res.body.records.length);

  // 只读红线：非 GET 不接管
  const other = {};
  const tookPost = await modules.handle({ method: 'POST' }, other, mkMediaCtx('店长'), '/api/modules/inspection');
  ok('modules.inspection 非 GET 不接管（只读）', tookPost === false);

  const other2 = {};
  const took = await modules.handle({ method: 'GET' }, other2, mkMediaCtx('店长'), '/api/other');
  ok('modules 非本路由不接管', took === false);
}

/**
 * A 块品控不合格 → 收件箱 alerts（admin-web 经 SSE 实时看到大图与判定依据）。
 * 红线：只透传 photo_key / photo_url 引用，图片本体绝不进 BFF。
 */
async function testQcInboxAlerts(ok) {
  const inbox = require('./inbox');
  const snap = {
    rev: 9,
    generated_at: '2026-09-29T20:40:00',
    data: {},
    ext: {
      recipes: [{ sku_id: 'SKU-WF-HONG', name: '五福红饺' }],
      qc_records: [
        { id: 31, workorder_id: 12, sku_id: 'SKU-WF-HONG', pass: 0, ts: '2026-09-29T20:30:00',
          defect_items: '["裂纹","开口"]', stage: '捏褶', operator: '张三', station: '后厨-捏褶台',
          conf: 63.4, manual_review: 1, photo_url: null, photo_key: 'qc/ST001/2026-09-29/12-a1b2c3.jpg' },
        { id: 32, workorder_id: 13, sku_id: 'SKU-WF-HONG', pass: 1, ts: '2026-09-29T20:35:00' },
        { id: 33, workorder_id: 14, sku_id: 'SKU-UNKNOWN', pass: '不合格', ts: '2026-09-29T20:38:00',
          defects: ['色泽偏差', '重量偏差'] }
      ]
    }
  };

  const alerts = inbox.qcAlerts(snap);
  ok('qcAlerts 只收不合格记录（合格记录不计入）', alerts.length === 2, alerts.length);
  ok('qcAlerts 按时间倒序（最新在前）', alerts[0].id.indexOf('qc_33') === 0, alerts.map((a) => a.id));
  ok('qcAlerts 标题带菜品名', alerts[1].title === '品控不合格 · 五福红饺', alerts[1].title);
  ok('qcAlerts 未关联菜品回落 sku_id', alerts[0].title === '品控不合格 · SKU-UNKNOWN', alerts[0].title);
  ok('qcAlerts 解析 JSON 字符串缺陷项', alerts[1].defects.join('/') === '裂纹/开口', alerts[1].defects);
  ok('qcAlerts 解析别名 defects 数组', alerts[0].defects.join('/') === '色泽偏差/重量偏差', alerts[0].defects);
  ok('qcAlerts 摘要含环节/责任人/点位/置信度',
    ['环节:捏褶', '责任人:张三', '点位:后厨-捏褶台', '置信度:63.4']
      .every((s) => alerts[1].summary.indexOf(s) >= 0), alerts[1].summary);
  ok('qcAlerts 透传大图对象键供 admin-web 换预签名 URL',
    alerts[1].photo_key === 'qc/ST001/2026-09-29/12-a1b2c3.jpg', alerts[1].photo_key);
  ok('qcAlerts 标注待人工复核', alerts[1].manual_review === true && alerts[0].manual_review === false);
  ok('qcAlerts 归入 alerts 组且路由指向厨房品控页',
    alerts.every((a) => a.group === 'alerts' && a.route === 'kitchen'));
  ok('qcAlerts 绝不携带图片本体（无 base64/data uri）',
    JSON.stringify(alerts).indexOf('base64') < 0 && JSON.stringify(alerts).indexOf('data:image') < 0);

  // 空快照不报错
  ok('qcAlerts 无快照返回空数组', inbox.qcAlerts(null).length === 0);
  ok('qcAlerts 无 qc_records 返回空数组', inbox.qcAlerts({ ext: {} }).length === 0);

  // 端到端：buildInbox 把品控不合格并入 alerts 计数与指纹（SSE 才会推增量）
  const view = inbox.buildInbox(snap);
  ok('buildInbox 把品控不合格并入 alerts', view.alerts.some((a) => a.kind === 'qc_fail'), view.counts);
  ok('buildInbox counts 计入品控告警', view.counts.alerts >= 2, view.counts);
  ok('buildInbox 品控告警带 created_at 供前端排序', !!view.alerts.filter((a) => a.kind === 'qc_fail')[0].created_at);
}

/**
 * actions 入队两级幂等 —— 现场高频投诉「连点两下 = 两条待审批 = 两笔入库」的回归防线。
 *   ① OPEN（queued/待执行）：同 type+payload+operator → 复用同一 id
 *   ② 已执行后 5 分钟窗口内复投 → 复用该已执行动作（dedup_of:"executed"），不新建
 *   ③ 窗口外复投 → 正常新建（不把"过一会儿确实想再做一次同样的写"永久屏蔽）
 *   ④ 已驳回 不参与事后幂等 → 可重新发起
 */
async function testActionsDedup(ok) {
  const actions = require('./actions');
  const store = require('../lib/store');
  const operator = '店长';
  const post = async (p, pathname) => {
    const res = {};
    await actions.handle(
      { method: 'POST', __body: JSON.stringify(p == null ? {} : p) },
      res, mkMediaCtx('店长'), pathname || '/api/actions',
    );
    return res;
  };

  /* ① 首次入队 + 队列内幂等 */
  const body = { type: 'stock.replenish', payload: { sku: 'flour', qty: 10 }, operator };
  const first = await post(body);
  ok('actions 首次入队 queued（dedup=false）',
    first.code === 200 && first.body.status === 'queued' && first.body.dedup === false, first.body);
  const id1 = first.body.id;

  const dupOpen = await post(body);
  ok('队列内幂等：OPEN 期间重复提交 → 复用同一 id（dedup_of=open）',
    dupOpen.body.id === id1 && dupOpen.body.dedup === true && dupOpen.body.dedup_of === 'open', dupOpen.body);

  /* 模拟店内消费器回调：动作进入「已执行」 */
  const exec = await post({ result: { ok: true, new_rev: 99 } }, '/api/actions/' + id1 + '/execute');
  ok('消费器回调 → 已执行（via=store）', exec.code === 200 && exec.body.status === '已执行', exec.body);

  /* ② 连点两下的真凶场景：已执行之后又点了一次 */
  const again = await post(body);
  ok('已执行后复投 → 复用同一 id（dedup_of=executed，status 已执行）',
    again.body.id === id1 && again.body.dedup === true
    && again.body.dedup_of === 'executed' && again.body.status === '已执行', again.body);
  const q1 = store.readJSON('actions_queue.json', []);
  ok('连点两下后队列仍只有 1 条动作', q1.length === 1, q1.length);
  ok('审批中心不会出现重复待审批（queued 计数为 0）',
    q1.filter((a) => a.status === 'queued').length === 0);

  /* ③ 窗口外：把已执行时刻推到 6 分钟前（> EXECUTED_DEDUP_MS=5min），复投应正常新建 */
  const q2 = store.readJSON('actions_queue.json', []);
  q2[0].executed_at = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  store.writeJSON('actions_queue.json', q2);
  const later = await post(body);
  ok('窗口（5 分钟）外复投 → 正常新建（不是永久去重）',
    later.body.dedup === false && later.body.id !== id1 && later.body.status === 'queued', later.body);

  /* ④ 已驳回 不参与事后幂等 */
  const body2 = { type: 'stock.replenish', payload: { sku: 'sugar', qty: 5 }, operator };
  const rej = await post(body2);
  const idRej = rej.body.id;
  const rejOut = await post({ reason: '数量不对' }, '/api/actions/' + idRej + '/reject');
  ok('管理端驳回 → 已驳回', rejOut.code === 200 && rejOut.body.status === '已驳回', rejOut.body);
  const retry = await post(body2);
  ok('已驳回后重新发起 → 正常新建（驳回不锁死）',
    retry.body.dedup === false && retry.body.id !== idRej, retry.body);
}

/*
 * 覆盖 routes/snapshot.js（FP-SALE-14 未配配方告警的数据源）：
 *   · markRecipeStatus：sku_id（或 dish.id）优先、name 兜底；
 *     main/aux/seasoning 至少一列有料才算"已配配方"
 *   · ext.recipes 缺失/为空时不标记（默认视为已配），避免全店误报
 */
async function testSnapshotRecipeMark(ok) {
  const snapshot = require('./snapshot');
  const dishes = [
    { id: 'D1', name: '有配方菜', sku_id: 'SKU-A' },
    { id: 'SKU-B', name: '占位SKU菜' },
    { id: 'D2', name: '无配方菜' },
    { id: 'D3', name: '空配方菜', sku_id: 'SKU-C' },
    { id: 'D4', name: '名字命中菜' },
  ];
  const ext = { recipes: [
    { sku_id: 'SKU-A', name: '有配方菜', main: '["猪肉"]', aux: '[]', seasoning: '[]' },
    { sku_id: 'SKU-B', name: '占位SKU菜', main: '["韭菜"]', aux: '[]', seasoning: '[]' },
    { sku_id: 'SKU-C', name: '空配方菜', main: '[]', aux: '   ', seasoning: '[]' },
    { sku_id: 'SKU-Z', name: '名字命中菜', main: [], aux: ['盐'], seasoning: null },
  ] };
  const out = snapshot.markRecipeStatus(dishes, ext);
  const get = (id) => out.find((x) => x && x.id === id) || {};
  ok('markRecipeStatus sku_id 命中且有主料 → has_recipe=true', get('D1').has_recipe === true, get('D1'));
  ok('markRecipeStatus dish.id 即 sku 命中 → true', get('SKU-B').has_recipe === true, get('SKU-B'));
  ok('markRecipeStatus 无配方行 → false', get('D2').has_recipe === false, get('D2'));
  ok('markRecipeStatus 配方行列全空（含空白串）→ false', get('D3').has_recipe === false, get('D3'));
  ok('markRecipeStatus name 兜底命中且辅料有料 → true', get('D4').has_recipe === true, get('D4'));
  ok('markRecipeStatus 非破坏：原字段保留', get('D1').name === '有配方菜' && get('D1').sku_id === 'SKU-A');
  ok('markRecipeStatus 非对象元素原样返回', snapshot.markRecipeStatus([null, 1, 'x'], ext).length === 3);

  const noExt = snapshot.markRecipeStatus(dishes, null);
  ok('markRecipeStatus ext 缺失时不加 has_recipe（防全店误报）', noExt.every((x) => x.has_recipe === undefined));
  const emptyExt = snapshot.markRecipeStatus(dishes, { recipes: [] });
  ok('markRecipeStatus ext.recipes 为空时不加 has_recipe', emptyExt.every((x) => x.has_recipe === undefined));

  const took = await snapshot.handle({ method: 'GET' }, {}, mkctx('老板'), '/api/other');
  ok('snapshot 非本路由不接管', took === false);
}

/**
 * 食安点位主数据路由（巡检 / 消毒统一事实来源）。
 * 守护：只读空态回退默认、写操作进审批队列、图片红线、RBAC、演示图预签名。
 */
async function testSafetyPointsRoute(ok) {
  const safety = require('./safety_points');

  // 只读：无自定义点位时回退内置默认（50 巡检点）
  let res = {};
  await safety.handle({ method: 'GET' }, res, mkMediaCtx('店长', 'kind=inspection'), '/api/safety/points');
  ok('safety.points GET 默认返回 200 + 50 巡检点',
    res.code === 200 && res.body.ok === true && res.body.points.length === 50, res.body && res.body.count);
  ok('safety.points GET 标注 using_defaults', res.body.using_defaults === true, res.body.using_defaults);
  ok('safety.points 点位含 id/name/zone/kind 字段',
    !!res.body.points[0].id && !!res.body.points[0].name && res.body.points[0].kind === 'inspection');

  // 消毒默认 5 个
  res = {};
  await safety.handle({ method: 'GET' }, res, mkMediaCtx('店长', 'kind=disinfect'), '/api/safety/points');
  ok('safety.points GET 消毒默认 5 个', res.body.points.length === 5, res.body.count);

  // kind 非法 → 400
  res = {};
  await safety.handle({ method: 'GET' }, res, mkMediaCtx('店长', 'kind=nope'), '/api/safety/points');
  ok('safety.points GET kind 非法 400', res.code === 400, res.body);

  // RBAC：只读角色不得新增
  res = {};
  await safety.handle(
    { method: 'POST', __body: JSON.stringify({ name: 'X', kind: 'inspection' }) },
    res, mkMediaCtx('只读'), '/api/safety/points',
  );
  ok('safety.points POST 只读角色被拒 403', res.code === 403, res.body);

  // 新增点位：入队
  res = {};
  await safety.handle(
    { method: 'POST', __body: JSON.stringify({ name: '验收台', zone: '后厨', kind: 'inspection', sort: 3 }) },
    res, mkMediaCtx('店长'), '/api/safety/points',
  );
  ok('safety.points POST 新增入队返回 action_id',
    res.code === 200 && typeof res.body.action_id === 'string', res.body);
  const actId = res.body.action_id;

  // RBAC：删除（逻辑删除）也要求写权限
  res = {};
  await safety.handle(
    { method: 'POST', __body: JSON.stringify({ id: 'K01', kind: 'inspection' }) },
    res, mkMediaCtx('店长'), '/api/safety/points/remove',
  );
  ok('safety.points POST remove 入队', res.code === 200 && typeof res.body.action_id === 'string', res.body);

  // 红线：图片 base64 一律驳回
  res = {};
  await safety.handle(
    { method: 'POST', __body: JSON.stringify({ name: 'X', kind: 'inspection', image_base64: 'data:image/jpeg;base64,AAAA' }) },
    res, mkMediaCtx('店长'), '/api/safety/points',
  );
  ok('safety.points POST 拒收图片 base64（400 image_payload_rejected）',
    res.code === 400 && res.body.code === 'image_payload_rejected', res.body);

  // 缺 name / kind 非法 → 400
  res = {};
  await safety.handle(
    { method: 'POST', __body: JSON.stringify({ kind: 'inspection' }) },
    res, mkMediaCtx('店长'), '/api/safety/points',
  );
  ok('safety.points POST 缺 name 400', res.code === 400, res.body);

  res = {};
  await safety.handle(
    { method: 'POST', __body: JSON.stringify({ id: 'K01' }) },
    res, mkMediaCtx('店长'), '/api/safety/points/remove',
  );
  ok('safety.points remove 缺 kind 400', res.code === 400, res.body);

  // seed 导入默认
  res = {};
  await safety.handle(
    { method: 'POST', __body: JSON.stringify({ kind: 'disinfect' }) },
    res, mkMediaCtx('店长'), '/api/safety/points/seed',
  );
  ok('safety.points seed 入队', res.code === 200 && typeof res.body.action_id === 'string', res.body);

  // presign：未配置对象存储时降级
  const savedEnv = {};
  ['OSS_ENDPOINT', 'OSS_BUCKET', 'OSS_AK', 'OSS_SK'].forEach((n) => { savedEnv[n] = process.env[n]; delete process.env[n]; });
  res = {};
  await safety.handle(
    { method: 'POST', __body: JSON.stringify({ kind: 'inspection', id: 'K01' }) },
    res, mkMediaCtx('店长'), '/api/safety/points/presign',
  );
  ok('safety.points presign 未配置对象存储时降级 200 + configured=false',
    res.code === 200 && res.body.configured === false, res.body);

  // presign：配置后签发 PUT URL，对象键落在 points/ 前缀
  process.env.OSS_ENDPOINT = 'https://oss-cn-hangzhou.aliyuncs.com';
  process.env.OSS_BUCKET = 'pandawufu-qc';
  process.env.OSS_AK = 'AKID-TEST-ONLY';
  process.env.OSS_SK = 'SECRET-TEST-ONLY';
  process.env.OSS_REGION = 'cn-hangzhou';
  process.env.OSS_SERVICE = 'oss';
  res = {};
  await safety.handle(
    { method: 'POST', __body: JSON.stringify({ kind: 'inspection', id: 'K01', ext: 'jpg' }) },
    res, mkMediaCtx('店长'), '/api/safety/points/presign',
  );
  ok('safety.points presign 签发 PUT URL', res.code === 200 && res.body.method === 'PUT', res.body);
  ok('safety.points presign 对象键落在 points/ST001/ 前缀下',
    /^points\/ST001\/\d{4}-\d{2}-\d{2}\/inspection-K01-\d+-[0-9a-f]{6}\.jpg$/.test(res.body.key || ''), res.body.key);
  ok('safety.points presign URL 含 SigV4 签名', /X-Amz-Signature=[0-9a-f]{64}/.test(res.body.upload_url || ''));
  const demoKey = res.body.key;

  // sign 读图（私有 bucket 换上图 URL）
  res = {};
  await safety.handle(
    { method: 'POST', __body: JSON.stringify({ keys: [demoKey] }) },
    res, mkMediaCtx('店长'), '/api/safety/points/sign',
  );
  ok('safety.points sign 返回 GET 预签名 URL',
    res.code === 200 && res.body.items.length === 1 && res.body.items[0].url.indexOf('X-Amz-Signature=') > 0, res.body);

  ['OSS_ENDPOINT', 'OSS_BUCKET', 'OSS_AK', 'OSS_SK', 'OSS_REGION', 'OSS_SERVICE'].forEach((n) => { delete process.env[n]; });
  Object.keys(savedEnv).forEach((n) => { if (savedEnv[n] !== undefined) process.env[n] = savedEnv[n]; });

  // 未知子路径 404；非本路由不接管
  res = {};
  await safety.handle({ method: 'POST', __body: '{}' }, res, mkMediaCtx('店长'), '/api/safety/points/nope');
  ok('safety.points 未知子路径 404', res.code === 404, res.body);

  const other = {};
  const took = await safety.handle({ method: 'GET' }, other, mkMediaCtx('店长'), '/api/other');
  ok('safety.points 非本路由不接管', took === false);

  // 审批队列里确实产生了点位动作
  const store = require('../lib/store');
  const q = store.readJSON('actions_queue.json', []);
  ok('safety.points 写操作进入审批队列（含 safety_point.* 动作）',
    q.some((a) => String(a.type).indexOf('safety_point.') === 0), { actId: actId });
}

/**
 * 食安拍照上报只读进度端点（routes/safety.js）。
 * 守护：空态回退内置种子点位、当日口径、**只读红线**（不写 snapshot.json、不接管非 GET、不入队）。
 */
async function testSafetyProgressRoute(ok) {
  const safety = require('./safety');
  const plan = require('../lib/safety_plan');
  const snapFile = path.join(dir, 'snapshot.json');
  const had = fs.existsSync(snapFile) ? fs.readFileSync(snapFile, 'utf8') : null;

  /* 1) 无快照：仍回满内置种子点位（新环境初始化后进度页有点位列表） */
  if (fs.existsSync(snapFile)) fs.unlinkSync(snapFile);
  let res = {};
  await safety.handle({ method: 'GET' }, res, mkMediaCtx('老板'), '/api/safety/progress');
  ok('safety.progress 无快照空开 200 + hint=no_snapshot',
    res.code === 200 && res.body.ok === true && res.body.hint === 'no_snapshot', res.body && res.body.hint);
  ok('safety.progress 无快照回满内置种子点位',
    res.body.points.length === plan.DEFAULT_POINTS.length
    && res.body.total_points === plan.DEFAULT_POINTS.length, res.body.total_points);
  ok('safety.progress 无快照标注 using_defaults 且计数为 0',
    res.body.using_defaults === true && res.body.completed_points === 0
    && res.body.pass_count === 0 && res.body.fail_count === 0
    && res.body.review_count === 0 && res.body.error_count === 0, res.body);
  ok('safety.progress 未上报点位 status=none',
    res.body.points.every((p) => p.status === 'none' && p.effective_result === null && p.check_id === null));

  /* 2) 打入快照：2 条当日记录（1 条 AI fail 待复核 / 1 条已复核改判 fail） */
  const day = '2026-10-12';
  fs.writeFileSync(snapFile, JSON.stringify({
    rev: 42,
    generated_at: day + 'T09:30:00.000Z',
    size: 1,
    data: {
      safety: {
        checks: [
          { id: 'chk_a', point_id: 'SC-01', operator: '张三', photo_url: 'https://cdn.example.com/a.jpg',
            ai_result: 'fail', ai_reason: '未离地存放', ai_confidence: 88.5, final_result: null,
            review_reason: null, status: 'ai_done', created_at: day + 'T01:12:30.000Z' },
          { id: 'chk_b', point_id: 'SC-02', operator: '李四', photo_url: 'https://cdn.example.com/b.jpg',
            ai_result: 'pass', ai_reason: '密封良好', ai_confidence: 93.2, final_result: 'fail',
            review_reason: '现场复查有反复解冻', status: 'reviewed', created_at: day + 'T01:20:05.000Z' },
          { id: 'chk_prev', point_id: 'SC-01', ai_result: 'fail', final_result: null, created_at: '2026-10-11T23:00:00.000Z' }
        ]
      }
    },
    ext: {}
  }), 'utf8');
  const before = fs.readFileSync(snapFile, 'utf8');

  res = {};
  await safety.handle({ method: 'GET' }, res, mkMediaCtx('老板', 'date=' + day), '/api/safety/progress');
  ok('safety.progress 读快照聚合（total/completed）',
    res.code === 200 && res.body.total_points === plan.DEFAULT_POINTS.length
    && res.body.completed_points === 2, res.body);
  ok('safety.progress pass/fail/review/error 口径正确',
    res.body.pass_count === 0 && res.body.fail_count === 2
    && res.body.review_count === 1 && res.body.error_count === 0, res.body);
  ok('safety.progress rev 透传（前端可判断数据新旧）', res.body.rev === 42, res.body.rev);
  ok('safety.progress 点位透传 AI 初判与人工结论',
    res.body.points.filter((p) => p.point_id === 'SC-01')[0].ai_result === 'fail'
    && res.body.points.filter((p) => p.point_id === 'SC-02')[0].final_result === 'fail', res.body.points[0]);
  ok('safety.progress 点位 status：AI fail 待复核 → review；已复核 → fail',
    res.body.points.filter((p) => p.point_id === 'SC-01')[0].status === 'review'
    && res.body.points.filter((p) => p.point_id === 'SC-02')[0].status === 'fail');
  ok('safety.progress 非当日记录不计入今日',
    res.body.points.filter((p) => p.point_id === 'SC-01')[0].check_id === 'chk_a');

  /* 3) 只读红线：不写库、不入队、不改快照、无图片本体 */
  ok('safety.progress 绝不修改快照文件（只读）', fs.readFileSync(snapFile, 'utf8') === before);
  const store = require('../lib/store');
  ok('safety.progress 不入队（actions 队列无新增动作）',
    store.readJSON('actions_queue.json', []).every((a) => String(a.type).indexOf('safety.') !== 0));
  ok('safety.progress 响应不含图片本体（无 base64/data:image）',
    JSON.stringify(res.body).indexOf('base64') < 0 && JSON.stringify(res.body).indexOf('data:image') < 0);

  /* 4) 只读语义：非 GET 不接管；非本路由不接管；未知子路径不吞 404 */
  const p = {};
  ok('safety 非 GET 不接管（写操作一律走 /api/actions）',
    (await safety.handle({ method: 'POST' }, p, mkMediaCtx('老板'), '/api/safety/progress')) === false);
  const o1 = {};
  ok('safety 非本路由不接管',
    (await safety.handle({ method: 'GET' }, o1, mkMediaCtx('老板'), '/api/other')) === false);
  const o2 = {};
  ok('safety 不吞同前缀的写路由（/api/safety/points 交给 safety_points.js）',
    (await safety.handle({ method: 'GET' }, o2, mkMediaCtx('老板'), '/api/safety/points')) === false);

  /* 还原快照，避免污染后续用例 */
  if (had === null) { if (fs.existsSync(snapFile)) fs.unlinkSync(snapFile); }
  else fs.writeFileSync(snapFile, had, 'utf8');
}

async function main() {
  let fail = 0;
  const ok = (name, cond, extra) => {
    if (!cond) {
      fail++;
      console.log('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
    } else {
      console.log('ok   ' + name);
    }
  };

  let res = {};
  await settle.handle({ method: 'GET' }, res, mkctx('老板'), '/api/settle/template');
  ok('GET 返回 200', res.code === 200, res);
  ok('GET 首次 source=default', res.body && res.body.source === 'default', res.body);
  ok('默认签字栏三项', res.body && res.body.template.subjects.length === 3, res.body);

  res = {};
  await settle.handle(
    {
      method: 'PUT',
      __body: JSON.stringify({ template: { title: '付款审批单', subjects: '经办人/审核人/审批人/财务' } }),
    },
    res,
    mkctx('老板'),
    '/api/settle/template',
  );
  ok('PUT 返回 200', res.code === 200, res);
  ok('subjects 按分隔符拆成 4 项', res.body && res.body.template.subjects.length === 4, res.body);

  res = {};
  await settle.handle({ method: 'GET' }, res, mkctx('老板'), '/api/settle/template');
  ok('GET 二次 source=file', res.body && res.body.source === 'file', res.body);
  ok('回读 title 一致', res.body && res.body.template.title === '付款审批单', res.body);

  res = {};
  await settle.handle(
    { method: 'PUT', __body: JSON.stringify({ template: { title: 'x' } }) },
    res,
    mkctx('只读'),
    '/api/settle/template',
  );
  ok('只读角色 PUT 被拒 403', res.code === 403, res);

  res = {};
  await settle.handle(
    { method: 'PUT', __body: JSON.stringify({ template: { evil: 'x', subjects: [] } }) },
    res,
    mkctx('老板'),
    '/api/settle/template',
  );
  ok('未知字段被丢弃（白名单）', res.body && res.body.template.evil === undefined, res.body);
  ok('空 subjects 回落默认', res.body && res.body.template.subjects.length === 3, res.body);

  res = {};
  await settle.handle({ method: 'PUT', __body: 'not-json' }, res, mkctx('老板'), '/api/settle/template');
  ok('非法 JSON 返回 400', res.code === 400, res);

  const other = {};
  const took = await settle.handle({ method: 'GET' }, other, mkctx('老板'), '/api/other');
  ok('非本路由不接管', took === false);

  ok('未创建 snapshot.json（不碰业务库）', !fs.existsSync(path.join(dir, 'snapshot.json')));

  await testQcMedia(ok);
  await testInspectionBoardRoute(ok);
  await testQcInboxAlerts(ok);
  await testActionsDedup(ok);
  await testSnapshotRecipeMark(ok);
  await testSafetyPointsRoute(ok);
  await testSafetyProgressRoute(ok);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fail ? '== routes 测试失败 ' + fail + ' 项 ==' : '== routes 测试全部通过 ==');
  process.exit(fail ? 1 : 0);
}

main();
