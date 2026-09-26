import type {
  IngItem,
  InventoryDoc,
  QuoteItem,
  StockLogItem,
} from '../../api/types'

/** 原料库存 mock（/api/snapshot/latest 不可用兜底） */
export const MOCK_INGS: IngItem[] = [
  { id: 'I-m1', name: '火龙果汁', cat: '色源类', unit: 'kg', stock: 1.2, safe: 3, est: 1.5, avg: 28, on: true },
  { id: 'I-m2', name: '高筋面粉', cat: '主食类', unit: 'kg', stock: 48, safe: 20, est: 10, avg: 4.2, on: true },
  { id: 'I-m3', name: '菠菜汁', cat: '色源类', unit: 'kg', stock: 1.8, safe: 3, est: 1.5, avg: 22, on: true },
  { id: 'I-m4', name: '墨鱼汁', cat: '色源类', unit: 'kg', stock: 0.5, safe: 2, est: 1, avg: 65, on: true },
  { id: 'I-m5', name: '猪肉馅', cat: '肉类', unit: 'kg', stock: 15, safe: 10, est: 5, avg: 18, on: true },
  { id: 'I-m6', name: '东古一品鲜500ml', cat: '干调类', unit: '瓶', stock: 6, safe: 0, est: 0, avg: 12, on: true },
]

/** 进货单 JH mock */
export const MOCK_RECV: InventoryDoc[] = [
  {
    id: 'R-m1',
    no: 'JH-20260923-01',
    date: '2026-09-23',
    supplier: '绿源果蔬',
    payable: 720,
    method: '现金/转账',
    note: '配送单号示例',
    payments: [{ amount: 720, date: '2026-09-23', method: '现金/转账' }],
    lines: [
      { ing: 'I-m1', qty: 25, price: 28, amount: 700 },
      { ing: 'I-m3', qty: 1, price: 20, amount: 20 },
    ],
  },
]

export const MOCK_ORDERS: InventoryDoc[] = [
  {
    id: 'O-m1',
    no: 'CG-20260920-01',
    date: '2026-09-20',
    supplier: '金穗粮油',
    payable: 420,
    payments: [{ amount: 200, date: '2026-09-20', method: '微信' }],
    lines: [{ ing: 'I-m2', qty: 100, price: 4.2, amount: 420, recvQty: 50 }],
  },
]

export const MOCK_LOGS: StockLogItem[] = [
  {
    seq: 1,
    date: '2026-09-23',
    type: '采购入库',
    ing: 'I-m1',
    qty: 25,
    bal: 26.2,
    ref: 'JH-20260923-01',
  },
  {
    seq: 2,
    date: '2026-09-22',
    type: '销售出库',
    ing: 'I-m2',
    qty: -2.5,
    bal: 48,
    ref: 'XS-20260922-03',
  },
]

export const MOCK_QUOTES: QuoteItem[] = [
  { id: 'Q-m1', ing: 'I-m4', src: '1688·示例店', price: 58, date: '2026-09-18', note: 'mock' },
  { id: 'Q-m2', ing: 'I-m4', src: '本店最近采购', price: 65, date: '2026-09-10', note: '均价对照' },
]
