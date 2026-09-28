'use strict';
/*
 * lib/si_knowledge.js — SI 知识创造与迁移
 *
 * 从门店数据中"创造"可复用的经营打法（playbook），并支持沉淀人工经验：
 *   - 数据挖掘型：高毛利爆品组合、损耗主因、低谷时段、原料价格波动、配方/SOP 资产
 *   - 人工沉淀型：老板/店长写入的经验，后续可被 SI 引用与迁移（跨战役/跨时段）
 * 红线：只读快照 + 自定义知识存 si_knowledge.json；不改业务数据。
 */
const store = require('./store');

const FILE = 'si_knowledge.json';
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

function loadCustom() {
  const k = store.readJSON(FILE, []);
  return Array.isArray(k) ? k : [];
}
function saveCustom(list) { store.writeJSON(FILE, list); }

function addPlaybook(input) {
  const list = loadCustom();
  const rec = {
    id: 'kb_' + Date.now().toString(36),
    title: String((input && input.title) || '未命名打法').slice(0, 60),
    insight: String((input && input.insight) || '').slice(0, 500),
    tags: Array.isArray(input && input.tags) ? input.tags.map(String) : [],
    source: 'human',
    ts: new Date().toISOString()
  };
  list.push(rec);
  saveCustom(list.slice(-100));
  return rec;
}

function removePlaybook(id) {
  const list = loadCustom();
  const next = list.filter((x) => x.id !== id);
  saveCustom(next);
  return next.length < list.length;
}

/** 数据挖掘：生成数据型打法 */
function derive(snap) {
  const data = (snap && snap.data) || {};
  const ext = (snap && snap.ext && typeof snap.ext === 'object') ? snap.ext : {};
  const playbooks = [];

  // 1) 高毛利 + 有销量：用成本卡 + 近 7 日销量
  try {
    const { buildCostCard } = require('./recipe_cost');
    const recipes = Array.isArray(ext.recipes) ? ext.recipes : [];
    const sales = Array.isArray(data.sales) ? data.sales : [];
    const byName = {};
    for (const r of sales) {
      const n = String(r && (r.dish || r.name) || '').trim();
      if (n) byName[n] = (byName[n] || 0) + 1;
    }
    const rows = [];
    for (const rec of recipes) {
      const card = buildCostCard(rec, data);
      if (!card || card.gross_margin == null) continue;
      const vol = byName[rec.name] || byName[String(rec.name || '').replace(/（.*/, '')] || 0;
      rows.push({ name: rec.name, margin: card.gross_margin, vol, price: card.price });
    }
    if (rows.length) {
      rows.sort((a, b) => (b.margin * Math.log(1 + b.vol)) - (a.margin * Math.log(1 + a.vol)));
      const top = rows.slice(0, 3);
      playbooks.push({
        id: 'kb_star_combo',
        title: '高毛利爆品组合',
        insight: '按「毛利率 × 销量」排序的明星菜：' + top.map((x) => `${x.name}(${r1(x.margin)}%)`).join('、'),
        evidence: `基于 ${recipes.length} 道配方与近 7 日销量`,
        recommend: '把明星菜置顶收银台/套餐，用高毛利带动客单',
        route: 'm/analysis',
        tags: ['菜单', '毛利']
      });
    }
  } catch (e) { /* ignore */ }

  // 2) 损耗主因
  const loss = Array.isArray(ext.loss_reports) ? ext.loss_reports : [];
  if (loss.length) {
    const byReason = {};
    for (const r of loss) {
      const k = String(r && (r.reason || r.cause) || '未分类');
      byReason[k] = (byReason[k] || 0) + (parseFloat(r && (r.amount != null ? r.amount : r.total)) || 0);
    }
    const top = Object.keys(byReason).sort((a, b) => byReason[b] - byReason[a]).slice(0, 3);
    playbooks.push({
      id: 'kb_loss_cause',
      title: '损耗主因',
      insight: '报损集中在：' + top.map((k) => `${k} ¥${r1(byReason[k])}`).join('、'),
      evidence: `近 ${loss.length} 张报损单`,
      recommend: '按主因整改：过期→补货量调减；制作→分份规范；运输→包装改进',
      route: 'm/loss',
      tags: ['损耗']
    });
  }

  // 3) 低谷时段
  const sales = Array.isArray(data.sales) ? data.sales : [];
  if (sales.length) {
    const byHour = {};
    for (const r of sales) {
      const m = String(r && (r.date || r.ts || r.time || r.created_at) || '').match(/[T\s](\d{2}):/);
      if (m) byHour[m[1]] = (byHour[m[1]] || 0) + 1;
    }
    const hours = Object.keys(byHour).map(Number).sort((a, b) => a - b);
    if (hours.length) {
      const min = hours.reduce((a, b) => byHour[b] < byHour[a] ? b : a, hours[0]);
      const max = hours.reduce((a, b) => byHour[b] > byHour[a] ? b : a, hours[0]);
      playbooks.push({
        id: 'kb_low_hour',
        title: '低谷时段',
        insight: `单量最低 ${String(min).padStart(2, '0')}:00（${byHour[min]} 单），峰值 ${String(max).padStart(2, '0')}:00（${byHour[max]} 单）`,
        evidence: `基于 ${sales.length} 条销售流水`,
        recommend: '低谷时段上活动/券，分流高峰人力',
        route: 'm/analysis',
        tags: ['客流', '营销']
      });
    }
  }

  // 4) 配方/SOP 资产
  const recipes = Array.isArray(ext.recipes) ? ext.recipes : [];
  const steps = Array.isArray(ext.sop_steps) ? ext.sop_steps : [];
  if (recipes.length) {
    playbooks.push({
      id: 'kb_assets',
      title: '非遗配方/SOP 资产',
      insight: `已结构化 ${recipes.length} 道配方、${steps.length} 条工序`,
      evidence: '来自 recipes / sop_steps',
      recommend: '用配方标准约束出品；新人按 SOP 跟做，关键工艺点抽查',
      route: 'kitchen',
      tags: ['配方', 'SOP']
    });
  }

  return playbooks;
}

function all(snap) {
  return {
    ok: true,
    derived: derive(snap),
    custom: loadCustom(),
    rev: snap ? snap.rev : null,
    updated_at: new Date().toISOString()
  };
}

module.exports = { all, derive, addPlaybook, removePlaybook, loadCustom, FILE };
