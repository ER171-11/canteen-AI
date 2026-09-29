'use strict';
/*
 * lib/inspection_nodes.js — 闭店巡检标准节点主数据（C 块，共 50 个）
 *
 * 用户已确认：本轮**不做**点位配置界面，50 个标准节点按后端内置主数据处理，
 * 后端只读下发、App 只读展示。因此这里是唯一事实来源（single source of truth），
 * 调整节点必须同时改 `inspection_nodes.test.js` 里的数量与分组断言。
 *
 * 字段：
 *   id         稳定标识，写入 inspection_records.node_id，永不改（改即断历史台账）
 *   name       节点简短名，用于页面展示
 *   board      板块：后厨 / 前厅 / 仓库（负责到人的挂靠维度）
 *   node_group 节点分组：门窗 / 煤气 / 冰箱柜门 / 电源开关 / 水龙头 / 卫生间 / 卫生 / 消防 / 库房
 *   every30    true = 卫生间类节点，需每 30 分钟一次（替代纸质签到）
 *
 * 水印点位名统一用 fullName() 拼接为「板块-节点名」，避免同名节点混淆。
 */

const BOARDS = ['后厨', '前厅', '仓库'];

const NODES = [
  /* ---------- 后厨（20） ---------- */
  { id: 'K01', name: '外门锁闭', board: '后厨', node_group: '门窗', every30: false },
  { id: 'K02', name: '通后巷门插销', board: '后厨', node_group: '门窗', every30: false },
  { id: 'K03', name: '窗户关闭', board: '后厨', node_group: '门窗', every30: false },
  { id: 'K04', name: '燃气总阀关闭', board: '后厨', node_group: '煤气', every30: false },
  { id: 'K05', name: '灶具分阀关闭', board: '后厨', node_group: '煤气', every30: false },
  { id: 'K06', name: '燃气报警器通电', board: '后厨', node_group: '煤气', every30: false },
  { id: 'K07', name: '燃气管无泄漏', board: '后厨', node_group: '煤气', every30: false },
  { id: 'K08', name: '冷冻柜门闭合', board: '后厨', node_group: '冰箱柜门', every30: false },
  { id: 'K09', name: '冷藏柜门闭合', board: '后厨', node_group: '冰箱柜门', every30: false },
  { id: 'K10', name: '冰柜温度记录', board: '后厨', node_group: '冰箱柜门', every30: false },
  { id: 'K11', name: '备餐台电源关闭', board: '后厨', node_group: '电源开关', every30: false },
  { id: 'K12', name: '排烟罩电源关闭', board: '后厨', node_group: '电源开关', every30: false },
  { id: 'K13', name: '消毒柜电源关闭', board: '后厨', node_group: '电源开关', every30: false },
  { id: 'K14', name: '后厨总闸断电', board: '后厨', node_group: '电源开关', every30: false },
  { id: 'K15', name: '洗菜池水龙头关紧', board: '后厨', node_group: '水龙头', every30: false },
  { id: 'K16', name: '洗手池水龙头关紧', board: '后厨', node_group: '水龙头', every30: false },
  { id: 'K17', name: '排水地漏通畅', board: '后厨', node_group: '水龙头', every30: false },
  { id: 'K18', name: '灶台油污清理', board: '后厨', node_group: '卫生', every30: false },
  { id: 'K19', name: '垃圾桶清运加盖', board: '后厨', node_group: '卫生', every30: false },
  { id: 'K20', name: '灭蝇灯通电运行', board: '后厨', node_group: '卫生', every30: false },

  /* ---------- 前厅（18） ---------- */
  { id: 'F01', name: '正门锁闭', board: '前厅', node_group: '门窗', every30: false },
  { id: 'F02', name: '玻璃门地锁', board: '前厅', node_group: '门窗', every30: false },
  { id: 'F03', name: '侧窗关闭', board: '前厅', node_group: '门窗', every30: false },
  { id: 'F04', name: '卷帘门落锁', board: '前厅', node_group: '门窗', every30: false },
  { id: 'F05', name: '大厅总闸断电', board: '前厅', node_group: '电源开关', every30: false },
  { id: 'F06', name: '招牌灯电源关闭', board: '前厅', node_group: '电源开关', every30: false },
  { id: 'F07', name: '空调电源关闭', board: '前厅', node_group: '电源开关', every30: false },
  { id: 'F08', name: '音响与电视电源关闭', board: '前厅', node_group: '电源开关', every30: false },
  { id: 'F09', name: '收银台电源关闭', board: '前厅', node_group: '电源开关', every30: false },
  { id: 'F10', name: '茶水吧水龙头关紧', board: '前厅', node_group: '水龙头', every30: false },
  { id: 'F11', name: '马桶冲水正常', board: '前厅', node_group: '卫生间', every30: true },
  { id: 'F12', name: '洗手池水龙头关紧', board: '前厅', node_group: '水龙头', every30: true },
  { id: 'F13', name: '纸巾补充', board: '前厅', node_group: '卫生间', every30: true },
  { id: 'F14', name: '洗手液补充', board: '前厅', node_group: '卫生间', every30: true },
  { id: 'F15', name: '地面无水渍', board: '前厅', node_group: '卫生间', every30: true },
  { id: 'F16', name: '垃圾桶清空', board: '前厅', node_group: '卫生间', every30: true },
  { id: 'F17', name: '无异味', board: '前厅', node_group: '卫生间', every30: true },
  { id: 'F18', name: '镜面与台面清洁', board: '前厅', node_group: '卫生间', every30: true },

  /* ---------- 仓库（12） ---------- */
  { id: 'C01', name: '库门锁闭', board: '仓库', node_group: '门窗', every30: false },
  { id: 'C02', name: '仓库窗关闭', board: '仓库', node_group: '门窗', every30: false },
  { id: 'C03', name: '冷库门闭合', board: '仓库', node_group: '冰箱柜门', every30: false },
  { id: 'C04', name: '货架电源关闭', board: '仓库', node_group: '电源开关', every30: false },
  { id: 'C05', name: '仓库总闸断电', board: '仓库', node_group: '电源开关', every30: false },
  { id: 'C06', name: '除湿机电源关闭', board: '仓库', node_group: '电源开关', every30: false },
  { id: 'C07', name: '洗消间水龙头关紧', board: '仓库', node_group: '水龙头', every30: false },
  { id: 'C08', name: '消防通道畅通', board: '仓库', node_group: '消防', every30: false },
  { id: 'C09', name: '灭火器压力正常', board: '仓库', node_group: '消防', every30: false },
  { id: 'C10', name: '原料离地存放', board: '仓库', node_group: '库房', every30: false },
  { id: 'C11', name: '防鼠板到位', board: '仓库', node_group: '库房', every30: false },
  { id: 'C12', name: '钥匙柜上锁', board: '仓库', node_group: '库房', every30: false }
];

/** 全部节点（副本，防外部改写主数据） */
function all() {
  return NODES.map((n) => Object.assign({}, n));
}

/** 按板块取节点；未知板块返回空数组 */
function byBoard(board) {
  const b = String(board === undefined || board === null ? '' : board).trim();
  return all().filter((n) => n.board === b);
}

/** 按 id 取节点；未知返回 null（算法层据此驳回非法节点） */
function byId(id) {
  const s = String(id === undefined || id === null ? '' : id).trim();
  if (!s) return null;
  const hit = NODES.find((n) => n.id === s);
  return hit ? Object.assign({}, hit) : null;
}

/** 每 30 分钟需记录的节点（卫生间类） */
function every30Nodes() {
  return all().filter((n) => n.every30 === true);
}

/** 分组清单，用于 App 页面的分组卡片 */
function groups() {
  const seen = [];
  NODES.forEach((n) => { if (seen.indexOf(n.node_group) < 0) seen.push(n.node_group); });
  return seen;
}

/** 水印点位名：板块-节点名，避免同名节点混淆 */
function fullName(node) {
  if (!node) return '';
  return String(node.board || '') + '-' + String(node.name || '');
}

module.exports = {
  BOARDS,
  NODES,
  TOTAL: NODES.length,
  all,
  byBoard,
  byId,
  every30Nodes,
  groups,
  fullName
};
