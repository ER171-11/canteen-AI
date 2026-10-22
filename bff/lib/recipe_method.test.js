'use strict';
/*
 * lib/recipe_method.test.js — 标准配方卡「制作方法」归并的纯函数回归（零依赖，node 直跑）
 *
 * 覆盖 lib/recipe_method.js：
 *   · 红饺 20 条原文 → 和面 / 调馅 / 打水上劲 / 包制 / 煮制 5 段，段内顺序不乱
 *   · 备料句里的「捞出沥干」「盛出晾凉」不得误判成熟制（易错点）
 *   · 末段标签随做法：煎饺 → 煎制 / 蒸饺 → 蒸制 / 水饺 → 煮制
 *   · 素馅无料水 → 第三段显示「调味封油」
 *   · 空入参 → 空数组（不编造）
 *
 * 运行：node lib/recipe_method.test.js
 */
const assert = require('assert');
const { condenseMethod, classifyStage } = require('./recipe_method');

let failed = 0;
function ok(name, cond, got) {
  if (cond) { console.log('  ✓ ' + name); return; }
  failed++;
  console.error('  ✗ ' + name + '  got=' + JSON.stringify(got));
}

/* ---- 红饺 docx 原文 20 条（去序号）---- */
const RED_STEPS = [
  '将火龙果洗净去皮切块，用破壁机榨成汁备用。',
  '取五得利雪花粉八星500g置于和面盆中，加入食盐3g混合均匀。',
  '分次倒入火龙果汁220g，边倒边搅拌至絮状。',
  '用压面机将面团压制成红色面团，至表面光滑无干粉即可。',
  '将红色面团覆盖保鲜膜，醒发30分钟。',
  '将猪前肩肉去皮洗净，用绞肉机搅成肉馅备用。',
  '将冬菇洗净，切丁备用。',
  '将荸荠去皮，切丁备用。',
  '将葱花置于馅料盆中。',
  '加入食盐5g、白绵糖1g、王守义十三香1g、白胡椒粉1.5g、味精4g、家乐鸡精6g。',
  '加入海天蚝油20g、海天生抽18g、海天老抽10g。',
  '分三次加入料水200g，顺同一方向搅拌至馅料上劲。',
  '最后加入料油40g、香油13g，搅拌均匀后冷藏备用。',
  '加入拌好的猪前肩肉馅、冬菇、荸荠，混合均匀。',
  '将醒发好的红色面团搓条，下剂，每个剂子10-11g。',
  '将面剂按扁，擀制成中间厚边缘薄的圆形饺皮。',
  '取适量馅料置于饺皮中央，捏合边缘，制成褶纹规整的生饺，生饺的标准为25-27g。',
  '锅中加清水烧至沸腾，放入生饺，用勺背轻推防粘底。',
  '待水再次沸腾后加入少量清水，重复3次至饺子浮起。',
  '将煮熟的饺子捞出，沥干水分装盘。',
];

const red = condenseMethod(RED_STEPS);
ok('红饺归并 5 段', red.length === 5, red.map((x) => x.stage));
ok('段序 = 和面/调馅/打水上劲/包制/煮制',
  red.map((x) => x.stage).join('>') === '和面>调馅>打水上劲>包制>煮制', red.map((x) => x.stage));
ok('和面含取汁+醒发', red[0].text.indexOf('榨成汁') >= 0 && red[0].text.indexOf('醒发30分钟') >= 0, red[0].text);
ok('调馅含绞肉+调料+末条混合', red[1].text.indexOf('绞肉机') >= 0
  && red[1].text.indexOf('海天蚝油20g') >= 0 && red[1].text.indexOf('混合均匀') >= 0, red[1].text);
ok('打水上劲含料水+封油', red[2].text.indexOf('料水200g') >= 0 && red[2].text.indexOf('香油13g') >= 0, red[2].text);
ok('包制含剂子+擀皮+生饺', red[3].text.indexOf('剂子10-11g') >= 0
  && red[3].text.indexOf('擀制') >= 0 && red[3].text.indexOf('生饺') >= 0, red[3].text);
ok('煮制含点水+捞出装盘', red[4].text.indexOf('重复3次') >= 0 && red[4].text.indexOf('捞出') >= 0, red[4].text);
ok('段文本以句号收尾、无重复标点', red.every((x) => /。$/.test(x.text) && x.text.indexOf('。。') < 0), red.map((x) => x.text));

/* ---- 易错点：备料句不得判成熟制 ---- */
ok('白萝卜备料（含焯水捞出沥干）→ 调馅',
  classifyStage('将白萝卜擦丝，放入沸水锅中焯水，捞出后过滤沥干、挤净多余水分，再改刀切成细小颗粒，备用。') === '调馅');
ok('鸡蛋炒熟盛出 → 调馅',
  classifyStage('将鸡蛋入锅炒熟，炒至松散细碎状态后盛出晾凉备用。') === '调馅');
ok('面坯分割制剂 → 包制',
  classifyStage('压制完成的面坯无需醒发，直接进行分割处理，严格按照10-11g的标准制作单个饺子剂子。') === '包制');

/* ---- 末段标签随做法 ---- */
const zheng = condenseMethod(['盖上锅盖，保持大火蒸制10分钟，确保饺子内外熟透。']);
ok('蒸饺 → 蒸制', zheng.length === 1 && zheng[0].stage === '蒸制', zheng);
const jian = condenseMethod(['将蒸好的饺子整齐码放在锅中，均匀淋入冰花糊，中火煎制3分钟，待底部金黄酥脆，即可出锅装盘。']);
ok('煎饺 → 煎制', jian.length === 1 && jian[0].stage === '煎制', jian);

/* ---- 素馅封油 ---- */
const veg = condenseMethod(['淋入预制料油、古币牌香油，充分搅拌浸润馅料食材。']);
ok('素馅无料水 → 调味封油', veg.length === 1 && veg[0].stage === '调味封油', veg);

/* ---- 空入参 ---- */
ok('undefined → []', condenseMethod(undefined).length === 0);
ok('空数组 → []', condenseMethod([]).length === 0);

if (failed) {
  console.error('\nrecipe_method 测试失败 ' + failed + ' 项');
  process.exit(1);
}
console.log('\nrecipe_method.test.js 全部通过');
