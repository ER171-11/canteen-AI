# canteenAI BFF

熊猫五福 · **产品三件套**的统一 API 层：原生 App（老板主用）+ SaaS 管理后台（admin-web）+ 本 BFF。

HTML 原型仅为功能清单；`boss-app` 仅为同契约预览，不入产品三件套。

## 门店 / 岗位 / 账号

首次启动自动生成 `data/org.json`：

| 项 | 默认 |
|---|---|
| 门店 | 熊猫功夫餐厅海口世贸雅苑店（品牌：熊猫五福） |
| 岗位 | 老板 / 店长 / 收银 / 厨房 / 财务 / 只读（细粒度 `module.read\|write`） |
| 老板 | `boss` · 显示名 **David Sun** |
| 账号 | `boss` `manager` `cashier` `kitchen` `finance` |
| 密码 | `wufu123`（可用环境变量 `BFF_DEFAULT_PASSWORD`） |
| 邀请码 | `WUFU2026`（`BFF_INVITE_CODE`） |

## API 分层（禁止业务双轨）

### 业务 API（原生 App + SaaS 共用）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/report/daily` | 简报：kpi、todos(kind/route)、alerts、day_close |
| GET | `/api/snapshot/latest` | 店内快照 |
| GET | `/api/modules/*` | analysis/vip/equipment/staff/booking/foodsafe/takeout/review/finance/loss |
| GET | `/api/kitchen/*` | recipes/workorders/qc/board/demand |
| GET | `/api/inventory/restock-suggest` | 补货建议（只读） |
| POST | `/api/actions` + confirm/reject/status | **唯一业务写路径** → 队列 → 店内 sync |

`modules/analysis` 含 `forecast`（AI 预测/备货）与 `baoben_*`。  
`modules/equipment` 含 `temps`（冷柜温度，优先 IoT）与 `energy_summary`。  
`modules/vip` 含 `members[].birthday_soon`。

### 平台 API（SaaS 为主）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` | App / 预览登录 |
| POST | `/api/auth/wechat` | 微信 code 换会话（可 demo） |
| GET | `/api/auth/wechat/config` | 是否启用微信 / AppId 公开信息 |
| POST | `/api/admin/login` | SaaS 登录（同签发模型） |
| GET | `/api/auth/me` | 当前用户 |
| GET/POST | `/api/org*` | 门店/岗位/账号（需 org 权限） |
| GET | `/api/admin/kimi-log` · `/api/admin/audit` | AI / 请求审计 |

**禁止**：为同一业务再开 `/api/admin/...` 旁路列表；缺字段扩 `/api/modules/*`。

写操作需 `actions.write`。开发可用 `ALLOW_DEMO_LOGIN=1`（默认）在无密码时兼容旧登录。

主数据灌数：`python3 store-inventory/seed_master_data.py`。

## 特性

- **零第三方依赖**：仅用 Node 内置模块，无需 `npm install`。
- **API Key 安全**：Key 仅存于 `bff/.env`，不入前端、不进 git。
- **Kimi 视觉**：`POST /api/kimi/vision`，输出对齐原型 kimi-card。
- **降级不崩进程**：失败统一 `{ok:false}`。

## 启动

```bash
cd bff
node server.js
```

监听 `http://127.0.0.1:8787`。

## Kimi 视觉

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 健康检查 |
| POST | `/api/kimi/vision` | 视觉识别 |

请求体：

```json
{ "type": "qc", "imageBase64": "data:image/jpeg;base64,...", "ctx": {} }
```

- `type`：`recv|stock|qc|plate|sample|uniform`
- `imageBase64`：data URL 或纯 base64。

响应成功：`{ ok, result: { title, rows, note, cta, conf }, model, traceId }`。
