'use strict';
/*
 * routes/kimi.js — Kimi 视觉代理（自 server.js 原样抽取，行为不变）
 *
 * 红线：API Key 仅从 process.env.KIMI_API_KEY 读取，不入 git、不回传前端、不写日志；
 *      图片 base64 只用内存，响应后销毁；只读，绝无写库路径。
 *
 * 接口（鉴权/限流/审计由 server.js 统一处理）：
 *   POST /api/kimi/vision        入参 {type, imageBase64, ctx} → {ok, result, traceId}
 *   POST /api/kimi/vision/stream 入参同上 → SSE：event:stage/delta/done/error
 *
 * result 形状对齐原型 renderKimiCard：{title, rows:[[item,value,status]], note, cta, conf}
 */
const https = require('https');

const MOONSHOT_HOST = 'api.moonshot.cn';
const MOONSHOT_PATH = '/v1/chat/completions';

/*
 * 模型选择说明（依据《Kimi视觉API调用契约.md》§2.1 与真实 /v1/models 探测结果）：
 *   真实探测发现当前账号可用模型已全部迁移到 kimi-* 推理家族，旧 moonshot-v1-* 均 404。
 *   可用模型均 supports_image_in=true；实测 kimi-k2.7-code-highspeed 首个稳定返回。
 *   候选顺序：kimi-k2.7-code-highspeed（实测可用） → kimi-k2.6 → kimi-k3（旗舰）
 */
const MODEL_CANDIDATES = [
  'kimi-k2.7-code-highspeed',
  'kimi-k2.6',
  'kimi-k3'
];

const VALID_STATUS = new Set(['pass', 'fail', 'warn']);
const VALID_ACTIONS = new Set([
  '登记入库', '生成补货单', '复核通过', '登记留样', '记录合规', '人工复核'
]);
const DEFAULT_ACTION_BY_TYPE = {
  recv: '人工复核', stock: '人工复核', qc: '人工复核',
  plate: '人工复核', sample: '人工复核', uniform: '人工复核'
};
const LOW_CONF_THRESHOLD = 70; // 契约 §6：置信度 < 70 → 强制人工复核

/* 6 用例 system prompt（原样落自契约 §3.2-§3.7） */
const SYSTEM_PROMPTS = {
  recv: `你是熊猫五福餐厅的验货 AI 助手。你的职责是：
1. 识别照片中的食材品名、规格、数量（估算）、外观鲜度、批次/溯源标签；
2. 将识别结果与"采购单"逐项比对，对每项给出 pass/fail/warn 判定；
3. 判定规则：品名一致=pass；数量偏差≤±3% =pass，>±3% 且 ≤±10%=warn，>±10%=fail；规格不符=fail；鲜度异常（变色/异味外观）=warn；缺少溯源标签=fail；
4. 色源锁定：红/黄/绿/紫/黑色源须与采购单一致（红色须为火龙果），不一致=fail；
5. 你只输出识别与判定，不做入库动作；suggestedAction 仅给出"登记入库"或"人工复核"建议。
必须严格输出 JSON，schema 见用户消息末尾。不要输出任何 JSON 外文字。`,
  stock: `你是熊猫五福餐厅的库存盘点 AI 助手。你的职责是：
1. 识别照片中可见的原料品名并估算当前库存量（kg/g 或件）；
2. 将估算值与"账面库存"对比：偏差在 ±5% 内 =pass，>±5% 且 ≤±15%=warn，>±15%=fail；
3. 对账面低于"安全库存"的原料，标注 warn 并在 note 给出补货建议金额；
4. 你只识别与估算，不调用任何算账函数、不修改库存；suggestedAction 仅给出"生成补货单"或"人工复核"。
5. 色源类原料（火龙果汁/南瓜泥/菠菜汁/紫薯粉/墨鱼汁）仅盘点，不建议替换。
严格输出 JSON，schema 见用户消息。不输出 JSON 外文字。`,
  qc: `你是熊猫五福餐厅的成品品控 AI 助手。你的职责是：
1. 识别照片中饺子成品的褶纹规整度、色泽饱满度、形态鼓胀度；
2. 估算单只成品重量（克），与非遗出品标准比对：成品重 25-27g（白色 25-28g）=pass，超出=fail，临界(±0.5g)=warn；
3. 褶纹规整度 ≥90% =pass，80-90%=warn，<80%=fail；色泽饱满 ≥90%=pass，80-90%=warn，<80%=fail；形态鼓胀同色标准；
4. 给出整体合格率（百分比）；
5. 你只识别与判定，不修改 qc_records；suggestedAction 仅给出"复核通过"或"人工复核"。
严格输出 JSON，schema 见用户消息。不输出 JSON 外文字。`,
  plate: `你是熊猫五福餐厅的摆盘质检 AI 助手。你的职责是：
1. 识别照片中成品盘的分量、配色（是否五福/五色齐整）、点缀规范、摆盘 SOP；
2. 判定规则：分量达标=pass，明显偏少/偏多=fail，临界=warn；配色五色齐整=pass，缺色=fail；点缀规范符合宫廷御膳 SOP=pass，不符=fail；摆盘整体 SOP 合规=pass，不符=warn；
3. 你只识别与判定，不记录合规；suggestedAction 仅给出"复核通过"或"人工复核"。
严格输出 JSON，schema 见用户消息。不输出 JSON 外文字。`,
  sample: `你是熊猫五福餐厅的留样登记 AI 助手。你的职责是：
1. 识别照片中留样盒的菜品名（红/黄/绿/紫/黑/白色饺子或对应 SKU）、克重（读标签或估算）、标签是否已贴、48h 到期时间；
2. 判定规则：菜品识别置信度高=pass；克重 ≥125g=pass，<125g=fail，125-130g=warn；标签已贴=pass，未贴=fail；48h 到期时间在合规区间=pass，临界(剩余<8h)=warn，超期=fail；
3. 你只识别与判定，不登记留样；suggestedAction 仅给出"登记留样"或"人工复核"。
严格输出 JSON，schema 见用户消息。不输出 JSON 外文字。`,
  uniform: `你是熊猫五福餐厅的着装合规 AI 助手。你的职责是：
1. 识别照片中员工的工服整洁、帽子佩戴、口罩规范、洗手消毒状态、整体 SOP 合规；
2. 判定规则：工服整洁=pass，污渍=fail，轻微皱=warn；帽子佩戴规范=pass，未戴=fail；口罩规范=pass，露鼻=fail，未戴=fail；洗手消毒完成=pass，未完成=fail；整体 SOP 合规=pass，单项 fail 则整体 warn；
3. 隐私约束：不输出任何个人身份信息，不做人脸识别，仅返回合规判定；
4. 你只识别与判定，不记录合规；suggestedAction 仅给出"记录合规"或"人工复核"。
严格输出 JSON，schema 见用户消息。不输出 JSON 外文字。`
};

/* 6 用例 user prompt 模板（原样落自契约 §3.2-§3.7，保留 {{...}} 占位） */
const USER_PROMPT_TEMPLATES = {
  recv: `【采购单】
{{采购单_JSON_品名_数量_规格_供应商_批次}}

【照片】见附图。

【任务】逐项比对，输出 JSON：
{
  "title": "验货识别",
  "confidence": 0-100,
  "thumbs": ["原图","识别框","对比"],
  "rows": [{"item":"品名","value":"识别值","status":"pass|fail|warn","detail":"判定依据"}],
  "note": "结论",
  "suggestedAction": "登记入库 | 人工复核"
}`,
  stock: `【账面库存】
{{账面库存_JSON_品名_账面量_单位_安全库存}}

【安全库存阈值】{{安全库存_由管理后台配置}}

【照片】见附图。

【任务】逐项估算并对比，输出 JSON：
{
  "title": "库存盘点",
  "confidence": 0-100,
  "thumbs": ["原图","识别框","对比"],
  "rows": [{"item":"品名","value":"估算量","status":"pass|fail|warn","detail":"与账面偏差/缺口"}],
  "note": "结论与补货建议（含金额）",
  "suggestedAction": "生成补货单 | 人工复核"
}`,
  qc: `【成品标准】
{{成品标准_JSON_色别_成品重区间_褶纹阈值_由recipes表只读取}}

【可选称重读数】{{电子秤读数_克_可选}}

【照片】见附图。

【任务】识别并判定，输出 JSON：
{
  "title": "成品质检",
  "confidence": 0-100,
  "thumbs": ["原图","识别框","对比"],
  "rows": [{"item":"褶纹规整|色泽饱满|形态鼓胀|重量估值","value":"识别值","status":"pass|fail|warn","detail":"判定依据"}],
  "note": "合格率结论",
  "suggestedAction": "复核通过 | 人工复核"
}`,
  plate: `【摆盘 SOP】
{{摆盘SOP_JSON_分量_配色_点缀_宫廷御膳标准_由recipes只读取}}

【照片】见附图。

【任务】识别并判定，输出 JSON：
{
  "title": "摆盘质检",
  "confidence": 0-100,
  "thumbs": ["原图","识别框","对比"],
  "rows": [{"item":"分量达标|配色五福|点缀规范|摆盘SOP","value":"识别值或pass","status":"pass|fail|warn","detail":"判定依据"}],
  "note": "结论",
  "suggestedAction": "复核通过 | 人工复核"
}`,
  sample: `【当前时间】{{ISO8601_当前时间_店内服务器}}

【留样标准】克重≥125g，48h 到期，标签含菜品+到期时间。

【照片】见附图。

【任务】识别并判定，输出 JSON：
{
  "title": "留样登记",
  "confidence": 0-100,
  "thumbs": ["原图","识别框","对比"],
  "rows": [{"item":"菜品识别|48h到期|克重|标签","value":"识别值","status":"pass|fail|warn","detail":"判定依据"}],
  "note": "结论",
  "suggestedAction": "登记留样 | 人工复核"
}`,
  uniform: `【着装 SOP】{{着装SOP_JSON_工服_帽_口罩_洗手_由管理后台配置}}

【照片】见附图。

【任务】识别并判定，输出 JSON：
{
  "title": "着装 SOP 合规",
  "confidence": 0-100,
  "thumbs": ["原图","识别框","对比"],
  "rows": [{"item":"工服整洁|帽子佩戴|口罩规范|洗手消毒|SOP合规","value":"pass或识别值","status":"pass|fail|warn","detail":"判定依据"}],
  "note": "结论",
  "suggestedAction": "记录合规 | 人工复核"
}`
};

/* ctx 占位注入：把 ctx 中相关字段填进 {{...}}，未提供则用合理默认 */
function safeJson(v) {
  if (v === undefined || v === null) return '未提供';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}
function buildUserPrompt(type, ctx) {
  ctx = ctx || {};
  let t = USER_PROMPT_TEMPLATES[type];
  switch (type) {
    case 'recv':
      t = t.replace('{{采购单_JSON_品名_数量_规格_供应商_批次}}', safeJson(ctx.采购单 || ctx.purchaseOrder));
      break;
    case 'stock':
      t = t.replace('{{账面库存_JSON_品名_账面量_单位_安全库存}}', safeJson(ctx.账面库存 || ctx.stockBook));
      t = t.replace('{{安全库存_由管理后台配置}}', safeJson(ctx.安全库存 || ctx.safetyStock));
      break;
    case 'qc':
      t = t.replace('{{成品标准_JSON_色别_成品重区间_褶纹阈值_由recipes表只读取}}',
        safeJson(ctx.成品标准 || ctx.productStandard || '成品重 25-27g，褶纹阈值 ≥90%'));
      t = t.replace('{{电子秤读数_克_可选}}', safeJson(ctx.称重读数 || ctx.weight || '未提供'));
      break;
    case 'plate':
      t = t.replace('{{摆盘SOP_JSON_分量_配色_点缀_宫廷御膳标准_由recipes只读取}}',
        safeJson(ctx.摆盘SOP || ctx.plateSop || '五色齐整，宫廷御膳点缀规范'));
      break;
    case 'sample':
      t = t.replace('{{ISO8601_当前时间_店内服务器}}',
        safeJson(ctx.当前时间 || ctx.currentTime || new Date().toISOString()));
      break;
    case 'uniform':
      t = t.replace('{{着装SOP_JSON_工服_帽_口罩_洗手_由管理后台配置}}',
        safeJson(ctx.着装SOP || ctx.uniformSop || '工服整洁 / 帽子 / 口罩 / 洗手消毒'));
      break;
  }
  return t;
}

// 原型 fileToBase64 返回完整 data URL；也兼容纯 base64。统一成 data URL 供 Moonshot。
function normalizeImageToDataURL(imageBase64) {
  if (!imageBase64) return '';
  const s = String(imageBase64).trim();
  if (s.startsWith('data:')) return s;
  return 'data:image/jpeg;base64,' + s;
}

// 单次 HTTPS 调用 Moonshot，返回 {status, data}
function callMoonshot(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname: MOONSHOT_HOST,
      path: MOONSHOT_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (process.env.KIMI_API_KEY || ''),
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 180000 // 推理模型"思考期"较长，首字延迟高
    };
    const req = https.request(opts, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => resolve({ status: resp.statusCode, data: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('moonshot read timeout')));
    req.write(payload);
    req.end();
  });
}

// 流式调用 Moonshot（stream:true），解析 SSE 并回调 content delta。
function callMoonshotStream(body, onDelta) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname: MOONSHOT_HOST,
      path: MOONSHOT_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (process.env.KIMI_API_KEY || ''),
        'Content-Length': Buffer.byteLength(payload),
        'Accept': 'text/event-stream'
      },
      timeout: 180000
    };
    let buf = '';
    let fullContent = '';
    let done = false;
    let status = 0;
    let errBody = '';
    const req = https.request(opts, (resp) => {
      status = resp.statusCode;
      resp.on('data', (chunk) => {
        const s = chunk.toString('utf8');
        if (status !== 200) { errBody += s; return; }
        buf += s;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split('\n')) {
            const m = line.match(/^data:\s*(.*)$/);
            if (!m) continue;
            const d = m[1].trim();
            if (d === '[DONE]') { done = true; resolve({ status, fullContent, errBody }); return; }
            try {
              const j = JSON.parse(d);
              const delta = j && j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
              if (delta && onDelta) { fullContent += delta; onDelta(delta); }
            } catch (e) { /* 忽略非 JSON 行 */ }
          }
        }
      });
      resp.on('end', () => { if (!done) resolve({ status, fullContent, errBody }); });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('moonshot stream timeout')));
    req.write(payload);
    req.end();
  });
}

// 智能调用：按 模型候选 × (带/不带 response_format) × (temperature 0.2 → 1) 逐级回退
async function invokeMoonshot(messages) {
  let last = { status: 0, data: 'no attempt', model: null, useJson: false, temperature: 0.2 };
  outer: for (const model of MODEL_CANDIDATES) {
    for (const useJson of [true, false]) {
      for (const temperature of [0.2, 1]) {
        const body = { model, temperature, max_tokens: 1200, messages };
        if (useJson) body.response_format = { type: 'json_object' };
        try {
          const r = await callMoonshot(body);
          last = { status: r.status, data: r.data, model, useJson, temperature };
          if (r.status === 200) return last;
          const low = (r.data || '').toLowerCase();
          if (r.status === 404 || /model.*(not|unsupported|not_found|不存在|not available)/i.test(r.data)) {
            continue outer; // 模型不存在/无权限 → 换下一个模型
          }
          if (/response_format/i.test(low)) break; // 该模型不支持 json_object → 去 useJson=false 再试
          if (/temperature/i.test(low)) continue; // 温度被拒 → 换 temperature=1 再试
          return last; // 其它 4xx/5xx 不再重试，交外层降级（契约 §2.3）
        } catch (e) {
          last = { status: 0, data: String(e && e.message || e), model, useJson, temperature };
          continue; // 网络错误换组合再试
        }
      }
    }
  }
  return last;
}

// 解析 content 为 JSON（兼容字符串 JSON / markdown 代码块 / 夹杂说明文字）
function parseContentJSON(content) {
  if (content == null) return null;
  if (typeof content === 'object') return content;
  let s = String(content).trim();
  s = s.replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(s); } catch (e) {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}

// 契约 schema → 原型 renderKimiCard 形状 {title,rows:[[item,value,status]],note,cta,conf}
function mapToPrototype(parsed, type) {
  const fbAction = DEFAULT_ACTION_BY_TYPE[type] || '人工复核';
  if (!parsed || typeof parsed !== 'object') return null;
  const title = (typeof parsed.title === 'string' && parsed.title.trim())
    ? parsed.title.trim() : (type + ' 识别');
  let rows = [];
  if (Array.isArray(parsed.rows)) {
    rows = parsed.rows.map((r) => {
      if (Array.isArray(r)) {
        const st = VALID_STATUS.has(r[2]) ? r[2] : 'warn';
        return [String(r[0] || ''), String(r[1] == null ? '' : r[1]), st];
      }
      const st = (r && VALID_STATUS.has(r.status)) ? r.status : 'warn';
      return [String((r && r.item) || ''), String((r && r.value) == null ? '' : r.value), st];
    });
  }
  const note = (typeof parsed.note === 'string') ? parsed.note : '';
  let action = parsed.suggestedAction || parsed.cta || fbAction;
  if (!VALID_ACTIONS.has(action)) action = fbAction;
  let conf = parsed.confidence;
  if (typeof conf !== 'number') conf = parseFloat(conf);
  if (isNaN(conf)) conf = 0;
  if (conf < 0) conf = 0;
  if (conf > 100) conf = 100;
  if (conf < LOW_CONF_THRESHOLD) action = '人工复核';
  return { title, rows, note, cta: action, conf: Math.round(conf) + '%' };
}

// 读取并校验视觉请求体；失败时已直接响应，返回 null
async function readVisionReq(req, res, ctx) {
  const { buf } = await ctx.readBody(req);
  let reqObj = null;
  try { reqObj = JSON.parse(buf.toString('utf8')); }
  catch (e) {
    ctx.sendJSON(res, 400, { ok: false, error: 'invalid json body', traceId: ctx.traceId });
    return null;
  }
  const type = reqObj.type;
  const imageBase64 = reqObj.imageBase64;
  if (!SYSTEM_PROMPTS[type]) {
    ctx.sendJSON(res, 400, { ok: false, error: 'unsupported type: ' + type, traceId: ctx.traceId });
    return null;
  }
  if (!process.env.KIMI_API_KEY) {
    ctx.sendJSON(res, 500, { ok: false, error: 'BFF missing KIMI_API_KEY', traceId: ctx.traceId });
    return null;
  }
  const dataURL = normalizeImageToDataURL(imageBase64);
  if (!dataURL) {
    ctx.sendJSON(res, 400, { ok: false, error: 'missing imageBase64', traceId: ctx.traceId });
    return null;
  }
  return { type, dataURL, bizCtx: reqObj.ctx || {} };
}

function buildMessages(type, dataURL, bizCtx) {
  return [
    { role: 'system', content: SYSTEM_PROMPTS[type] },
    { role: 'user', content: [
      { type: 'image_url', image_url: { url: dataURL, detail: 'auto' } },
      { type: 'text', text: buildUserPrompt(type, bizCtx) }
    ]}
  ];
}

/* POST /api/kimi/vision（非流式，行为与原版一致） */
async function handleVision(req, res, ctx) {
  const started = Date.now();
  const v = await readVisionReq(req, res, ctx);
  if (!v) return;

  const messages = buildMessages(v.type, v.dataURL, v.bizCtx);

  let moonResult;
  try {
    moonResult = await invokeMoonshot(messages);
  } catch (e) {
    console.error(`[BFF][${ctx.traceId}] invoke crashed:`, e && e.message);
    return ctx.sendJSON(res, 200, { ok: false, error: 'moonshot invoke crashed', traceId: ctx.traceId });
  }
  const { status, data, model, useJson, temperature } = moonResult;
  const dt = Date.now() - started;
  console.log(`[BFF][${ctx.traceId}] type=${v.type} model=${model} response_format=${useJson} temp=${temperature} http=${status} dt=${dt}ms`);
  ctx.kimiLog({ ts: new Date().toISOString(), trace_id: ctx.traceId, type: v.type, model, http: status, dt_ms: dt, degraded: status !== 200, stream: false });

  if (status !== 200) {
    const detail = String(data).slice(0, 300);
    return ctx.sendJSON(res, 200, { ok: false, error: 'moonshot http ' + status, model, detail, traceId: ctx.traceId });
  }

  let parsedBody = null;
  try { parsedBody = JSON.parse(data); } catch (e) {}
  const content = parsedBody
    && parsedBody.choices && parsedBody.choices[0]
    && parsedBody.choices[0].message
    && parsedBody.choices[0].message.content;

  const parsed = parseContentJSON(content);
  const result = mapToPrototype(parsed, v.type);
  if (!result) {
    return ctx.sendJSON(res, 200, {
      ok: false,
      error: 'parse content failed',
      contentSnippet: String(content == null ? '' : content).slice(0, 200),
      model, traceId: ctx.traceId
    });
  }
  return ctx.sendJSON(res, 200, { ok: true, result, model, traceId: ctx.traceId });
}

/* POST /api/kimi/vision/stream（SSE，行为与原版一致） */
async function handleVisionStream(req, res, ctx) {
  const started = Date.now();
  const v = await readVisionReq(req, res, ctx);
  if (!v) return;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Trace-Id',
    'X-Trace-Id': ctx.traceId,
    'X-Accel-Buffering': 'no'
  });

  const writeEvent = (name, data) => {
    if (res.writableEnded) return;
    try { res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {}
  };

  const STAGES = ['upload', 'recognize', 'advise'];
  let si = 0;
  writeEvent('stage', { stage: STAGES[0] });
  const stageTimer = setInterval(() => {
    si = (si + 1) % STAGES.length;
    writeEvent('stage', { stage: STAGES[si] });
  }, 2000);

  const messages = buildMessages(v.type, v.dataURL, v.bizCtx);

  let resolved = false;
  const finishWithResult = (ok, payload) => {
    if (resolved) return; resolved = true;
    clearInterval(stageTimer);
    if (ok) writeEvent('done', Object.assign({ ok: true }, payload, { traceId: ctx.traceId }));
    else writeEvent('error', Object.assign({ ok: false }, payload, { traceId: ctx.traceId }));
    try { res.end(); } catch (e) {}
  };

  res.on('close', () => { clearInterval(stageTimer); resolved = true; });

  // 1) 优先流式调用（首个候选模型，temperature=1，无 response_format）
  try {
    const sr = await callMoonshotStream({
      model: MODEL_CANDIDATES[0], temperature: 1, max_tokens: 1200, stream: true, messages
    }, (delta) => writeEvent('delta', { delta }));

    if (sr.status === 200 && sr.fullContent) {
      const dt = Date.now() - started;
      console.log(`[BFF][${ctx.traceId}][stream] type=${v.type} model=${MODEL_CANDIDATES[0]} http=200 dt=${dt}ms bytes=${sr.fullContent.length}`);
      ctx.kimiLog({ ts: new Date().toISOString(), trace_id: ctx.traceId, type: v.type, model: MODEL_CANDIDATES[0], http: 200, dt_ms: dt, degraded: false, stream: true });
      const parsed = parseContentJSON(sr.fullContent);
      const result = mapToPrototype(parsed, v.type);
      if (result) return finishWithResult(true, { result, model: MODEL_CANDIDATES[0] });
      return finishWithResult(false, { error: 'parse content failed', model: MODEL_CANDIDATES[0] });
    }
    console.log(`[BFF][${ctx.traceId}][stream] degrade to non-stream: http=${sr.status} body=${String(sr.errBody).slice(0, 200)}`);
  } catch (e) {
    console.log(`[BFF][${ctx.traceId}][stream] crashed: ${e && e.message}; degrade to non-stream`);
  }

  // 2) 降级：非流式智能调用
  let moonResult;
  try {
    moonResult = await invokeMoonshot(messages);
  } catch (e) {
    console.error(`[BFF][${ctx.traceId}] invoke crashed:`, e && e.message);
    return finishWithResult(false, { error: 'moonshot invoke crashed' });
  }
  const { status, data, model, useJson, temperature } = moonResult;
  const dt = Date.now() - started;
  console.log(`[BFF][${ctx.traceId}] type=${v.type} model=${model} response_format=${useJson} temp=${temperature} http=${status} dt=${dt}ms`);
  ctx.kimiLog({ ts: new Date().toISOString(), trace_id: ctx.traceId, type: v.type, model, http: status, dt_ms: dt, degraded: true, stream: true });

  if (status !== 200) {
    return finishWithResult(false, { error: 'moonshot http ' + status, model, detail: String(data).slice(0, 300) });
  }
  let parsedBody = null;
  try { parsedBody = JSON.parse(data); } catch (e) {}
  const content = parsedBody
    && parsedBody.choices && parsedBody.choices[0]
    && parsedBody.choices[0].message
    && parsedBody.choices[0].message.content;
  const parsed = parseContentJSON(content);
  const result = mapToPrototype(parsed, v.type);
  if (result) return finishWithResult(true, { result, model });
  return finishWithResult(false, { error: 'parse content failed', contentSnippet: String(content == null ? '' : content).slice(0, 200), model });
}

module.exports = { MODEL_CANDIDATES, handleVision, handleVisionStream };
