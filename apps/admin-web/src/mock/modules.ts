import type { AnalysisResp, BookingResp, FoodsafeResp, StaffModuleResp } from '../api/types'

const today = new Date().toISOString().slice(0, 10)

/** 今日预订 mock（/api/modules/booking 未上线兜底） */
export const MOCK_BOOKING: BookingResp = {
  ok: true,
  date: today,
  bookings: [
    { time: '11:30', name: '王女士', people: 4, phone: '138****2201', table_type: '四人桌', status: '已确认' },
    { time: '12:00', name: '李先生', people: 2, phone: '139****8867', table_type: '两人桌', status: '已确认' },
    { time: '18:30', name: '张先生', people: 8, phone: '137****5543', table_type: '包间', status: '待确认' },
  ],
  queue: [
    { no: 'A12', people: 2, status: '等位中' },
    { no: 'A13', people: 4, status: '等位中' },
  ],
  rev: 'mock',
}

/** 食安模块 mock（/api/modules/foodsafe 未上线兜底） */
export const MOCK_FOODSAFE: FoodsafeResp = {
  ok: true,
  certs: [
    { type: '营业执照', name: '熊猫五福餐厅营业执照', expire_days: 320 },
    { type: '食品经营许可证', name: '食品经营许可证', expire_days: 180 },
    { type: '消防许可证', name: '消防安全检查合格证', expire_days: 45 },
    { type: '排污许可证', name: '排污许可证', expire_days: 25 },
    { type: '健康证', name: '张三', expire_days: 12 },
    { type: '健康证', name: '李四', expire_days: 88 },
    { type: '健康证', name: '王五', expire_days: 200 },
  ],
  trace: [
    { batch: 'PH20260920-01', ing: '火龙果', vendor: '绿源果蔬', result: '合格' },
    { batch: 'PH20260921-03', ing: '高筋面粉', vendor: '金穗粮油', result: '合格' },
    { batch: 'PH20260922-02', ing: '墨鱼汁', vendor: '海滋味供应链', result: '待复检' },
  ],
  samples: [
    { dish: '红色五福饺', weight: 128, ts: `${today}T09:30:00Z`, hours_left: 30 },
    { dish: '黄色五福饺', weight: 126, ts: `${today}T10:00:00Z`, hours_left: 10 },
    { dish: '黑色五福饺', weight: 125, ts: `${today}T11:00:00Z`, hours_left: 40 },
  ],
  disinfect: [
    { area: '后厨操作台', ts: `${today}T08:00:00Z`, operator: '赵六', pass: true },
    { area: '冷藏柜', ts: `${today}T08:20:00Z`, operator: '赵六', pass: true },
    { area: '前厅餐具', ts: `${today}T09:00:00Z`, operator: '钱七', pass: false },
  ],
  rev: 'mock',
}

/** 员工模块 mock（/api/modules/staff 未上线兜底） */
export const MOCK_STAFF: StaffModuleResp = {
  ok: true,
  shifts: [
    { staff_name: '宋师傅', role: '厨师', date: today, shift: '早班', start_time: '09:00', end_time: '17:00' },
    { staff_name: '李厨师长', role: '厨师长', date: today, shift: '早班', start_time: '09:00', end_time: '17:00' },
    { staff_name: '王师傅', role: '厨师', date: today, shift: '中班', start_time: '11:00', end_time: '21:00' },
    { staff_name: '张师傅', role: '厨师', date: today, shift: '晚班', start_time: '14:00', end_time: '23:00' },
  ],
  clock: [
    { staff_name: '宋师傅', ts: `${today} 08:58`, kind: '上班', status: '准点' },
    { staff_name: '李厨师长', ts: `${today} 09:02`, kind: '上班', status: '准点' },
    { staff_name: '王师傅', ts: `${today} 11:12`, kind: '上班', status: '迟到' },
  ],
  perf: [
    { staff_name: '李厨师长', score: 98.5, hours: 45, remark: '出品 412 份' },
    { staff_name: '宋师傅', score: 96.8, hours: 48, remark: '出品 386 份' },
    { staff_name: '赵店长', score: 95.2, hours: 48, remark: '服务 0 差评' },
  ],
  train: [
    { staff_name: '李厨师长', course: '红饺 SOP', passed: 1, remark: '已通过 5/5' },
    { staff_name: '王师傅', course: '黑饺 SOP', passed: 0, remark: '进行中 3/5' },
  ],
  rev: 'mock',
}

/** 经营分析 mock（/api/modules/analysis 未上线兜底） */
export const MOCK_ANALYSIS: AnalysisResp = {
  ok: true,
  mock: true,
  trend: [
    { week: 'W35', revenue: 52000, gross_rate: 39.2 },
    { week: 'W36', revenue: 53800, gross_rate: 39.8 },
    { week: 'W37', revenue: 55900, gross_rate: 40.0 },
    { week: 'W38', revenue: 58210, gross_rate: 40.1 },
  ],
  heatmap: [
    { hour: 11, weekday: 1, orders: 22, revenue: 968 },
    { hour: 12, weekday: 1, orders: 48, revenue: 2112 },
    { hour: 18, weekday: 5, orders: 55, revenue: 2420 },
    { hour: 19, weekday: 6, orders: 72, revenue: 3168 },
  ],
  matrix: [
    { name: '红·长寿', quadrant: 'star', volume: 486, margin: 62 },
    { name: '黑·聚财', quadrant: 'puzzle', volume: 413, margin: 38 },
    { name: '白·团圆', quadrant: 'cow', volume: 315, margin: 58 },
    { name: '紫·好德', quadrant: 'dog', volume: 289, margin: 33 },
  ],
  efficiency: { 翻台率: 3.2, 坪效: 680, 人效: 648, 营收环比: '+4.2%' },
}
