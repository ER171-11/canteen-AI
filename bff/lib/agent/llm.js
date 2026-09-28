'use strict';
/*
 * lib/agent/llm.js — SI(超级智能)对话层：OpenAI 兼容 chat/completions 客户端
 *
 * 复用现有 KIMI_API_KEY（与 routes/kimi.js 同一密钥），零第三方依赖仅 http/https。
 * 可用 SI_LLM_HOST / SI_MODEL 覆盖，便于后续换厂商而不动业务。
 *
 * 红线：本模块仅做文本生成，绝不触碰快照/DB/写队列。
 */
const https = require('https');

const HOST = (process.env.SI_LLM_HOST || 'api.moonshot.cn').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const CHAT_PATH = '/v1/chat/completions';

/* 模型候选：SI_MODEL 优先，其余沿用 kimi 视觉实测可用家族 */
const MODEL_CANDIDATES = (function () {
  const list = [];
  if (process.env.SI_MODEL) list.push(String(process.env.SI_MODEL).trim());
  for (const m of ['kimi-k2.7-code-highspeed', 'kimi-k2.6', 'kimi-k3']) {
    if (list.indexOf(m) < 0) list.push(m);
  }
  return list;
})();

function isConfigured() {
  return !!(process.env.KIMI_API_KEY && String(process.env.KIMI_API_KEY).trim());
}

/* 单次 HTTPS 调用，返回 {status, data(字符串)} */
function call(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname: HOST,
      path: CHAT_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (process.env.KIMI_API_KEY || ''),
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 60000
    };
    const req = https.request(opts, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => resolve({ status: resp.statusCode, data: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('si llm timeout')));
    req.write(payload);
    req.end();
  });
}

/* 解析 content：兼容字符串 JSON / markdown 代码块 / 夹杂说明 */
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

/* 提取 message：content + reasoning_content + finish_reason */
function messageOf(data) {
  try {
    const j = JSON.parse(data);
    const msg = j && j.choices && j.choices[0] && j.choices[0].message;
    if (!msg) return null;
    return {
      content: msg.content,
      reasoning: msg.reasoning_content || '',
      finish: j.choices[0].finish_reason || null,
      usage: j.usage || null
    };
  } catch (e) {
    return null;
  }
}

/* llm 日志：默认开启，SI_LLM_DEBUG=0 关闭；仅打诊断信息，不含 Key */
function logDiag(msg) {
  if (String(process.env.SI_LLM_DEBUG || '1') === '0') return;
  try { console.error('[BFF][llm] ' + msg); } catch (e) {}
}

/* 推理模型（kimi 家族）强制 temperature=1，且会把 max_tokens 大量耗在 reasoning_content 上。
 * 这里给出最小 token 预算，并在 content 为空时自动抬升重试。 */
const MIN_REASONING_TOKENS = 2048;

/**
 * 对话取 JSON。按模型候选 × (temperature 兼容 × 带/不带 response_format × token 抬升) 逐级回退。
 * 兼容点：
 *   - invalid temperature → 用 temperature=1 重试（kimi 推理家族约束）
 *   - 200 但 content 空（推理占满 token）→ 抬升 max_tokens 重试，其次去掉 response_format
 * @returns {object|null} 解析后的对象，失败返回 null
 */
async function chatJSON(messages, opts) {
  if (!isConfigured()) {
    logDiag('未配置 KIMI_API_KEY，跳过 LLM 调用');
    return null;
  }
  const o = opts || {};
  const wantTokens = o.maxTokens || 1400;
  const wantTemp = o.temperature == null ? 1 : o.temperature;
  let lastErr = null;

  outer: for (const model of MODEL_CANDIDATES) {
    /* temperature 候选：先用户值，再强制 1（推理模型约束） */
    const temps = wantTemp === 1 ? [1] : [wantTemp, 1];
    /* token 候选：用户预算，其次抬到推理最低预算 */
    const tokens = wantTokens >= MIN_REASONING_TOKENS ? [wantTokens] : [wantTokens, MIN_REASONING_TOKENS];

    for (const tz of temps) {
      for (let ti = 0; ti < tokens.length; ti++) {
        for (const useJson of [true, false]) {
          const body = { model, temperature: tz, max_tokens: tokens[ti], messages };
          if (useJson) body.response_format = { type: 'json_object' };
          try {
            const r = await call(body);
            const low = String(r.data || '').toLowerCase();

            if (r.status === 200) {
              const msg = messageOf(r.data);
              if (!msg) { continue; }
              const parsed = parseContentJSON(msg.content);
              if (parsed) return parsed;
              /* 200 但内容为空：推理占满 token → 先抬 token，再换 response_format */
              if (!String(msg.content || '').trim()) {
                lastErr = model + ' content 空（reasoning ' + msg.reasoning.length + ' 字，finish=' + msg.finish + '）';
                if (ti + 1 < tokens.length) continue; // 抬 token 重试
                continue; // 已抬过 → 换 useJson/模型
              }
              continue; // 有内容但非 JSON → 换组合
            }

            /* 400: temperature 约束 → 记录并尝试 temperature=1（外层 temps 会兜） */
            if (r.status === 400 && /temperature/i.test(low)) {
              lastErr = model + ' 拒绝 temperature=' + tz;
              if (tz !== 1) continue; // 用 temp=1 重试
              continue outer; // temp=1 也被拒 → 换模型
            }
            if (r.status === 404 || /model.*(not|unsupported|not_found|不存在|not available)/i.test(r.data)) {
              lastErr = model + ' 不可用';
              continue outer; // 模型不存在 → 换模型
            }
            if (/response_format/i.test(low)) {
              lastErr = model + ' 不支持 json_object';
              break; // 去掉 response_format 重试同参数
            }
            lastErr = model + ' HTTP ' + r.status + ' ' + low.slice(0, 120);
            continue outer; // 其它错误 → 换模型
          } catch (e) {
            lastErr = model + ' 异常 ' + (e && e.message);
            continue outer;
          }
        }
      }
    }
  }
  logDiag('chatJSON 全部候选失败：' + (lastErr || 'unknown'));
  return null;
}

module.exports = { isConfigured, chatJSON, parseContentJSON, MODEL_CANDIDATES, HOST };
