'use strict';
/*
 * lib/agent/planner.js — SI 规划器（ReAct + 只读工具）
 *
 * 协议：与 LLM 约定纯 JSON 往返，避免依赖各家 function-calling 差异。
 *   LLM → {"type":"tool","tool":"store_overview","args":{...}}   （可连续多次）
 *   LLM → {"type":"final","answer":"...","cards":[{title,summary,type,cta_label,payload}]}
 *
 * 红线：
 *   - 工具全部只读，LLM 不得自算数字；
 *   - cards 的 type 必须在算法注册表白名单内，payload 原样交给确认台，SI 不入队不落库。
 */
const llm = require('./llm');
const tools = require('./tools');

/* 允许 SI 提案的动作类型：已登记算法为准（未知 type 会被店内消费器驳回） */
require('../algorithms/registry');
const algorithms = require('../algorithms/index');
const ALLOWED_TYPES = new Set(algorithms.listTypes());

function systemPrompt() {
  const catalog = tools.catalog().map((t) => {
    const args = Object.keys(t.args || {}).length
      ? ' 参数:' + JSON.stringify(t.args)
      : ' 无参数';
    return '- ' + t.name + '：' + t.desc + args;
  }).join('\n');
  const types = Array.from(ALLOWED_TYPES).sort().join(', ');
  return [
    '你是「熊猫五福餐厅」老板的超级经营助理（SI）。你只做两件事：用只读工具查真实数据，再用老板听得懂的话给结论与提案。',
    '',
    '铁律：',
    '1. 你绝不自己计算营收/毛利/成本/库存，所有数字必须来自工具返回；没有工具结果就不要编数字。',
    '2. 你不直接改任何数据。提案只生成卡片，老板在「确认台」点头才执行。',
    '3. 只输出 JSON，不要任何多余文字、不要 markdown。',
    '',
    '可用工具：',
    catalog,
    '',
    '输出协议（二选一）：',
    'A. 需要数据：{"type":"tool","tool":"工具名","args":{...}}',
    'B. 信息足够：{"type":"final","answer":"中文结论，≤120字，含关键数字与原因","cards":[]}',
    '',
    'cards 仅在确有可执行动作时给（≤3 条），每条形如：',
    '{"title":"...","summary":"...","type":"动作type","cta_label":"去确认台...","payload":{...}}',
    '动作 type 只能从以下白名单选（其它一律不要给）：',
    types
  ].join('\n');
}

function normalizeCards(raw) {
  const out = [];
  for (const c of (Array.isArray(raw) ? raw : [])) {
    if (!c || typeof c !== 'object') continue;
    const type = String(c.type || '').trim();
    if (!ALLOWED_TYPES.has(type)) continue;
    const payload = (c.payload && typeof c.payload === 'object') ? c.payload : {};
    out.push({
      title: String(c.title || c.cta_label || 'SI 提案').slice(0, 80),
      summary: String(c.summary || '').slice(0, 300),
      type,
      cta_label: String(c.cta_label || '去确认台').slice(0, 40),
      payload
    });
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * 跑一轮 SI 问答。
 * @param {object} p {question, snap, onStep}
 * @returns {Promise<{answer,cards,steps,model}|null>} 未配置/失败返回 null（由路由降级）
 */
async function runAgent(p) {
  const question = String(p.question || '').trim();
  if (!question || !llm.isConfigured()) return null;
  const snap = p.snap;
  const steps = [];
  const messages = [
    { role: 'system', content: systemPrompt() },
    {
      role: 'user',
      content: JSON.stringify({
        question,
        context: {
          today: tools.todayStr(),
          rev: snap ? snap.rev : null,
          data_updated_at: snap ? snap.generated_at : null
        }
      })
    }
  ];

  const MAX = 4;
  for (let i = 0; i < MAX; i++) {
    const msg = await llm.chatJSON(messages, { maxTokens: i === 0 ? 2048 : 3072 });
    if (!msg || typeof msg !== 'object') break;

    if (msg.type === 'tool' && msg.tool) {
      const result = tools.runTool(msg.tool, msg.args, snap);
      const step = { tool: String(msg.tool), args: msg.args || {}, ok: !result.error };
      steps.push(step);
      if (typeof p.onStep === 'function') {
        try { p.onStep(step); } catch (e) {}
      }
      messages.push({ role: 'assistant', content: JSON.stringify({ type: 'tool', tool: msg.tool, args: msg.args || {} }) });
      messages.push({
        role: 'user',
        content: '工具 ' + msg.tool + ' 返回：' + JSON.stringify(result).slice(0, 4000)
          + '\n请继续：还需要数据就再输出 A，否则输出 B。'
      });
      continue;
    }

    if (msg.type === 'final' && msg.answer) {
      return {
        answer: String(msg.answer).slice(0, 600),
        cards: normalizeCards(msg.cards),
        steps,
        model: null
      };
    }
    break;
  }

  /* 兜底：工具跑完仍没收敛，强制要一个结论 */
  messages.push({ role: 'user', content: '请现在只输出 B 格式的最终 JSON 结论。' });
  const finalMsg = await llm.chatJSON(messages, { maxTokens: 2048 });
  if (finalMsg && finalMsg.answer) {
    return {
      answer: String(finalMsg.answer).slice(0, 600),
      cards: normalizeCards(finalMsg.cards),
      steps,
      model: null
    };
  }
  return null;
}

module.exports = { runAgent, ALLOWED_TYPES };
