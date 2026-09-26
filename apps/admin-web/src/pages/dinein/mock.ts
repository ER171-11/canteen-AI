import type { PosTable } from '../../api/types'

/** 桌台 mock（快照 pos 为空时兜底，9 桌四态） */
export const MOCK_TABLES: PosTable[] = [
  { id: 'T01', name: 'A1', seats: 2, status: '空闲' },
  { id: 'T02', name: 'A2', seats: 2, status: '就餐' },
  { id: 'T03', name: 'A3', seats: 4, status: '就餐' },
  { id: 'T04', name: 'A4', seats: 4, status: '待清' },
  { id: 'T05', name: 'B1', seats: 4, status: '预订' },
  { id: 'T06', name: 'B2', seats: 6, status: '空闲' },
  { id: 'T07', name: 'B3', seats: 6, status: '就餐' },
  { id: 'T08', name: 'C1', seats: 8, status: '空闲' },
  { id: 'T09', name: '包间', seats: 10, status: '预订' },
]
