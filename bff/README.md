# canteenAI Kimi BFF

熊猫五福餐厅 · 老板 AI App 原型的本地零依赖 Node BFF，代理调用 Moonshot/Kimi 视觉 API。

## 特性

- **零第三方依赖**：仅用 Node 内置模块 `http`/`https`/`fs`/`path`/`crypto`，无需 `npm install`。
- **API Key 安全**：Key 仅存于 `bff/.env`（`process.env.KIMI_API_KEY`），不入前端、不进 git、不写日志。
- **统一输出**：把 Moonshot 返回映射成原型 `renderKimiCard` 可直接渲染的结构 `{title, rows:[[item,value,status]], note, cta, conf}`。
- **6 用例**：`recv`/`stock`/`qc`/`plate`/`sample`/`uniform`，system/user prompt 原样落自《Kimi视觉API调用契约.md》。
- **降级不崩进程**：任一环节失败统一返回 `{ok:false, ...}`，原型自动降级 mock，不阻断业务。

## 启动

```bash
cd bff
node server.js
```

监听 `http://127.0.0.1:8787`。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 健康检查 |
| POST | `/api/kimi/vision` | 视觉识别主接口 |

### POST /api/kimi/vision

请求体：

```json
{ "type": "qc", "imageBase64": "data:image/jpeg;base64,...", "ctx": {} }
```

- `type`：`recv|stock|qc|plate|sample|uniform`
- `imageBase64`：完整 data URL（`data:image/jpeg;base64,...`）或纯 base64，BFF 会自动补全前缀。
- `ctx`：上下文变量（采购单/账面库存/成品标准/摆盘 SOP/当前时间/着装 SOP），缺省时用合理默认。

响应（成功）：

```json
{
  "ok": true,
  "result": { "title": "成品质检", "rows": [["褶纹规整","94%","pass"]], "note": "...", "cta": "复核通过", "conf": "95%" },
  "model": "moonshot-v1-32k-vision-preview",
  "traceId": "..."
}
```

响应（降级）：

```json
{ "ok": false, "error": "moonshot http 401", "model": "...", "detail": "...", "traceId": "..." }
```

## 接通原型

在 `熊猫五福App原型.html` 中（已默认接通）：

```js
window.KIMI_BFF_URL = window.KIMI_BFF_URL || 'http://127.0.0.1:8787/api/kimi/vision';
```

留 `||` 让外部可覆盖（如部署到云端时改写）。原型拍照后会 POST 到该地址，BFF 调 Moonshot 后返回结构化结果，由 `renderKimiCard` 渲染。

## 模型说明

候选顺序：`moonshot-v1-32k-vision-preview` → `moonshot-v1-8k-vision-preview` → `moonshot-v1-auto`。
先试带 `response_format:{type:'json_object'}`，若模型不支持或 404 自动回退；最终采用模型名写入响应 `model` 字段。

## 安全

- `.env` 已加入根 `.gitignore`，不进版本库。
- 代码通过 `process.env.KIMI_API_KEY` 读取 Key，无硬编码。
- 日志仅记 `traceId/type/model/状态/耗时`，不含 Key 与图片。
