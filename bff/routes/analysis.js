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

function callAI(prompt) {
  return new Promise((resolve) => {
    const key = process.env.KIMI_API_KEY;
    if (!key) { resolve(null); return; }
    const body = JSON.stringify({
      model: 'kimi-k2.7-code-highspeed',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      response_format: { type: 'json_object' }
    });
    const req = https.request({
      hostname: 'api.moonshot.cn', port: 443, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000
    }, (res) => {
      let buf = ''; res.on('data', (c) => buf += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          const txt = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          resolve(txt ? JSON.parse(txt) : null);
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
    sugg.push({ title: '错峰备货', content: `晚高峰约 ${ctx.peak_hour}:00，提前 1 小时完成热门菜品预制与打包物料准备`, priority: '高' });
  }
  if (ctx.top_dishes.length) {
    sugg.push({ title: '明星菜保供', content: `${ctx.top_dishes[0].name} 近 28 日营收约 ${ctx.last28_rev} 元，确保主料库存与出餐人手`, priority: '高' });
  }
  if (ctx.gross_margin != null) {
    sugg.push({ title: '毛利守护', content: `综合毛利率 ${ctx.gross_margin}%，对低毛利菜品做组合套餐提升客单价`, priority: '中' });
  }
  sugg.push({ title: '天气联动', content: weatherConclusion || '暂无天气结论', priority: '中' });
  sugg.push({ title: '会员唤醒', content: '对 30 天未消费会员推送 8 折券，提升到店频次', priority: '低' });
  return sugg.slice(0, 5);
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
【要求】1.给出5条具体可执行的经营建议 2.结合天气给出应对策略 3.每条不超过50字 4.用JSON数组格式输出:[{"title":"建议标题","content":"建议内容","priority":"高/中/低"}]
注意：只能基于提供的数据，不要编造。样本不足(${weeks}<4周)时请在建议中说明。`;
      const ai = await callAI(prompt);
      let suggestions;
      let aiGenerated = false;
      if (ai && Array.isArray(ai) && ai.length) { suggestions = ai; aiGenerated = true; }
      else { suggestions = seededSuggestions(ctxData, weatherConclusion, weeks); }
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
