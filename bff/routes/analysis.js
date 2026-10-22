'use strict';
/*
 * routes/analysis.js —— docx M1 经营分析只读端点（红线：零写库，全部走聚合/快照）
 *
 *   GET /api/analysis/trend?start_date=&end_date=   营收/毛利趋势（按日）
 *   GET /api/analysis/heat?date=                     24h×7 天热力
 *   GET /api/analysis/matrix?date=                   波士顿矩阵
 *   GET /api/analysis/efficiency?date=               效率仪表盘（翻台/坪效/人效）
 *   GET /api/analysis/weather?date=&city=            天气（TTL 24h 缓存 + 降级）
 *   POST /api/analysis/ai-suggestions                 AI 下周建议 + 天气结论
 *
 * 复用 modules.js 的 realAnalysis（真实快照聚合）与 weather_cache（Redis 替代）。
 */
const https = require('https');
const { realAnalysis, mockAnalysis } = require('./modules');
const { loadSnapshot } = require('./snapshot');
const weather = require('../lib/weather_cache');

function computeAnalysis() {
  const snap = loadSnapshot();
  const hasSales = !!(snap && Array.isArray(snap.data && snap.data.sales) && snap.data.sales.length > 0);
  const a = hasSales ? realAnalysis(snap, {}) : mockAnalysis({});
  return { a, snap, rev: snap ? snap.rev : null, mock: a.mock || !snap };
}

function filterTrend(trend, start, end) {
  if (!start && !end) return trend;
  return trend.filter((t) => (!start || t.date >= start) && (!end || t.date <= end));
}

// 确定性上下文（传给 AI 的「确定性函数结果」，AI 不自行算账）
function buildContext(a) {
  const revs = a.trend.map((t) => t.revenue);
  const last28 = revs.slice(-28);
  const sum = (xs) => xs.reduce((s, x) => s + (x || 0), 0);
  const topDishes = a.matrix.slice().sort((x, y) => (y.volume || 0) - (x.volume || 0)).slice(0, 5)
    .map((d) => ({ name: d.name, volume: d.volume, margin: +(d.margin * 100).toFixed(1) }));
  const peak = a.heatmap.slice().sort((x, y) => (y.revenue || 0) - (x.revenue || 0))[0];
  const avgMargin = a.matrix.length
    ? +(a.matrix.reduce((s, d) => s + (d.margin || 0), 0) / a.matrix.length * 100).toFixed(1) : null;
  return {
    weeks: Math.floor(a.trend.length / 7),
    last28_rev: Math.round(sum(last28)),
    top_dishes: topDishes,
    peak_hour: peak ? peak.hour : null,
    gross_margin: avgMargin,
    efficiency: a.efficiency
  };
}

/* 宽松解析模型返回：剥 ```json 围栏、截取首个 JSON 片段；失败返回 null（由调用方降级） */
function parseLooseJSON(txt) {
  if (typeof txt !== 'string') return txt || null;
  let s = txt.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch (e) {}
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {} }
  const c = s.indexOf('{'), d = s.lastIndexOf('}');
  if (c >= 0 && d > c) { try { return JSON.parse(s.slice(c, d + 1)); } catch (e) {} }
  return null;
}

function callAI(prompt) {
  return new Promise((resolve) => {
    const key = process.env.KIMI_API_KEY;
    if (!key) { resolve(null); return; }
    const body = JSON.stringify({
      model: 'kimi-k2.7-code-highspeed',
      messages: [{ role: 'user', content: prompt }],
      temperature: 1, // kimi-k2.7-code-highspeed 仅接受 temperature=1（传 0.3 会 400 invalid temperature）
      response_format: { type: 'json_object' }
    });
    const req = https.request({
      hostname: 'api.moonshot.cn', port: 443, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'Content-Length': Buffer.byteLength(body) },
      timeout: 30000
    }, (res) => {
      let buf = ''; res.on('data', (c) => buf += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          const txt = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          resolve(txt ? parseLooseJSON(txt) : null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

function seededSuggestions(ctx, weatherConclusion, weeks) {
  const sugg = [];
  if (ctx.peak_hour != null) {
    sugg.push({ title: '错峰备货', content: `客流高峰约 ${ctx.peak_hour}:00，提前 1 小时完成热门菜品预制与打包物料准备`, priority: '高' });
  }
  if (ctx.top_dishes.length) {
    sugg.push({ title: '明星菜保供', content: `全店近 28 日营收约 ${ctx.last28_rev} 元；明星菜「${ctx.top_dishes[0].name}」销量领先，确保其主料库存与出餐人手`, priority: '高' });
  }
  if (ctx.gross_margin != null) {
    sugg.push({ title: '毛利守护', content: `综合毛利率 ${ctx.gross_margin}%，对低毛利菜品做组合套餐提升客单价`, priority: '中' });
  }
  sugg.push({ title: '天气联动', content: weatherConclusion || '暂无天气结论', priority: '中' });
  sugg.push({ title: '会员唤醒', content: '对 30 天未消费会员推送 8 折券，提升到店频次', priority: '低' });
  return sugg.slice(0, 5);
}

/* response_format=json_object 时模型只能返回对象，建议数组常被包在 suggestions/data/... 下，
   这里先把「数组本体」抽出来，再交给 normalizeSuggestions 归一化。 */
function extractList(ai) {
  if (Array.isArray(ai)) return ai;
  if (ai && typeof ai === 'object') {
    const preferred = ['suggestions', 'data', 'list', 'items', 'result'];
    for (const k of preferred) if (Array.isArray(ai[k])) return ai[k];
    for (const k of Object.keys(ai)) if (Array.isArray(ai[k])) return ai[k];
  }
  return [];
}

/* 归一化 LLM 返回：过滤缺 title/content 的项、priority 落到「高/中/低」、截断到 5 条。
   采用 AI 结果的唯一前提是能凑满 5 条合法建议，否则整体回退确定性模板（保证「5 条」契约稳定）。 */
function normalizeSuggestions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const title = String(it.title || '').trim();
    const content = String(it.content || '').trim();
    if (!title || !content) continue;
    let priority = String(it.priority || '中').trim();
    if (['高', '中', '低'].indexOf(priority) < 0) priority = '中';
    // 仅白名单内的 action 才保留，杜绝 AI 编造危险动作类型
    let action = null;
    if (it.action && it.action.type === 'member.coupon' && it.action.params && typeof it.action.params === 'object') {
      action = { type: 'member.coupon', params: it.action.params };
    }
    out.push({ title, content, priority, action });
    if (out.length >= 5) break;
  }
  return out;
}

function handle(req, res, ctx, pathname) {
  const GET = req.method === 'GET';
  const POST = req.method === 'POST';
  const eps = ['/api/analysis/trend', '/api/analysis/heat', '/api/analysis/matrix', '/api/analysis/efficiency', '/api/analysis/weather'];
  if (GET && eps.indexOf(pathname) >= 0) {
    if (!ctx.auth) { ctx.sendJSON(res, 401, { ok: false, error: 'unauthorized' }); return true; }
    const { a, rev } = computeAnalysis();
    let data = null;
    if (pathname === '/api/analysis/trend') {
      data = filterTrend(a.trend, ctx.query.get('start_date'), ctx.query.get('end_date'));
    } else if (pathname === '/api/analysis/heat') {
      data = a.heatmap;
    } else if (pathname === '/api/analysis/matrix') {
      data = a.matrix;
    } else if (pathname === '/api/analysis/efficiency') {
      data = a.efficiency;
    } else if (pathname === '/api/analysis/weather') {
      const date = ctx.query.get('date') || new Date().toISOString().slice(0, 10);
      data = weather.getWeather(date, ctx.query.get('city'));
    }
    ctx.sendJSON(res, 200, { code: 200, data, rev, msg: 'ok' });
    return true;
  }

  if (POST && pathname === '/api/analysis/ai-suggestions') {
    if (!ctx.auth) { ctx.sendJSON(res, 401, { ok: false, error: 'unauthorized' }); return true; }
    return (async () => {
      const { a, rev } = computeAnalysis();
      const ctxData = buildContext(a);
      const fc = weather.getForecast(7);
      const weatherConclusion = `未来 7 天：${fc.map((w) => w.date.slice(5) + w.desc + w.temp + '℃').join('、')}`;
      const weeks = ctxData.weeks;
      const sampleNote = weeks < 4 ? `天气样本不足（<4周），建议仅供参考` : '';
      const prompt = `你是一个餐饮经营分析助手。请根据以下经营数据，给出下周（5条）经营建议。
【本周经营数据】
- 营收趋势(近28日): ${ctxData.last28_rev} 元，覆盖周数: ${weeks}
- 热门菜品TOP5: ${JSON.stringify(ctxData.top_dishes)}
- 时段客流峰值: ${ctxData.peak_hour} 时
- 毛利率: ${ctxData.gross_margin}%
【天气信息】${weatherConclusion}
【要求】1.给出5条具体可执行的经营建议 2.结合天气给出应对策略 3.每条不超过50字 4.只输出一个 JSON 对象，形如 {"suggestions":[{"title":"建议标题","content":"建议内容","priority":"高/中/低",可选"action":{"type":"member.coupon","params":{"discount":0.8,"target":"inactive_30d"}}}]}，其中 suggestions 必须是恰好 5 个元素的数组 5.仅当某条建议明确是「对会员发券/促销」类动作时，才可在该条附加 action 字段：type 只能是 "member.coupon"，params 含 discount(0~1 折扣) 与 target(如 "inactive_30d")；其余建议一律省略 action（保持纯建议，绝不自动触达）
注意：只能基于提供的数据，不要编造。样本不足(${weeks}<4周)时请在建议中说明。`;
      const ai = await callAI(prompt);
      const aiList = normalizeSuggestions(extractList(ai));
      let suggestions;
      let aiGenerated = false;
      if (aiList.length) {
        // 采用 AI 结果；不足 5 条时用确定性模板按标题去重补齐，保证「5 条」契约
        suggestions = aiList.slice(0, 5);
        if (suggestions.length < 5) {
          const filler = seededSuggestions(ctxData, weatherConclusion, weeks)
            .filter((s) => suggestions.every((x) => x.title !== s.title));
          suggestions = suggestions.concat(filler).slice(0, 5);
        }
        aiGenerated = true;
      } else {
        suggestions = seededSuggestions(ctxData, weatherConclusion, weeks);
      }
      ctx.sendJSON(res, 200, {
        code: 200,
        data: { suggestions, weather_conclusion: weatherConclusion, sample_weeks: weeks, ai_generated: aiGenerated, note: sampleNote },
        rev, msg: 'ok'
      });
      return true;
    })();
  }

  return false;
}

module.exports = { handle };
