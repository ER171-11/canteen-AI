'use strict';
/*
 * lib/foodsafety.test.js — 留样管理纯逻辑回归（零依赖，node 直跑）
 *
 * 覆盖 lib/foodsafety.js 的留样部分（M4-T4）：
 *   · needWeight：饺子 ≥125g / 其余（热菜）≥200g
 *   · weightCheck：pass / warn / fail / unknown（缺失）
 *   · sampleState：待销毁 green → 2h 内到期 yellow → 已超期 red → 已销毁 done
 *   · sampleReport：存放温度 0–8℃ 越界告警、空值向后兼容（历史数据不告警）、temp_out 统计
 *
 * 运行：node lib/foodsafety.test.js
 */
const assert = require('assert');
const fs = require('./foodsafety');

let failed = 0;
function ok(name, cond, got) {
  if (cond) { console.log('  ✓ ' + name); return; }
  failed++;
  console.error('  ✗ ' + name + '  got=' + JSON.stringify(got));
}

const H = 3600000;
const T0 = Date.parse('2026-10-10T04:00:00.000Z'); // 固定基准：2026-10-10 12:00 北京时间
const iso = (t) => new Date(t).toISOString();

/* ---- needWeight 克重下限 ---- */
ok('needWeight 饺子 → 125', fs.needWeight('长寿饺') === 125, fs.needWeight('长寿饺'));
ok('needWeight 热菜/其他 → 200', fs.needWeight('红烧肉') === 200 && fs.needWeight('拍黄瓜') === 200, fs.needWeight('红烧肉'));

/* ---- weightCheck 克重校验 ---- */
ok('weightCheck 饺子 124 → fail', fs.weightCheck('长寿饺', 124).level === 'fail', fs.weightCheck('长寿饺', 124));
ok('weightCheck 饺子 130 → warn（125+5 临界）', fs.weightCheck('长寿饺', 130).level === 'warn', fs.weightCheck('长寿饺', 130));
ok('weightCheck 饺子 131 → pass', fs.weightCheck('长寿饺', 131).level === 'pass', fs.weightCheck('长寿饺', 131));
ok('weightCheck 热菜 199 → fail', fs.weightCheck('红烧肉', 199).level === 'fail', fs.weightCheck('红烧肉', 199));
ok('weightCheck 热菜 205 → warn', fs.weightCheck('红烧肉', 205).level === 'warn', fs.weightCheck('红烧肉', 205));
ok('weightCheck 热菜 206 → pass', fs.weightCheck('红烧肉', 206).level === 'pass', fs.weightCheck('红烧肉', 206));
ok('weightCheck 缺失 → unknown + error', fs.weightCheck('红烧肉', 0).level === 'unknown' && !!fs.weightCheck('红烧肉', 0).error, fs.weightCheck('红烧肉', 0));

/* ---- sampleState 48h 状态机 ---- */
ok('sampleState 刚登记 → green 待销毁 48h', (() => { const s = fs.sampleState({ kept_at: iso(T0) }, T0); return s.level === 'green' && s.hours_left === 48 && s.status === '待销毁'; })(), fs.sampleState({ kept_at: iso(T0) }, T0));
ok('sampleState 49h → red 已超期 -1h', (() => { const s = fs.sampleState({ kept_at: iso(T0 - 49 * H) }, T0); return s.level === 'red' && s.hours_left === -1 && s.status === '已超期'; })(), fs.sampleState({ kept_at: iso(T0 - 49 * H) }, T0));
ok('sampleState 46.5h → yellow 2h 内到期 1.5h', (() => { const s = fs.sampleState({ kept_at: iso(T0 - 46.5 * H) }, T0); return s.level === 'yellow' && s.hours_left === 1.5 && s.status === '2h 内到期'; })(), fs.sampleState({ kept_at: iso(T0 - 46.5 * H) }, T0));
ok('sampleState 已销毁 → done', (() => { const s = fs.sampleState({ kept_at: iso(T0 - 3 * H), cleared_at: iso(T0 - 1 * H) }, T0); return s.level === 'done' && s.status === '已销毁'; })(), fs.sampleState({ kept_at: iso(T0 - 3 * H), cleared_at: iso(T0 - 1 * H) }, T0));
ok('sampleState 无起始时刻 → unknown', fs.sampleState({}, T0).level === 'unknown', fs.sampleState({}, T0));

/* ---- sampleReport 温度越界告警 + 空值兼容 ---- */
const ext = {
  fs_samples: [
    { id: 1, date: '2026-10-10', meal: '午餐', dish: '长寿饺', weight_g: 130, keeper: '张三', kept_at: iso(T0), hold_temp: 4.5, sealed_by: '张三/李四' },
    { id: 2, date: '2026-10-08', meal: '午餐', dish: '红烧肉', weight_g: 200, keeper: '李四', kept_at: iso(T0 - 49 * H), hold_temp: 9.5, sealed_by: '王五' },
    { id: 3, date: '2026-10-08', meal: '晚餐', dish: '拍黄瓜', weight_g: 220, keeper: '王五', kept_at: iso(T0 - 46.5 * H), hold_temp: null, sealed_by: null },
    { id: 4, date: '2026-10-09', meal: '午餐', dish: '宫保鸡丁', weight_g: 90, keeper: '张三', kept_at: iso(T0 - 3 * H), cleared_at: iso(T0 - 1 * H), hold_temp: 3, sealed_by: '赵六' },
  ],
};
const rep = fs.sampleReport(ext, T0);

ok('sampleReport 4 行', rep.rows.length === 4, rep.rows.length);
const a = rep.rows.find((r) => r.id === 1);
const b = rep.rows.find((r) => r.id === 2);
const c = rep.rows.find((r) => r.id === 3);
const d = rep.rows.find((r) => r.id === 4);

ok('温度正常（4.5）→ ok + 透出 hold_temp/sealed_by', a.temp_level === 'ok' && a.hold_temp === 4.5 && a.sealed_by === '张三/李四', a);
ok('温度越界（9.5）→ out', b.temp_level === 'out' && b.hold_temp === 9.5, b);
ok('温度缺失 → unknown 且 hold_temp=null（向后兼容）', c.temp_level === 'unknown' && c.hold_temp === null && c.sealed_by === null, c);
ok('已销毁 + 克重 90<200 → done + fail', d.level === 'done' && d.weight_level === 'fail' && d.temp_level === 'ok', d);

ok('summary.temp_out = 1（仅 9.5 越界）', rep.summary.temp_out === 1, rep.summary.temp_out);
ok('summary.expired=1 / due_soon=1 / cleared=1 / under_weight=1',
  rep.summary.expired === 1 && rep.summary.due_soon === 1 && rep.summary.cleared === 1 && rep.summary.under_weight === 1, rep.summary);

const outReminder = rep.reminders.find((r) => r.level === 'out');
ok('reminders 含温度越界文案（红烧肉 9.5℃ 超 0–8℃）', !!outReminder && outReminder.dish === '红烧肉' && outReminder.text.indexOf('9.5') >= 0, outReminder);
ok('reminders 不含温度缺失项（空值不告警）', !rep.reminders.some((r) => r.level === 'out' && r.dish === '拍黄瓜'), rep.reminders);

/* ---- 空快照安全回退 ---- */
const empty = fs.sampleReport(null, T0);
ok('sampleReport 空快照 → 空 rows / 全 0 统计', empty.rows.length === 0 && empty.summary.total === 0 && empty.summary.temp_out === 0, empty.summary);

if (failed) { console.error('\n✗ ' + failed + ' 项失败'); process.exit(1); }
console.log('\n✓ foodsafety.test.js 全部通过');
