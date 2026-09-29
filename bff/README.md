# canteenAI BFF

熊猫五福 · **产品三件套**的统一 API 层：手机原生 App（android/ios，老板主用）+ SaaS 管理后台（admin-web）+ 本 BFF。

产品三件套 = 手机原生 App + 管理后台 + API（BFF）。旧 HTML 原型与网页版 boss-app 已归档至 `old/`。店内数据节点亦为 Node（`bff/store-node/`），**无 Python 运行时**；业务算法统一在 `bff/lib/algorithms/`（原生 App 与后台同源）。

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
| GET | `/api/modules/*` | analysis/vip/equipment/staff/booking/foodsafe/takeout/review/finance/loss/**inspection** |
| GET | `/api/kitchen/*` | recipes/workorders/qc/board/demand/**sop-videos** |
| GET/POST | `/api/qc/media/*` | 品控照片对象存储通道：status / presign / sign（**图片不经手、不落盘、不入库**） |
| GET | `/api/inventory/restock-suggest` | 补货建议（只读） |
| POST | `/api/actions` + confirm/reject/status | **唯一业务写路径** → 队列 → 店内 sync |

`modules/analysis` 含 `forecast`（AI 预测/备货）与 `baoben_*`。  
`modules/equipment` 含 `temps`（冷柜温度，优先 IoT）与 `energy_summary`。  
`modules/vip` 含 `members[].birthday_soon`。  
`modules/inspection` 为闭店巡检统筹看板（50 节点完成度 / 漏项 / 30 分钟轮次），数据源 `inspection_records`。  
`/api/kitchen/qc` 返回品控台账扩展字段（`defect_items`/`stage`/`operator`/`photo_url` 等）；照片本体不入库。

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

主数据灌数：`python3 store-inventory/seed_master_data.py`（仅数据种子工具，非运行时）。

## 品控照片与对象存储（红线①）

品控（A 块）照片**不经过 BFF、不落盘、不入库**：App 直传对象存储，BFF 只签发 URL，DB 只存 `photo_url`/`photo_key` 引用。路由 `bff/routes/qc_media.js`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/qc/media/status` | 媒体可用性（`configured`/`missing`），未配置时前端显示「图片不可用」降级 |
| POST | `/api/qc/media/presign` | 签发上传（PUT）URL，App 直传 |
| POST | `/api/qc/media/sign` | 批量签发读取 URL（admin-web 看不合格大图；私有桶唯一读法） |

预签名为**零依赖手写 AWS SigV4**（`bff/lib/objstore.js`），不引入云 SDK。请求体出现 `imageBase64`/`photo_base64` 等一律 **400 驳回并留痕**。环境变量（S3 兼容均可）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `OSS_ENDPOINT` / `OSS_BUCKET` | 是 | 对象存储地址与桶 |
| `OSS_AK` / `OSS_SK` | 是 | 访问密钥 |
| `OSS_REGION` / `OSS_SERVICE` | 否 | 默认 `us-east-1` / `s3` |
| `OSS_PATH_STYLE` | 否 | MinIO 等需 path-style 时置 1 |
| `OSS_PUBLIC_BASE` | 否 | 公共读桶时拼公开 URL |
| `OSS_EXPIRE_SEC` | 否 | 预签名有效期（秒） |

未配置时品控流程**不中断**：AI 识别与结论照常落库，仅 `photo_url` 为空。

## 店内节点（bff/store-node，Node）

原 Python 店内服务（server/app.py + snapshot_pusher.py + queue_consumer.py）已整体移植为 Node，复用 `bff/lib/algorithms/`，无 Python 运行时：

| 文件 | 职责 |
|---|---|
| `store-node/server.js` | 店内数据库服务（SQLite：docs/snapshots + ext 新表；/api/db、/api/sync、/api/health 等） |
| `store-node/db.js` / `merge.js` | 存储层与三向合并（受保护核心，平价测试对齐原 Python） |
| `store-node/pusher.js` | 整库快照推送（店内 → BFF） |
| `store-node/consumer.js` | 动作队列消费（BFF → 调 `lib/algorithms` → 写回店内 → 回调） |
| `store-node/seed/*.js` | 数据种子/导入/迁移工具（原 Python `seed_*.py`/`import_orders_excel.py`/`migrate_from_zip.py` 的 Node 移植，含纯 Node docx/xlsx/zip 解析） |
| `store-node/run-tests.js` · `seed/run-tests.js` | 平价/集成测试总入口 |

一键联调（Node，无 Python）：`bash scripts/dev-up-native.sh`

## 特性

- **零第三方依赖**：仅用 Node 内置模块，无需 `npm install`。
- **API Key 安全**：Key 仅存于 `bff/.env`，不入前端、不进 git。
- **Kimi 视觉**：`POST /api/kimi/vision`（+ `/stream` SSE），输出对齐原型 kimi-card。
- **品控照片对象存储**：App 直传、BFF 只签 URL（`/api/qc/media/*`），图片不落盘不入库（红线①）。
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
| POST | `/api/kimi/vision` | 视觉识别（非流式） |
| POST | `/api/kimi/vision/stream` | 视觉识别（SSE：stage/delta/done/error） |

请求体：

```json
{ "type": "qc", "imageBase64": "data:image/jpeg;base64,...", "ctx": {} }
```

- `type`：`recv|stock|qc|plate|sample|uniform`
- `imageBase64`：data URL 或纯 base64。

响应成功：`{ ok, result: { title, rows, note, cta, conf }, model, traceId }`。
