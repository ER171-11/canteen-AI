'use strict';
/*
 * lib/recipe_method.js — 标准配方卡「METHOD · 制作方法」归并（只读纯函数）
 *
 * 背景：docx 逐条 SOP（红饺 20 条）直接铺在配方卡上太像流水账，包饺子显得复杂。
 * 对齐《金丰菜品标准卡 standard receipe card》的口径，把逐条步骤按工艺段归并为
 * 5 段：和面 → 调馅 → 打水上劲 → 包制 → 熟制（煎饺=煎制 / 蒸饺=蒸制 / 水饺=煮制）。
 * 段内按原文顺序用「；」拼接成一段话，**不改原文用词与用量**，只换行/分组。
 *
 * 判定顺序即优先级：先判「熟制 / 包制」等特征强的词，避免被「馅 / 面」泛词误吃
 * （例：备料句里的「捞出沥干」「盛出晾凉」不得判成煮制）。
 *
 * 运行自检：node lib/recipe_method.test.js
 */

/** 段序（输出顺序固定：和面 → 调馅 → 打水上劲 → 包制 → 熟制） */
const STAGE_ORDER = ['和面', '调馅', '打水上劲', '包制', '熟制'];

const STAGE_RULES = [
  // 熟制：必须指向「成品饺子下锅/上屉/下铛」这一步，故只认成品相关词。
  // 注意不吃「生饺」——包制句（捏合边缘，制成…生饺）也含此词。
  ['熟制', ['下饺', '饺子浮起', '浮起', '点凉水', '凉水', '捞出沥', '沥水装盘',
    '装盘', '蒸制', '煎制', '勺背', '防粘底', '再次沸腾']],
  // 包制：剂子/擀皮/包捏
  ['包制', ['剂子', '面剂', '搓条', '下剂', '擀', '饺皮', '面皮', '包入', '包制', '捏合',
    '封口', '生饺', '褶纹', '托盘', '月牙', '按扁', '分割']],
  // 打水上劲：料水打馅 + 油封
  ['打水上劲', ['料水', '上劲', '料油', '香油', '锁住']],
  // 和面：果蔬取汁 + 面粉和面 + 压面醒发
  ['和面', ['和面', '压面', '面团', '面坯', '面絮', '絮状', '醒发', '醒面', '榨成汁',
    '打成汁', '打成泥', '取汁', '雪花粉', '面粉', '烫面']],
  // 调馅：备料刀工 + 调味拌匀（兜底）
  ['调馅', ['绞', '剁', '切', '丁', '末', '丝', '焯水', '挤干', '调料', '拌匀', '搅拌',
    '馅', '蚝油', '生抽', '老抽', '食盐', '白糖', '绵糖', '十三香', '味精', '鸡精',
    '胡椒粉', '备用']],
];

const DEFAULT_STAGE = '调馅';

/** 单条步骤 → 工艺段 */
function classifyStage(text) {
  const s = String(text == null ? '' : text);
  for (const [stage, kws] of STAGE_RULES) {
    for (const k of kws) {
      if (s.indexOf(k) >= 0) return stage;
    }
  }
  return DEFAULT_STAGE;
}

/** 熟制段标签：煎饺 → 煎制 / 蒸饺 → 蒸制 / 水饺 → 煮制 */
function cookedLabel(text) {
  const s = String(text == null ? '' : text);
  if (s.indexOf('煎') >= 0) return '煎制';
  if (s.indexOf('蒸') >= 0) return '蒸制';
  return '煮制';
}

/** 打水段标签：有料水/上劲 → 打水上劲；素馅只封油 → 调味封油 */
function waterLabel(text) {
  const s = String(text == null ? '' : text);
  return (s.indexOf('上劲') >= 0 || s.indexOf('料水') >= 0) ? '打水上劲' : '调味封油';
}

/**
 * 逐条步骤 → [{stage, text}]
 * @param steps string[]  docx/DB 原文步骤（已去「1、」序号）
 * @returns [{stage:'和面', text:'将火龙果…；取五得利…。'}, …]（按段序，空段不输出）
 */
function condenseMethod(steps) {
  const list = Array.isArray(steps) ? steps : (steps == null ? [] : [steps]);
  const bucket = new Map();
  for (const raw of list) {
    const t = String(raw == null ? '' : raw).trim().replace(/[。；;、\s]+$/, '');
    if (!t) continue;
    const stage = classifyStage(t);
    if (!bucket.has(stage)) bucket.set(stage, []);
    bucket.get(stage).push(t);
  }
  const out = [];
  for (const stage of STAGE_ORDER) {
    const items = bucket.get(stage);
    if (!items || !items.length) continue;
    const text = items.join('；') + '。';
    const label = stage === '熟制' ? cookedLabel(text)
      : (stage === '打水上劲' ? waterLabel(text) : stage);
    out.push({ stage: label, text });
  }
  return out;
}

module.exports = { condenseMethod, classifyStage, STAGE_ORDER, STAGE_RULES };
