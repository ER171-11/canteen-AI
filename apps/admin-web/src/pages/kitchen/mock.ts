import type {
  Dish,
  KitchenBoardItem,
  QcRecord,
  RecipeItem,
  SopStep,
  WorkOrder,
} from '../../api/types'

/** 菜品菜单 mock（真实数据 86 道来自 /api/admin/dishes，此处仅兜底样例） */
export const MOCK_DISHES: Dish[] = [
  { id: 'D01', cat: '五福饺', name: '红色五福饺', est: 6.5, price: 32, q: 58, on: true },
  { id: 'D02', cat: '五福饺', name: '黄色五福饺', est: 6.0, price: 32, q: 45, on: true },
  { id: 'D03', cat: '五福饺', name: '黑色五福饺', est: 7.0, price: 36, q: 21, on: false },
  { id: 'D75', cat: '引流', name: '老虎菜', est: 4.5, price: 18, q: 4, on: true },
  { id: 'D80', cat: '招牌', name: '御膳拼盘', est: 18.0, price: 68, q: 12, on: true },
]

export const MOCK_RECIPES: RecipeItem[] = [
  {
    sku_id: 'SKU-R01',
    name: '红色五福饺',
    color: 'red',
    filling: '猪肉白菜馅',
    face_main: [
      { material: '火龙果汁', qty: 120, unit: 'g' },
      { material: '高筋面粉', qty: 500, unit: 'g' },
    ],
    main: [
      { material: '猪肉馅', qty: 800, unit: 'g' },
      { material: '白菜', qty: 600, unit: 'g' },
    ],
    aux: [{ material: '葱姜水', qty: 100, unit: 'g' }],
    seasoning: [
      { material: '盐', qty: 8, unit: 'g' },
      { material: '香油', qty: 15, unit: 'g' },
    ],
    steps: ['和面（火龙果汁入面）', '醒发 30min', '备馅', '拌馅', '剂子 12g', '包制 18 褶', '煮制点水三次', '装盘五色齐整'],
    params: { 成品重: '25-27g', 褶纹数: 18, 煮制时间: '8min', 醒发时间: '30min' },
    blessing: '红红火火，鸿运当头',
    diet_tags: ['含麸质', '含猪肉'],
    version: 'v1.2',
    updated_at: '2026-09-20T08:00:00Z',
  },
  {
    sku_id: 'SKU-Y01',
    name: '黄色五福饺',
    color: 'yellow',
    filling: '三鲜馅',
    face_main: [
      { material: '南瓜泥', qty: 150, unit: 'g' },
      { material: '高筋面粉', qty: 500, unit: 'g' },
    ],
    main: [{ material: '虾仁', qty: 400, unit: 'g' }],
    aux: [{ material: '鸡蛋', qty: 100, unit: 'g' }],
    seasoning: [{ material: '盐', qty: 7, unit: 'g' }],
    steps: ['和面（南瓜泥入面）', '醒发 30min', '包制', '煮制'],
    params: { 成品重: '25-27g' },
    blessing: '金玉满堂，财源广进',
    diet_tags: ['含麸质', '含虾'],
    version: 'v1.1',
    updated_at: '2026-09-18T08:00:00Z',
  },
  {
    sku_id: 'SKU-K01',
    name: '黑色五福饺',
    color: 'black',
    filling: '墨鱼鲜肉馅',
    face_main: [
      { material: '墨鱼汁', qty: 30, unit: 'g' },
      { material: '高筋面粉', qty: 500, unit: 'g' },
    ],
    main: [{ material: '墨鱼肉', qty: 500, unit: 'g' }],
    aux: [],
    seasoning: [{ material: '白胡椒', qty: 3, unit: 'g' }],
    steps: ['和面（墨鱼汁入面）', '醒发 30min', '包制', '煮制'],
    params: { 成品重: '25-27g' },
    blessing: '稳如泰山，基业长青',
    diet_tags: ['含麸质', '含海鲜'],
    version: 'v1.0',
    updated_at: '2026-09-15T08:00:00Z',
  },
]

export const MOCK_SOP_STEPS: SopStep[] = [
  { step_no: 1, stage: '和面', duration_min: 15, tools: '和面机', inputs: '高筋面粉 500g + 火龙果汁 120g', key_points: '色汁分三次加入，色泽均匀', qc_point: '面色均匀无白粉', risk: '色汁过量导致面皮过软' },
  { step_no: 2, stage: '醒发', duration_min: 30, tools: '醒发箱', inputs: '面团盖湿布', key_points: '温度 28℃ 湿度 75%', qc_point: '指压回弹', risk: '醒发不足面皮易裂' },
  { step_no: 3, stage: '备馅', duration_min: 20, tools: '绞肉机/砧板', inputs: '猪肉 800g 白菜 600g', key_points: '白菜杀水挤干', qc_point: '馅料无水分析出', risk: '出水导致破皮' },
  { step_no: 4, stage: '拌馅', duration_min: 10, tools: '搅拌盆', inputs: '调料按 BOM', key_points: '顺一个方向搅打上劲', qc_point: '馅黏弹性足', risk: '搅拌不足馅散' },
  { step_no: 5, stage: '剂子', duration_min: 10, tools: '电子秤', inputs: '醒发面团', key_points: '每剂 12g±0.5g', qc_point: '抽检 10 剂误差 ≤0.5g', risk: '大小不均影响成品重' },
  { step_no: 6, stage: '包制', duration_min: 25, tools: '擀面杖', inputs: '剂子+馅', key_points: '18 褶，褶纹均匀', qc_point: '褶纹规整度 ≥90%', risk: '封口不严煮制开口' },
  { step_no: 7, stage: '煮制', duration_min: 8, tools: '煮饺炉', inputs: '沸水', key_points: '点水三次，浮起后再煮 1min', qc_point: '成品重 25-27g', risk: '过火破皮' },
  { step_no: 8, stage: '装盘', duration_min: 3, tools: '五福盘', inputs: '成品饺', key_points: '五色齐整，宫廷点缀', qc_point: '配色齐整=pass', risk: '缺色需补齐再出餐' },
]

export const MOCK_WORKORDERS: WorkOrder[] = [
  {
    id: 'WO-20260924-01',
    sku_id: 'SKU-R01',
    name: '红色五福饺',
    color: 'red',
    qty: 200,
    planned_start: '09:00',
    status: '已完成',
    steps: MOCK_SOP_STEPS,
  },
  {
    id: 'WO-20260924-02',
    sku_id: 'SKU-Y01',
    name: '黄色五福饺',
    color: 'yellow',
    qty: 150,
    planned_start: '14:00',
    status: '进行中',
    steps: MOCK_SOP_STEPS,
  },
  {
    id: 'WO-20260924-03',
    sku_id: 'SKU-K01',
    name: '黑色五福饺',
    color: 'black',
    qty: 100,
    planned_start: '16:30',
    status: '待开始',
    steps: MOCK_SOP_STEPS,
  },
]

export const MOCK_QC_RECORDS: QcRecord[] = [
  { id: 'QC-001', workorder_id: 'WO-20260924-01', sku_id: 'SKU-R01', sample_weight: 26.1, pass: true, ts: '2026-09-24T10:20:00Z', source: 'Kimi视觉' },
  { id: 'QC-002', workorder_id: 'WO-20260924-01', sku_id: 'SKU-R01', sample_weight: 24.3, pass: false, ts: '2026-09-24T10:40:00Z', source: '人工抽检' },
  { id: 'QC-003', workorder_id: 'WO-20260924-02', sku_id: 'SKU-Y01', sample_weight: 25.8, pass: true, ts: '2026-09-24T15:05:00Z', source: 'Kimi视觉' },
]

export const MOCK_BOARD: KitchenBoardItem[] = [
  { color: 'red', planned: 200, done: 200, qc_pass_rate: 95 },
  { color: 'yellow', planned: 150, done: 80, qc_pass_rate: 97 },
  { color: 'green', planned: 120, done: 0, qc_pass_rate: 0 },
  { color: 'purple', planned: 120, done: 0, qc_pass_rate: 0 },
  { color: 'black', planned: 100, done: 0, qc_pass_rate: 0 },
]
