'use strict';
/*
 * seed_recipes.js — 熊猫五福餐厅 · 五福饺子配方种子脚本（seed_recipes.py 的 Node 移植）
 *
 * 从《金丰御字牌五福饺子(2).docx》解析结构化配方（zipread + 正则，纯标准库），
 * 按 PRD v1.0 附录 A 的 9 SKU 定义对齐命名，写入本地 SQLite 新表：
 *   - recipes        （INSERT OR REPLACE，幂等）
 *   - sop_steps      （INSERT OR REPLACE，按 sku_id+step_no 幂等）
 *   - sop_workorders （生成 1 条今日示范工单，已存在同日同 SKU 工单则跳过）
 *
 * 红线：
 *   - 只写新增表，绝不触碰 docs/snapshots 主数据与受保护 HTML。
 *   - 色源字段锁定：face_main 从 docx 面主料提取（扣除面粉/食盐基料），
 *     红色 SKU 强制校验必须含「火龙果」，否则中止写入（PRD：红色必须火龙果）。
 *   - 数值只取 docx 原文与 PRD 通用工艺参数，不编造。
 *
 * 用法：
 *   node seed_recipes.js                 # 解析 + 落库
 *   node seed_recipes.js --dry-run       # 只打印摘要不落库
 *   node seed_recipes.js --db 路径 --docx 路径
 *
 * 零第三方依赖：仅用 node:sqlite / node:fs / node:path / node:zlib（经 zipread）。
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { openZip } = require('./zipread');

const BASE_DIR = __dirname;
const DEFAULT_DB = path.join(BASE_DIR, '..', 'data', '餐厅系统.db');
const DEFAULT_DOCX = path.resolve(BASE_DIR, '..', '..', '..', 'old', 'root-assets',
  '金丰御字牌五福饺子(2).docx');

// ---------------------------------------------------------------------------
// 通用小工具（对齐 Python 语义）
// ---------------------------------------------------------------------------

/** 本地 ISO 秒级（对齐 datetime.now().isoformat(timespec="seconds")） */
function nowIsoLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** 本地日期（对齐 datetime.now().strftime("%Y-%m-%d")） */
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 模拟 Python round(x, nd)（含 +ε 破二进制 .5 歧义；用于整数/小数量） */
function pyRound(x, nd) {
  const f = Math.pow(10, nd);
  const eps = (x >= 0 ? 1 : -1) * 1e-12;
  return Math.round((x + eps) * f) / f;
}

/** 模拟 Python int(round(x))：对整数化结果取整 */
function pyRoundInt(x) {
  return Math.trunc(pyRound(x, 0));
}

/** Python str.rstrip(chars)：去掉尾部属于 chars 的任意字符 */
function rstripChars(s, chars) {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1])) end--;
  return s.slice(0, end);
}

/**
 * Python json.dumps(obj, ensure_ascii=False) 的等价实现。
 * Python 默认分隔符为 ", " 与 ": "（带空格），必须逐字对齐以保真落库文本。
 */
function jsonDumps(v) {
  if (v === null || v === undefined) return 'null';
  const t = typeof v;
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(v)) return 'NaN';
    return String(v);
  }
  if (t === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(jsonDumps).join(', ') + ']';
  if (t === 'object') {
    return '{' + Object.keys(v).map((k) => jsonDumps(k) + ': ' + jsonDumps(v[k])).join(', ') + '}';
  }
  throw new Error('无法序列化类型: ' + t);
}

// ---------------------------------------------------------------------------
// SKU 定义：与 PRD v1.0 附录 A 的 9 SKU 对齐
// key = (面皮色, 馅料名)；馅料名取自 docx 各节「辅料」行括号标注
// ---------------------------------------------------------------------------
const BLESSING = { 红: '长寿', 黄: '富贵', 绿: '康宁', 紫: '好德', 黑: '聚财', 白: '团圆' };

const SKU_DEFS = [
  // [color, filling, sku_id, 成品克重区间(docx 原文)]
  ['红', '猪肉冬菇荸荠馅', 'SKU-WF-HONG', [25, 27]],
  ['黄', '猪肉茴香大葱馅', 'SKU-WF-HUANG', [25, 27]],
  ['绿', '猪肉玉米馅', 'SKU-WF-LV', [25, 27]],
  ['紫', '猪肉香芹馅', 'SKU-WF-ZI', [25, 27]],
  ['黑', '猪肉三鲜馅', 'SKU-WF-HEI', [25, 27]],
  ['白', '猪肉酸菜馅', 'SKU-WF-BAI-SUANCAI', [25, 27]],
  ['白', '牛肉大葱馅', 'SKU-WF-BAI-NIUROU', [25, 27]],
  ['白', '西葫芦鸡蛋馅', 'SKU-WF-BAI-XIHULU', [25, 28]],
  ['白', '猪肉山药馅', 'SKU-WF-BAI-SHANYAO', [25, 28]],
];

// 面皮基料（金丰标准：一律以 500g 面粉起草一批）
const FACE_BASE = ['五得利雪花粉八星500g', '食盐3g'];

// 金丰标准 · 关键工艺参数（全 SKU 通用）
const COMMON_PARAMS = {
  剂子_g: [10, 11],
  馅_g: [14, 16],
  馅_中位_g: 15.5,
  一批面团_g: 723,     // 红黄绿白常见：500+220+3；紫/黑按面主料重算
  一批出成_理论: [66, 72],
  一批出成_个: 67,
  一批出成_中位: 69,
  醒发_min: 30,
  点凉水次数: 3,
  料水加入: '分三次加入，顺同一方向搅至上劲',
  褶纹: '12-14道',
  标准: '金丰标准',
  起草基准: '面粉500g=1倍标准量',
};

// 忌口/过敏原标签推导规则（由馅料成分直接推出，非编造）
const DIET_RULES = [
  ['猪', '含猪肉'], ['牛', '含牛肉'], ['虾仁', '含甲壳类(虾)'],
  ['鸡蛋', '含蛋'], ['木耳', '含菌菇'], ['冬菇', '含菌菇'], ['香菇', '含菌菇'],
];
const VEG_FILLINGS = ['西葫芦鸡蛋馅']; // 9 SKU 中唯一素馅（docx 标注「素」）

// ---------------------------------------------------------------------------
// docx 解析
// ---------------------------------------------------------------------------

/** 解出 word/document.xml，按段落去标签，返回干净文本行列表。 */
function docxParagraphs(docxPath) {
  const zip = openZip(docxPath);
  let xml = zip.read('word/document.xml').toString('utf8');
  xml = xml.replaceAll('</w:p>', '\n');
  xml = xml.replace(/<w:tab[^>]*\/>/g, '\t');
  let text = xml.replace(/<[^>]+>/g, '');
  for (const [a, b] of [['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'],
    ['&quot;', '"'], ['&apos;', "'"]]) {
    text = text.replaceAll(a, b);
  }
  return text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

/** 按顿号/逗号切分，但括号（）内的顿号不切开（避免料水配方被拆碎）。 */
function splitItems(s) {
  s = rstripChars(s.trim(), ';；。');
  const out = [];
  let buf = [];
  let depth = 0;
  for (const ch of s) {
    if (ch === '（' || ch === '(') {
      depth += 1;
      buf.push(ch);
    } else if (ch === '）' || ch === ')') {
      depth = Math.max(0, depth - 1);
      buf.push(ch);
    } else if ((ch === '、' || ch === '，' || ch === ',') && depth === 0) {
      const part = buf.join('').trim();
      if (part) out.push(part);
      buf = [];
    } else {
      buf.push(ch);
    }
  }
  const part = buf.join('').trim();
  if (part) out.push(part);
  return out;
}

/**
 * 把 docx 切成「御字牌五福饺子（X色）…」各节，提取：
 * 面主料/主料/辅料(含馅料名)/调料/制作方法步骤列表。
 * 返回 Map<"color/filling", {face, main, aux, seasoning, filling, steps}>
 * 另附 keys 数组保留 Python dict 的插入顺序（用于日志）。
 */
function parseSections(lines) {
  const headRe = /^御字牌五福饺子（(.+?)色）(?:（(.+?)）)?$/;
  // 仅在其它品项标题处截断（冰花煎饺/蒸饺/包子等），勿截断「御字牌五福饺子是…」正文
  const otherProductRe = /^御字牌(?!五福饺子)/;
  const sections = [];
  let cur = null;
  for (const line of lines) {
    const m = headRe.exec(line);
    if (m) {
      cur = { color: m[1], title_filling: m[2], lines: [] };
      sections.push(cur);
      continue;
    }
    if (cur !== null && otherProductRe.test(line)) {
      cur = null;
      continue;
    }
    if (cur !== null) cur.lines.push(line);
  }

  const out = new Map();
  const keys = [];
  for (const sec of sections) {
    const rec = { face: [], main: [], aux: [], seasoning: [], filling: sec.title_filling, steps: [] };
    let inSteps = false;
    for (const line of sec.lines) {
      if (line.startsWith('面主料：')) {
        rec.face = splitItems(line.slice('面主料：'.length));
      } else if (line.startsWith('主料：')) {
        rec.main = splitItems(line.slice('主料：'.length));
      } else if (line.startsWith('辅料：')) {
        let body = line.slice('辅料：'.length);
        const fm = /（(.+?馅)）/.exec(body);
        if (fm) {
          rec.filling = rec.filling || fm[1];
          body = body.slice(0, fm.index) + body.slice(fm.index + fm[0].length);
        }
        rec.aux = splitItems(body);
      } else if (line.startsWith('调料：')) {
        rec.seasoning = splitItems(line.slice('调料：'.length));
      } else if (line.startsWith('制作方法')) {
        inSteps = true;
      } else if (inSteps) {
        const sm = /^(\d+)[、.](.+)$/.exec(line);
        if (sm) {
          rec.steps.push(sm[2].trim());
        } else if (rec.steps.length > 0) {
          inSteps = false; // 步骤区结束
        }
      }
    }
    if (rec.filling) {
      const key = sec.color + '/' + rec.filling;
      if (!out.has(key)) keys.push(key); // 对齐 Python dict：重复键保留首次插入位置
      out.set(key, rec);
    }
  }
  return { map: out, keys };
}

/** 色源 = 面主料扣除基料（面粉/食盐）。色源字段锁定，写入后不得擅改。 */
function deriveFaceMain(faceItems) {
  const rest = faceItems.filter((x) => !FACE_BASE.includes(x));
  return rest.length ? rest.join('、') : '清水（本色）';
}

/** 金丰标准：面主料各克重合计（只认原文 g 数，不补料）。 */
function faceDoughGrams(faceItems) {
  let total = 0.0;
  const re = /(\d+(?:\.\d+)?)\s*g/gi;
  for (const x of faceItems) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(x)) !== null) total += parseFloat(m[1]);
  }
  return pyRoundInt(total);
}

/** 剂子 10–11g：理论区间 + 中位扣约 3% 下剂损耗 → 一批出成_个。 */
function batchYieldFromDoughG(doughG) {
  const lo = Math.floor(doughG / 11);
  const hi = Math.floor(doughG / 10);
  const mid = pyRound(doughG / 10.5, 0);
  const pcs = Math.max(1, pyRound(doughG / 10.5 * 0.97, 0));
  return [[lo, hi], mid, pcs];
}

function deriveDietTags(filling, main, aux) {
  const tags = [];
  const blob = filling + main.join('') + aux.join('');
  for (const [kw, tag] of DIET_RULES) {
    if (blob.includes(kw) && !tags.includes(tag)) tags.push(tag);
  }
  if (VEG_FILLINGS.includes(filling)) tags.unshift('素馅');
  return tags;
}

// ---------------------------------------------------------------------------
// SOP 工序推导：把 docx 逐步骤文本分类到 8 个阶段
// ---------------------------------------------------------------------------

// 顺序即优先级：装盘/剂子靠前，避免「无需醒发直接分割」「成品饺子皮…装盘」误判
const STAGE_RULES = [
  ['装盘', ['装盘', '捞出', '沥干']],
  ['剂子', ['剂子', '面剂', '下剂', '分割', '擀']],
  ['醒发', ['醒发']],
  ['和面', ['和面', '压面', '面团', '面坯', '破壁机', '打成泥', '打成汁', '烫面', '榨汁']],
  ['包制', ['捏合', '封口', '包制', '舀入', '置于饺皮', '置于面皮', '饺子皮中央', '托盘']],
  ['煮制', ['煮', '凉水', '沸腾', '浮起', '粘底', '勺背']],
  ['拌馅', ['搅拌', '上劲', '料油', '香油', '调味', '馅料', '翻拌', '拌匀']],
  ['备馅', ['绞', '切', '焯水', '挤', '泡', '炒熟', '晾凉', '备用', '熬煮', '滤']],
];

const QC_BY_STAGE = {
  和面: '面团表面光滑、色泽均匀无干粉',
  醒发: '醒发足 30 分钟',
  备馅: '刀工均匀、脱水到位',
  拌馅: '料水分三次加入、顺同一方向搅至上劲',
  剂子: '剂子称重 10-11g、擀皮中间厚边缘薄',
  包制: '成品 25-27g（白色部分 25-28g）、封口严密无漏馅、褶纹 12-14 道',
  煮制: '三次点凉水，浮起鼓胀出锅',
  装盘: '沥干不积水、五色错落',
};

const RISK_BY_STAGE = {
  和面: '色源比例偏差导致串色/色差',
  醒发: '醒发不足面皮僵硬易破',
  备馅: '脱水不净导致馅料泄汤',
  拌馅: '搅拌方向不一致导致馅料泄汤',
  剂子: '剂子超重导致皮馅比失衡',
  包制: '封口不严煮制漏馅',
  煮制: '点水不足内生/过度破皮浑汤',
  装盘: '余热积水泡烂饺皮',
};

const TOOL_KEYWORDS = ['破壁机', '压面机', '绞肉机', '拌馅盆', '和面盆', '馅料盆',
  '调馅容器', '平底锅', '蒸锅', '保鲜膜'];

function classifyStep(text) {
  for (const [stage, kws] of STAGE_RULES) {
    if (kws.some((k) => text.includes(k))) return stage;
  }
  return '备馅';
}

/** docx 步骤 → sop_steps 行。时长仅醒发 30min 有出处，其余留空不编造。 */
function buildSopSteps(skuId, steps) {
  const rows = [];
  steps.forEach((text, idx) => {
    const stage = classifyStep(text);
    const tools = TOOL_KEYWORDS.filter((t) => text.includes(t));
    rows.push({
      sku_id: skuId,
      step_no: idx + 1,
      stage: stage,
      duration_min: (text.includes('醒发') && text.includes('30')) ? 30 : null,
      tools: tools,
      inputs: [],
      key_points: text,
      qc_point: QC_BY_STAGE[stage] || '',
      risk: RISK_BY_STAGE[stage] || '',
      params: {},
    });
  });
  return rows;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function buildRecipes(docxPath) {
  const lines = docxParagraphs(docxPath);
  const parsed = parseSections(lines);
  const sections = parsed.map;
  log('docx 解析出色×馅小节 %d 个: %s', sections.size,
    JSON.stringify(parsed.keys));

  const recipes = [];
  const sop = [];
  const missing = [];
  for (const [color, filling, skuId, weight] of SKU_DEFS) {
    const rec = sections.get(color + '/' + filling);
    if (rec === undefined) {
      missing.push(color + '/' + filling);
      continue;
    }
    const faceMain = deriveFaceMain(rec.face);
    // 红线校验：红色必须火龙果（PRD 4.1.1 约束）
    if (color === '红' && !faceMain.includes('火龙果')) {
      throw new Error('红线触发：红色 SKU 色源不是火龙果（解析得 ' + JSON.stringify(faceMain) + '），中止写入');
    }
    const params = Object.assign({}, COMMON_PARAMS);
    params['成品_g'] = weight.slice();
    params['色源'] = faceMain;
    // 完整面主料（含面粉/盐）写入 params，供 BOM/算料；face_main 仍只存色源锁定字段
    params['面主料'] = rec.face.slice();
    // 金丰标准：面团克重 / 一批出成 严格按 Word 面主料合计，不另补清水
    const doughG = faceDoughGrams(rec.face);
    const [theory, mid, pcs] = batchYieldFromDoughG(doughG);
    params['一批面团_g'] = doughG;
    params['一批出成_理论'] = theory;
    params['一批出成_中位'] = mid;
    params['一批出成_个'] = pcs;
    if (color === '黑' && !rec.face.join('').includes('清水')) {
      // Word 黑色面主料仅墨鱼汁16g；总览括号曾写清水220g，标准以分色面主料为准
      params['色源说明'] = '金丰标准面主料为墨鱼汁16g（不含清水）；总览括号清水不计入本批';
    }
    recipes.push({
      sku_id: skuId,
      name: '御字牌五福饺子（' + color + '）（' + filling + '）',
      color: color,
      filling: filling,
      face_main: faceMain,
      main: rec.main,
      aux: rec.aux,
      seasoning: rec.seasoning,
      steps: rec.steps,
      params: params,
      blessing: BLESSING[color],
      diet_tags: deriveDietTags(filling, rec.main, rec.aux),
      version: 1,
      updated_at: nowIsoLocal(),
    });
    for (const row of buildSopSteps(skuId, rec.steps)) sop.push(row);
  }
  if (missing.length) {
    log('以下 SKU 在 docx 中未找到对应小节（未入库）: ' + JSON.stringify(missing));
  }
  return { recipes, sop };
}

// 与 migrations/001_new_tables.sql 中 recipes / sop_steps / sop_workorders 逐字一致
const SEED_DDL = `
CREATE TABLE IF NOT EXISTS recipes (
  sku_id      TEXT PRIMARY KEY,
  name        TEXT,
  color       TEXT,
  filling     TEXT,
  face_main   TEXT,
  main        TEXT,
  aux         TEXT,
  seasoning   TEXT,
  steps       TEXT,
  params      TEXT,
  blessing    TEXT,
  diet_tags   TEXT,
  version     INTEGER DEFAULT 1,
  updated_at  TEXT
);
CREATE TABLE IF NOT EXISTS sop_steps (
  sku_id       TEXT,
  step_no      INTEGER,
  stage        TEXT,
  duration_min REAL,
  tools        TEXT,
  inputs       TEXT,
  key_points   TEXT,
  qc_point     TEXT,
  risk         TEXT,
  params       TEXT,
  PRIMARY KEY (sku_id, step_no)
);
CREATE TABLE IF NOT EXISTS sop_workorders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  date          TEXT,
  sku_id        TEXT,
  qty           REAL,
  planned_start TEXT,
  status        TEXT DEFAULT '待开始',
  qc_records    TEXT
);
`;

function ensureTables(dbPath) {
  const conn = new DatabaseSync(dbPath);
  try {
    conn.exec(SEED_DDL);
  } finally {
    conn.close();
  }
}

function seed(dbPath, recipes, sop, dryRun) {
  console.log('== SKU 清单（' + recipes.length + ' 个）==');
  for (const r of recipes) {
    console.log('  ' + r.sku_id.padEnd(18) + ' ' + r.color + ' | ' + r.filling
      + ' | 寓意:' + r.blessing + ' | 色源:' + r.face_main
      + ' | 步骤:' + r.steps.length + ' | 忌口:' + r.diet_tags.join('/'));
  }
  console.log('sop_steps 共 ' + sop.length + ' 行');
  if (dryRun) {
    console.log('--dry-run：不落库');
    return;
  }

  ensureTables(dbPath);
  const conn = new DatabaseSync(dbPath);
  try {
    conn.exec('BEGIN');
    try {
      for (const r of recipes) {
        conn.prepare(
          'INSERT OR REPLACE INTO recipes'
          + ' (sku_id,name,color,filling,face_main,main,aux,seasoning,'
          + '  steps,params,blessing,diet_tags,version,updated_at)'
          + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
        ).run(r.sku_id, r.name, r.color, r.filling, r.face_main,
          jsonDumps(r.main), jsonDumps(r.aux), jsonDumps(r.seasoning),
          jsonDumps(r.steps), jsonDumps(r.params), r.blessing,
          jsonDumps(r.diet_tags), r.version, r.updated_at);
      }
      for (const s of sop) {
        conn.prepare(
          'INSERT OR REPLACE INTO sop_steps'
          + ' (sku_id,step_no,stage,duration_min,tools,inputs,'
          + '  key_points,qc_point,risk,params)'
          + ' VALUES (?,?,?,?,?,?,?,?,?,?)'
        ).run(s.sku_id, s.step_no, s.stage, s.duration_min,
          jsonDumps(s.tools), jsonDumps(s.inputs),
          s.key_points, s.qc_point, s.risk, jsonDumps(s.params));
      }
      // 今日示范工单：同日同 SKU 已存在则跳过（幂等）
      const today = todayStr();
      const demoSku = recipes.length ? recipes[0].sku_id : SKU_DEFS[0][2];
      const exists = conn.prepare(
        'SELECT COUNT(*) AS c FROM sop_workorders WHERE date=? AND sku_id=?'
      ).get(today, demoSku).c;
      if (!exists) {
        conn.prepare(
          'INSERT INTO sop_workorders'
          + ' (date,sku_id,qty,planned_start,status,qc_records)'
          + ' VALUES (?,?,?,?,?,?)'
        ).run(today, demoSku, 50, today + 'T10:00', '待开始', '[]');
        log('已生成今日示范工单: ' + today + ' ' + demoSku + ' qty=50 待开始');
      } else {
        log('今日示范工单已存在，跳过');
      }
      conn.exec('COMMIT');
    } catch (e) {
      conn.exec('ROLLBACK');
      throw e;
    }
    const nR = conn.prepare('SELECT COUNT(*) AS c FROM recipes').get().c;
    const nS = conn.prepare('SELECT COUNT(*) AS c FROM sop_steps').get().c;
    const nW = conn.prepare('SELECT COUNT(*) AS c FROM sop_workorders').get().c;
    console.log('落库完成: recipes=' + nR + ' sop_steps=' + nS
      + ' sop_workorders=' + nW + ' (db=' + dbPath + ')');
  } finally {
    conn.close();
  }
}

// 对齐 Python logging.basicConfig(level=INFO) 的默认输出格式
function log(msg, ...args) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ts = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    + ',' + String(d.getMilliseconds()).padStart(3, '0');
  let i = 0;
  const s = msg.replace(/%s|%d/g, () => String(args[i++]));
  console.log(ts + ' [INFO] seed_recipes: ' + s);
}

function parseArgs(argv) {
  const out = { db: DEFAULT_DB, docx: DEFAULT_DOCX, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') out.db = argv[++i];
    else if (a === '--docx') out.docx = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('未知参数: ' + a);
  }
  return out;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error('参数解析失败: ' + e.message);
    return 2;
  }
  if (args.help) {
    console.log('用法: node seed_recipes.js [--db 路径] [--docx 路径] [--dry-run]');
    return 0;
  }
  if (!fs.existsSync(args.docx)) {
    log('docx 不存在: ' + args.docx);
    return 1;
  }
  const { recipes, sop } = buildRecipes(args.docx);
  if (!recipes.length) {
    log('未解析到任何 SKU，中止');
    return 1;
  }
  seed(args.db, recipes, sop, args.dryRun);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  BLESSING, SKU_DEFS, FACE_BASE, COMMON_PARAMS, DIET_RULES, VEG_FILLINGS,
  STAGE_RULES, QC_BY_STAGE, RISK_BY_STAGE, TOOL_KEYWORDS,
  docxParagraphs, splitItems, parseSections, deriveFaceMain, faceDoughGrams,
  batchYieldFromDoughG, deriveDietTags, classifyStep, buildSopSteps,
  buildRecipes, ensureTables, seed, jsonDumps, main,
};
