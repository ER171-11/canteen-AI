# 熊猫五福 · 老板 App（boss-app）

由根目录 `熊猫五福App原型.html` 拆分的 Vite 静态应用，视觉与交互与原型一致；BFF 水合层按 Wave 接通真数据。

## 启动顺序（务必）

```bash
# 一键（推荐）
chmod +x apps/boss-app/scripts/dev-up.sh
./apps/boss-app/scripts/dev-up.sh
```

或手动：

1. 店内进销存 `python3 store-inventory/server/app.py` → `:8765`
2. BFF `node bff/server.js` → `:8787`
3. 推快照：`BFF_TOKEN=<login token> python3 store-inventory/snapshot_pusher.py --once`
4. 老板 App `cd apps/boss-app && npm run dev` → **http://127.0.0.1:5174**

状态栏右侧角标：

| 文案 | 含义 |
|------|------|
| 真数据 · rev N | 快照已水合 |
| mock · rev — | 日报为服务端 mock 或无快照 |
| 离线 · 原型 | BFF 不可达，保留原型 DOM |

## BFF 能力

| 能力 | 接口 |
|------|------|
| 登录 | `POST /api/admin/login` |
| 经营日报 | `GET /api/report/daily` |
| 进销快照 | `GET /api/snapshot/latest` |
| 问店 | `POST /api/agent/chat` |
| Kimi | `POST /api/kimi/vision`（`KIMI_BFF_URL=/api/kimi/vision`） |
| 确认写回 | `POST /api/actions` + `/confirm` |
| 模块台账 | `GET /api/modules/{analysis,staff,booking,foodsafe,vip,takeout,review,equipment,finance,loss,supply}` |
| 补货建议 | `GET /api/inventory/restock-suggest` |
| 厨房 | `GET /api/kitchen/{board,workorders,qc,recipes}` |

开发服务器将 `/api` 代理到 `http://127.0.0.1:8787`。

## 已水合 vs 演示

- **真数据**：简报日报/预警/待办（KPI 按标题白名单映射）、进销库存与补货（restock-suggest 优先，本地安全线兜底）、厨房菜谱/工单 SOP/品控/出品看板、经营分析五页（趋势/热力/矩阵/效率/预测）、员工（排班/打卡/绩效/培训）、会员、外卖、预订（含翻台）、食安（含消毒）、设备（温度/能耗/维保）、财务、供应链、口碑、损耗、问店、确认台与 POS 结账入队、Kimi 六入口
- **演示兜底**：端点回 `hint=no_snapshot` / `mock:true` / 字段全空时保留原型 DOM 并标"演示"徽标；POS 桌台为前端内存模型（BFF 无桌台端点）；首页迷你热力图在 sales 无小时字段时保留原型
- **confirm 抽屉上下文化**：`openSheet('confirm', payload)` 按 kind 渲染（restock2po/aiForecast2po/salary/birthdayCoupon/settlement/generic），确认统一入 actions 队列，离线降级 toast

## 构建

```bash
cd apps/boss-app && npm run build && npm run preview
```
