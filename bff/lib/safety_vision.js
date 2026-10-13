'use strict';
/*
 * lib/safety_vision.js — 食安点位照片的视觉初判客户端（供 safety.ai_judge 使用）
 *
 * 职责：拿「点位核验要点 + 一张照片」向视觉模型要一个结构化初判，返回
 *   { ai_result: 'pass'|'fail', ai_reason, ai_confidence(0-100), model }
 * 失败（未配置 / 网络 / 解析失败）一律返回 null —— 由调用方把该条 check 记为 error，
 * **不删记录、不覆盖 final_result**（见 docs/safety-schema.md §2.1）。
 *
 * 复用 lib/agent/llm.js 的 OpenAI 兼容 chat/completions 客户端（同样只读 KIMI_API_KEY，
 * 零第三方依赖），只是消息体里带上 image_url 内容块。
 *
 * 红线：
 *   - Key 仅从 process.env.KIMI_API_KEY 读取，不入代码/日志/响应；
 *   - 图片 base64 **只在内存**中转（data URL）；本模块不落盘、不入库、不写任何文件；
 *   - 只读：本模块没有任何写库/入队路径。
 */
const https = require('https');
const http = require('http');
const llm = require('./agent/llm');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB 上限，防大图打爆内存
const LOW_CONF_THRESHOLD = 70; // 契约 §6：置信度 < 70 → 必须人工复核

/** 视觉模型是否可用（与 routes/kimi.js 同一密钥） */
function isConfigured() {
  return llm.isConfigured();
}

function logDiag(msg) {
  if (String(process.env.SAFETY_VISION_DEBUG || '0') === '0') return;
  try { console.error('[BFF][safety_vision] ' + msg); } catch (e) { /* ignore */ }
}

/** 下载图片到内存并转 data URL（图片本体不落盘） */
function fetchAsDataURL(url) {
  return new Promise((resolve, reject) => {
    let mod;
    if (/^https:/i.test(url)) mod = https;
    else if (/^http:/i.test(url)) mod = http;
    else return reject(new Error('photo_url 仅支持 http/https 或 data:image/'));
    const req = mod.get(url, { timeout: 15000 }, (resp) => {
      if (resp.statusCode !== 200) {
        resp.resume();
        return reject(new Error('取图失败 HTTP ' + resp.statusCode));
      }
      const ct = String(resp.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
      if (ct.indexOf('image/') !== 0) {
        resp.resume();
        return reject(new Error('photo_url 非图片 content-type: ' + ct));
      }
      const chunks = [];
      let size = 0;
      resp.on('data', (c) => {
        size += c.length;
        if (size > MAX_IMAGE_BYTES) {
          req.destroy(new Error('图片超过 ' + MAX_IMAGE_BYTES + ' 字节'));
          return;
        }
        chunks.push(c);
      });
      resp.on('end', () => resolve('data:' + ct + ';base64,' + Buffer.concat(chunks).toString('base64')));
      resp.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('取图超时')));
  });
}

/** photo_url → 可送模型的图片地址（data URL）；已是 data URL 时原样返回 */
function toImageUrl(photoUrl) {
  const u = String(photoUrl == null ? '' : photoUrl).trim();
  if (!u) return Promise.reject(new Error('缺少 photo_url'));
  if (/^data:image\//i.test(u)) return Promise.resolve(u);
  return fetchAsDataURL(u);
}

function normConf(v) {
  const n = parseFloat(v);
  if (!isFinite(n)) return null;
  const pct = n <= 1 ? n * 100 : n; // 模型可能给 0-1 或 0-100
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}

/** 把模型的自由输出归一为 {ai_result, ai_reason, ai_confidence} */
function normalizeParsed(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = String(parsed.result || parsed.ai_result || parsed.verdict || '').toLowerCase();
  let aiResult = null;
  if (/^(pass|ok|合格|passed|true)$/.test(raw)) aiResult = 'pass';
  else if (/^(fail|ng|不合格|failed|false)$/.test(raw)) aiResult = 'fail';
  if (!aiResult) return null;
  const reason = parsed.reason || parsed.note || parsed.ai_reason || parsed.detail || '';
  return {
    ai_result: aiResult,
    ai_reason: String(reason == null ? '' : reason).trim() || null,
    ai_confidence: normConf(parsed.confidence != null ? parsed.confidence : parsed.conf)
  };
}

function buildPrompt(point) {
  const p = point || {};
  const target = String(p.target || '').trim() || '按《食品安全法》与门店食安自查惯例判断该点位是否合格';
  return [
    '你是熊猫五福餐厅的食安自查 AI 助手。员工拍了一张点位照片，请仅依据画面可见信息判定该点位是否合格。',
    '',
    '【点位】' + (String(p.name || '').trim() || '未命名点位'),
    '【区域】' + (String(p.zone || '').trim() || '未标注'),
    '【核验要点】' + target,
    '',
    '判定规则：',
    '1. 画面中核验要点全部满足 → result=pass；任一项不满足 → result=fail；',
    '2. 看不清、角度不足、无法判断时，也判 result=fail，并在 reason 说明「照片不足以证明合格」；',
    '3. 不做人脸识别、不输出任何个人身份信息；',
    '4. 只输出判定，不建议任何写库动作。',
    '',
    '严格输出 JSON，不要输出 JSON 之外的任何文字：',
    '{ "result": "pass|fail", "confidence": 0-100, "reason": "判定依据（一句话，指出具体可见事实）" }'
  ].join('\n');
}

/**
 * 视觉初判。
 * @param {object} input { photo_url, point?:{id,name,zone,target} }
 * @returns {Promise<{ai_result,ai_reason,ai_confidence,model,low_conf}|null>} 失败返回 null
 */
async function judge(input) {
  const o = input || {};
  if (!isConfigured()) {
    logDiag('未配置 KIMI_API_KEY，跳过视觉初判');
    return null;
  }
  let imageUrl;
  try {
    imageUrl = await toImageUrl(o.photo_url);
  } catch (e) {
    logDiag('取图失败：' + ((e && e.message) || e));
    return null;
  }
  const messages = [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: imageUrl, detail: 'auto' } },
      { type: 'text', text: buildPrompt(o.point) }
    ]
  }];
  const parsed = await llm.chatJSON(messages, { maxTokens: 1400 });
  const norm = normalizeParsed(parsed);
  if (!norm) {
    logDiag('初判解析失败：' + JSON.stringify(parsed == null ? null : parsed).slice(0, 200));
    return null;
  }
  const model = (llm.MODEL_CANDIDATES && llm.MODEL_CANDIDATES[0]) || null;
  return Object.assign({ model: model, low_conf: norm.ai_confidence != null && norm.ai_confidence < LOW_CONF_THRESHOLD }, norm);
}

module.exports = { isConfigured, judge, toImageUrl, normalizeParsed, buildPrompt, LOW_CONF_THRESHOLD };
