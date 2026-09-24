# 熊猫五福餐厅 · 老板 AI App — Kimi/Moonshot 视觉 API 调用契约

| 项 | 内容 |
|---|---|
| 文档名称 | Kimi/Moonshot 视觉 API 调用契约（6 处视觉用例） |
| 版本 | v1.0（评审稿） |
| 日期 | 2026-09-24 |
| 关联文档 | `熊猫五福餐厅_PRD_v1.0.md`、`熊猫五福App原型.html` |
| 评审人 | 老板（宋子刚）/ 技术负责人 / 店长 |

---

## 1. 概览与红线

### 1.1 6 处视觉用例一览

| type | 用例 | 拍照对象 | 识别项（判定维度） | 主要处置动作（suggestedAction） | 原型卡片 ID |
|---|---|---|---|---|---|
| `recv` | 拍照验货 | 送货单/实物 | 品名、来源、数量、规格、鲜度、批次溯源 | `登记入库`（确认后入库存货流水） | `kimiRecv` |
| `stock` | 拍照盘点 | 货架/冷柜 | 品名、估算库存量、与账面对比、缺口 | `生成补货单`（确认后转补货建议） | `kimiStock` |
| `qc` | 成品质检 | 饺子成品 | 褶纹规整、色泽饱满、形态鼓胀、重量估值 | `复核通过`（确认后写入 `qc_records`） | `kimiQc` |
| `plate` | 摆盘质检 | 出餐成品盘 | 分量达标、配色五福、点缀规范、摆盘 SOP | `复核通过`（确认后记录合规） | `kimiPlate` |
| `sample` | 留样登记 | 留样盒 | 菜品识别、克重、标签、48h 到期 | `登记留样`（确认后写入留样记录） | `kimiSample` |
| `uniform` | 着装合规 | 员工 | 工服、帽子、口罩、洗手消毒、SOP 合规 | `记录合规`（确认后写入合规记录） | `kimiUniform` |

### 1.2 红线声明（不可越界）

1. **AI 只读 + 确认**：Kimi 视觉输出一律为「建议/识别结果」，所有写操作（入库、补货单、留样、品控记录、合规记录）必须由老板/店长在 App 上点确认按钮，**不自动落库**。
2. **自动生成 ≠ 自动下单**：`stock` 用例产出的补货单是 AI 生成草稿，需老板一键确认后才转采购/补货建议入队。
3. **结算单只读输出层**：`recv` 验货不直接生成结算单，结算单为只读输出层，不写 DB，审批后由人工入账。
4. **计价与三向合并核心零改动**：`calcQtyOf`（用量换算）、`dishRecipeCost`（成本拆解）、三向合并、`/api/sync`（带 rev 乐观锁）均**不被本契约触碰**；Kimi 仅做识别/判定，不参与算账。
5. **写回闭环**：App 确认 → 云端 BFF 写入队列 → 店内消费器拉取 → 调 `/api/sync`（带 rev 乐观锁）落库 → 下次快照回写「已执行」。
6. **色源锁定**：`recv`/`stock` 中识别到红/黄/绿/紫/黑色源时，仅核对，不得建议替换色源（红色必须火龙果，详见 PRD 附录 A）。

---

## 2. API 契约

### 2.1 端点与模型

| 项 | 值 | 备注 |
|---|---|---|
| 端点 | `https://api.moonshot.cn/v1/chat/completions` | Moonshot 官方 Chat Completions |
| 鉴权 | `Authorization: Bearer {{MOONSHOT_API_KEY}}` | key 仅存 BFF 服务端环境变量，**不入端代码、不进 git** |
| 模型 | `moonshot-v1-vision`（候选：`kimi-latest`） | **以官方最新文档为准**，此处为占位；上线前由技术负责人核对替换 |
| 协议 | HTTPS POST，`Content-Type: application/json` | 全链路 TLS |
| 响应格式 | 强制 JSON 输出：`response_format: {"type":"json_object"}` | 若所选模型不支持，BFF 降级为「prompt 指令 + 正则提取 JSON」 |

### 2.2 请求体 Schema

```json
{
  "model": "moonshot-v1-vision",
  "temperature": 0.2,
  "max_tokens": 1200,
  "response_format": { "type": "json_object" },
  "messages": [
    {
      "role": "system",
      "content": "{{SYSTEM_PROMPT_BY_TYPE}}"
    },
    {
      "role": "user",
      "content": [
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/jpeg;base64,{{IMAGE_BASE64}}",
            "detail": "auto"
          }
        },
        {
          "type": "text",
          "text": "{{USER_PROMPT_BY_TYPE_WITH_CTX}}"
        }
      ]
    }
  ]
}
```

字段说明：
- `temperature=0.2`：视觉判定需稳定可复现，偏低温度。
- `max_tokens=1200`：6 类结果 JSON 体量小，1200 足够；超长截断视为异常。
- `image_url.url`：优先用 base64 data URL（图片不落对象存储，临时传输）；若需 URL 模式，使用「15 分钟预签名 URL」并在响应后即删。
- `detail=auto`：让 Moonshot 自动选高/低清档，控成本。

### 2.3 认证、限流、超时、重试

| 项 | 策略 |
|---|---|
| API key 管理 | 仅 BFF 进程持有（环境变量 / 密钥管理服务）；前端、git、日志均不得出现 |
| 限流（429） | BFF 单实例令牌桶：每用户每分钟 ≤ 10 次视觉调用；触发 429 时降级为「人工复核」提示，不重试 |
| 超时 | 连接 5s、读取 30s；超时即降级 |
| 重试 | 仅对 5xx / 网络错误重试 1 次，间隔 1s（指数退避）；4xx / 429 / JSON 解析失败不重试 |
| 图片大小 | 单张上传 ≤ 1.5MB；超过由 BFF 服务端压到 1280px 长边、JPEG q=80（视觉判定足够，控 token） |
| 成本估算 | 视觉调用约 1k input token + 1 张图（按 high detail ≈ 1100 token）+ 1k output token；按 Moonshot 公开价计费（以官方价目为准）。单店日均视觉调用预估 ≤ 200 次，月成本可控 |

### 2.4 安全要求

- **API key 不入端代码**：App 只调云端 BFF `/api/kimi/vision`，不直连 Moonshot。
- **图片不落库**：图片 base64 仅在 BFF 内存中传给 Moonshot，响应返回后即销毁；不写入 SQLite、不写入快照副本。
- **审计**：每次视觉调用记录 `traceId / type / userId / 耗时 / 是否降级`，留存 30 天用于成本与质量复盘。
- **隐私**：`uniform` 用例涉及员工形象，仅返回合规判定结果，不存储人脸、不存储原图。

---

## 3. 六个用例的 Prompt 契约

### 3.1 通用输出 Schema（强制 JSON，与原型 `kimiData` 对齐）

```json
{
  "title": "字符串，卡片标题",
  "confidence": "0-100 整数，整体置信度",
  "thumbs": ["原图URL或base64占位", "识别框图", "对比图"],
  "rows": [
    {
      "item": "识别/判定项名称",
      "value": "识别值或留空字符串",
      "status": "pass | fail | warn",
      "detail": "该项判定依据或差异说明（≤30字）"
    }
  ],
  "note": "整体结论与提醒（1-2句）",
  "suggestedAction": "登记入库 | 生成补货单 | 复核通过 | 登记留样 | 记录合规 | 人工复核"
}
```

> 与原型 `kimiData[type]` 字段映射：`title←title`、`conf←confidence + "%"`、`rows←rows`（原型为三元组 `[item,value,status]`，BFF 出参补 `detail`）、`note←note`、`cta←suggestedAction`。原型 `kimi-thumbs` 固定三格（原图/识别框/对比），对应 `thumbs[3]`。

---

### 3.2 用例 `recv` · 拍照验货

- **业务目标**：核对送货实物与采购单（品名/数量/规格/鲜度/批次溯源），输出 pass/fail/warn 逐项判定。
- **输入**：送货单与实物合照（一张）。
- **system prompt**：

```
你是熊猫五福餐厅的验货 AI 助手。你的职责是：
1. 识别照片中的食材品名、规格、数量（估算）、外观鲜度、批次/溯源标签；
2. 将识别结果与"采购单"逐项比对，对每项给出 pass/fail/warn 判定；
3. 判定规则：品名一致=pass；数量偏差≤±3% =pass，>±3% 且 ≤±10%=warn，>±10%=fail；规格不符=fail；鲜度异常（变色/异味外观）=warn；缺少溯源标签=fail；
4. 色源锁定：红/黄/绿/紫/黑色源须与采购单一致（红色须为火龙果），不一致=fail；
5. 你只输出识别与判定，不做入库动作；suggestedAction 仅给出"登记入库"或"人工复核"建议。
必须严格输出 JSON，schema 见用户消息末尾。不要输出任何 JSON 外文字。
```

- **user prompt 模板**：

```
【采购单】
{{采购单_JSON_品名_数量_规格_供应商_批次}}

【照片】见附图。

【任务】逐项比对，输出 JSON：
{
  "title": "验货识别",
  "confidence": 0-100,
  "thumbs": ["原图","识别框","对比"],
  "rows": [{"item":"品名","value":"识别值","status":"pass|fail|warn","detail":"判定依据"}],
  "note": "结论",
  "suggestedAction": "登记入库 | 人工复核"
}
```

- **判定规则举例**：`猪肉前肩·张记肉业 pass`、`雪花粉八星·五得利 pass`、`火龙果汁·菜篮子 pass`，缺失批次溯源则对应行 fail。
- **写回映射**：`suggestedAction="登记入库"` → App「确认入库」按钮 → 云端队列 `actions_queue{type:'recv_inbound', payload:{items, 供应商, 批次}}` → 店内消费器 → `/api/sync`（rev 乐观锁）写入进货入库表。**AI 不直接写库**。

---

### 3.3 用例 `stock` · 拍照盘点

- **业务目标**：估算货架/冷柜中原料库存量，与账面库存对比，标记缺口，生成补货建议草稿。
- **输入**：货架/冷柜内景照片一张。
- **system prompt**：

```
你是熊猫五福餐厅的库存盘点 AI 助手。你的职责是：
1. 识别照片中可见的原料品名并估算当前库存量（kg/g 或件）；
2. 将估算值与"账面库存"对比：偏差在 ±5% 内 =pass，>±5% 且 ≤±15%=warn，>±15%=fail；
3. 对账面低于"安全库存"的原料，标注 warn 并在 note 给出补货建议金额；
4. 你只识别与估算，不调用任何算账函数、不修改库存；suggestedAction 仅给出"生成补货单"或"人工复核"。
5. 色源类原料（火龙果汁/南瓜泥/菠菜汁/紫薯粉/墨鱼汁）仅盘点，不建议替换。
严格输出 JSON，schema 见用户消息。不输出 JSON 外文字。
```

- **user prompt 模板**：

```
【账面库存】
{{账面库存_JSON_品名_账面量_单位_安全库存}}

【安全库存阈值】{{安全库存_由管理后台配置}}

【照片】见附图。

【任务】逐项估算并对比，输出 JSON：
{
  "title": "库存盘点",
  "confidence": 0-100,
  "thumbs": ["原图","识别框","对比"],
  "rows": [{"item":"品名","value":"估算量","status":"pass|fail|warn","detail":"与账面偏差/缺口"}],
  "note": "结论与补货建议（含金额）",
  "suggestedAction": "生成补货单 | 人工复核"
}
```

- **判定规则举例**：`猪肉前肩 8.2kg pass`、`墨鱼汁 620g warn`（接近安全线）、`火龙果汁 440g fail`（仅够 2 天，note 提示补货 ¥620）。
- **写回映射**：`suggestedAction="生成补货单"` → App「确认生成补货单」按钮 → 云端队列 `actions_queue{type:'stock_restock', payload:{items, 建议供应商, 金额}}` → 店内消费器 → `/api/sync` 写入补货建议表。**自动生成 ≠ 自动下单**，须老板确认才转采购。

---

### 3.4 用例 `qc` · 成品质检

- **业务目标**：识别饺子成品的褶纹规整度、色泽饱满度、形态鼓胀度，估算单只重量，输出合格率。
- **输入**：饺子成品俯视照片一张（可选附带称重读数）。
- **system prompt**：

```
你是熊猫五福餐厅的成品品控 AI 助手。你的职责是：
1. 识别照片中饺子成品的褶纹规整度、色泽饱满度、形态鼓胀度；
2. 估算单只成品重量（克），与非遗出品标准比对：成品重 25-27g（白色 25-28g）=pass，超出=fail，临界(±0.5g)=warn；
3. 褶纹规整度 ≥90% =pass，80-90%=warn，<80%=fail；色泽饱满 ≥90%=pass，80-90%=warn，<80%=fail；形态鼓胀同色标准；
4. 给出整体合格率（百分比）；
5. 你只识别与判定，不修改 qc_records；suggestedAction 仅给出"复核通过"或"人工复核"。
严格输出 JSON，schema 见用户消息。不输出 JSON 外文字。
```

- **user prompt 模板**：

```
【成品标准】
{{成品标准_JSON_色别_成品重区间_褶纹阈值_由recipes表只读取}}

【可选称重读数】{{电子秤读数_克_可选}}

【照片】见附图。

【任务】识别并判定，输出 JSON：
{
  "title": "成品质检",
  "confidence": 0-100,
  "thumbs": ["原图","识别框","对比"],
  "rows": [{"item":"褶纹规整|色泽饱满|形态鼓胀|重量估值","value":"识别值","status":"pass|fail|warn","detail":"判定依据"}],
  "note": "合格率结论",
  "suggestedAction": "复核通过 | 人工复核"
}
```

- **判定规则举例**：`褶纹规整 94% pass`、`色泽饱满 96% pass`、`形态鼓胀 92% pass`、`重量估值 25.8g pass`，note `成品合格率 94%`。
- **写回映射**：`suggestedAction="复核通过"` → App「确认通过」按钮 → 云端队列 `actions_queue{type:'qc_pass', payload:{workorder_id, sku_id, samples, pass}}` → 店内消费器 → `/api/sync` 写入 `qc_records`。**AI 不直接写 qc_records**。

---

### 3.5 用例 `plate` · 摆盘质检

- **业务目标**：识别出餐成品盘的分量达标、配色五福、点缀规范、摆盘 SOP 合规。
- **输入**：成品盘俯视照片一张。
- **system prompt**：

```
你是熊猫五福餐厅的摆盘质检 AI 助手。你的职责是：
1. 识别照片中成品盘的分量、配色（是否五福/五色齐整）、点缀规范、摆盘 SOP；
2. 判定规则：分量达标=pass，明显偏少/偏多=fail，临界=warn；配色五色齐整=pass，缺色=fail；点缀规范符合宫廷御膳 SOP=pass，不符=fail；摆盘整体 SOP 合规=pass，不符=warn；
3. 你只识别与判定，不记录合规；suggestedAction 仅给出"复核通过"或"人工复核"。
严格输出 JSON，schema 见用户消息。不输出 JSON 外文字。
```

- **user prompt 模板**：

```
【摆盘 SOP】
{{摆盘SOP_JSON_分量_配色_点缀_宫廷御膳标准_由recipes只读取}}

【照片】见附图。

【任务】识别并判定，输出 JSON：
{
  "title": "摆盘质检",
  "confidence": 0-100,
  "thumbs": ["原图","识别框","对比"],
  "rows": [{"item":"分量达标|配色五福|点缀规范|摆盘SOP","value":"识别值或pass","status":"pass|fail|warn","detail":"判定依据"}],
  "note": "结论",
  "suggestedAction": "复核通过 | 人工复核"
}
```

- **判定规则举例**：`分量达标 pass`、`配色五福 pass`、`点缀规范 pass`、`摆盘SOP pass`，note `摆盘符合宫廷御膳 SOP，五色齐整`。
- **写回映射**：`suggestedAction="复核通过"` → App「确认通过」按钮 → 云端队列 `actions_queue{type:'plate_pass', payload:{date, sku, 判定}}` → 店内消费器 → `/api/sync` 写入合规记录。**AI 不直接写记录**。

---

### 3.6 用例 `sample` · 留样登记

- **业务目标**：识别留样盒中的菜品、克重、标签、48h 到期时间，确保留样合规。
- **输入**：留样盒与标签合照一张。
- **system prompt**：

```
你是熊猫五福餐厅的留样登记 AI 助手。你的职责是：
1. 识别照片中留样盒的菜品名（红/黄/绿/紫/黑/白色饺子或对应 SKU）、克重（读标签或估算）、标签是否已贴、48h 到期时间；
2. 判定规则：菜品识别置信度高=pass；克重 ≥125g=pass，<125g=fail，125-130g=warn；标签已贴=pass，未贴=fail；48h 到期时间在合规区间=pass，临界(剩余<8h)=warn，超期=fail；
3. 你只识别与判定，不登记留样；suggestedAction 仅给出"登记留样"或"人工复核"。
严格输出 JSON，schema 见用户消息。不输出 JSON 外文字。
```

- **user prompt 模板**：

```
【当前时间】{{ISO8601_当前时间_店内服务器}}

【留样标准】克重≥125g，48h 到期，标签含菜品+到期时间。

【照片】见附图。

【任务】识别并判定，输出 JSON：
{
  "title": "留样登记",
  "confidence": 0-100,
  "thumbs": ["原图","识别框","对比"],
  "rows": [{"item":"菜品识别|48h到期|克重|标签","value":"识别值","status":"pass|fail|warn","detail":"判定依据"}],
  "note": "结论",
  "suggestedAction": "登记留样 | 人工复核"
}
```

- **判定规则举例**：`菜品识别 红色长寿饺 pass`、`48h到期 09-26 11:30 warn`（剩余接近临界）、`克重 125g pass`、`标签 已贴 pass`，note `留样符合 48h 规范`。
- **写回映射**：`suggestedAction="登记留样"` → App「确认登记」按钮 → 云端队列 `actions_queue{type:'sample_log', payload:{菜品, 克重, 到期时间}}` → 店内消费器 → `/api/sync` 写入留样记录。**AI 不直接写留样记录**。

---

### 3.7 用例 `uniform` · 着装合规

- **业务目标**：识别员工工服整洁、帽子佩戴、口罩规范、洗手消毒、SOP 合规。
- **输入**：员工着装照片一张（不存储人脸，仅返回合规判定）。
- **system prompt**：

```
你是熊猫五福餐厅的着装合规 AI 助手。你的职责是：
1. 识别照片中员工的工服整洁、帽子佩戴、口罩规范、洗手消毒状态、整体 SOP 合规；
2. 判定规则：工服整洁=pass，污渍=fail，轻微皱=warn；帽子佩戴规范=pass，未戴=fail；口罩规范=pass，露鼻=fail，未戴=fail；洗手消毒完成=pass，未完成=fail；整体 SOP 合规=pass，单项 fail 则整体 warn；
3. 隐私约束：不输出任何个人身份信息，不做人脸识别，仅返回合规判定；
4. 你只识别与判定，不记录合规；suggestedAction 仅给出"记录合规"或"人工复核"。
严格输出 JSON，schema 见用户消息。不输出 JSON 外文字。
```

- **user prompt 模板**：

```
【着装 SOP】{{着装SOP_JSON_工服_帽_口罩_洗手_由管理后台配置}}

【照片】见附图。

【任务】识别并判定，输出 JSON：
{
  "title": "着装 SOP 合规",
  "confidence": 0-100,
  "thumbs": ["原图","识别框","对比"],
  "rows": [{"item":"工服整洁|帽子佩戴|口罩规范|洗手消毒|SOP合规","value":"pass或识别值","status":"pass|fail|warn","detail":"判定依据"}],
  "note": "结论",
  "suggestedAction": "记录合规 | 人工复核"
}
```

- **判定规则举例**：`工服整洁 pass`、`帽子佩戴 pass`、`口罩规范 pass`、`洗手消毒 pass`、`SOP合规 pass`，note `着装合规，符合食品安全操作规范`。
- **写回映射**：`suggestedAction="记录合规"` → App「确认记录」按钮 → 云端队列 `actions_queue{type:'uniform_log', payload:{员工编号, 判定, 时间}}` → 店内消费器 → `/api/sync` 写入合规记录。**AI 不直接写合规记录，且不存人脸**。

---

## 4. 前端集成

### 4.1 `callKimiVision(type, imageBlob, ctx)` 草稿

```javascript
// 调云端 BFF /api/kimi/vision，返回 Promise<结构化结果>
// 替换原型 mockScan 中的 setTimeout 假数据，保留扫描动效与卡片渲染
async function callKimiVision(type, imageBlob, ctx) {
  // 1. 压缩：超 1.5MB 先压到 1280px / q=80（也可交 BFF，端侧预压省流量）
  const blob = imageBlob.size > 1.5 * 1024 * 1024
    ? await compressImage(imageBlob, 1280, 0.8)
    : imageBlob;

  // 2. base64
  const imageBase64 = await blobToBase64(blob);

  // 3. 调 BFF
  const resp = await fetch('/api/kimi/vision', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (window.__APP_TOKEN || ''), // App 鉴权
    },
    body: JSON.stringify({ type, imageBase64, ctx }),
  });

  if (!resp.ok) {
    // 网络/5xx 一律降级为人工复核，不阻断业务
    return degradeResult(type, '网络异常，请人工复核');
  }
  const data = await resp.json();
  if (!data.ok || !data.result) {
    return degradeResult(type, data.message || '识别失败，请人工复核');
  }
  return data.result; // 结构见 §3.1 schema
}

// 辅助：Blob → base64（去掉 data: 前缀也可，由 BFF 决定）
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// 辅助：端侧压缩
function compressImage(blob, maxLen, q) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxLen / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = img.width * scale; c.height = img.height * scale;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => resolve(b), 'image/jpeg', q);
    };
    img.src = URL.createObjectURL(blob);
  });
}

// 降级结果（与 kimiData schema 对齐）
function degradeResult(type, msg) {
  return {
    title: DEGRADE_TITLE[type] || '识别失败',
    confidence: 0,
    thumbs: ['原图', '', ''],
    rows: [{ item: 'AI 识别', value: 'fail', status: 'fail', detail: msg }],
    note: '已降级为人工复核，不阻断业务。',
    suggestedAction: '人工复核',
  };
}
```

### 4.2 替换原型 `mockScan`

- 原型 `mockScan(el, type)` 当前用 `setTimeout(..., 900)` 假装扫描后塞 `kimiData[type]` 渲染卡片。
- 改造：保留 `el.classList.add('scanning')` 扫描动效；将 `setTimeout` 替换为 `callKimiVision(type, blob, ctx)`，Promise resolve 后移除 `scanning` class 并用返回的 `result` 渲染卡片（渲染逻辑与现有 `kimiData[type]` → `rowsHtml` 一致，仅改为从 `result.rows` 取数，并把 `result.confidence + '%'` 渲染到 `.kimi-conf`，`result.suggestedAction` 渲染到 CTA 按钮文案）。
- `ctx`（上下文变量）由各页注入：`recv` 注入采购单 JSON、`stock` 注入账面库存、`qc` 注入成品标准与称重读数、`plate` 注入摆盘 SOP、`sample` 注入当前时间、`uniform` 注入着装 SOP。

---

## 5. BFF 侧契约

### 5.1 `POST /api/kimi/vision`

**请求**：
```json
{
  "type": "recv | stock | qc | plate | sample | uniform",
  "imageBase64": "JPEG base64 字符串（不含 data: 前缀）",
  "ctx": { "采购单": {...}, "账面库存": {...}, ... }
}
```

**响应（成功）**：
```json
{
  "ok": true,
  "result": { /* §3.1 schema */ },
  "traceId": "uuid 用于审计与排障"
}
```

**响应（降级）**：
```json
{
  "ok": false,
  "result": {
    "title": "...",
    "confidence": 0,
    "rows": [{"item":"AI 识别","value":"fail","status":"fail","detail":"人工复核"}],
    "note": "已降级为人工复核",
    "suggestedAction": "人工复核"
  },
  "traceId": "uuid",
  "message": "限流/超时/解析失败原因"
}
```

### 5.2 BFF 职责

1. **key 管理**：从环境变量取 `MOONSHOT_API_KEY`，绝不回传前端。
2. **prompt 组装**：按 `type` 选取 §3 中对应 system/user prompt 模板，把 `ctx` 注入占位符 `{{...}}`。
3. **图片处理**：校验大小/类型，超限压缩到 1280px / q=80，转 data URL 调 Moonshot。
4. **JSON 解析与校验**：解析 Moonshot 返回；用 §3.1 schema 校验字段齐全、`status ∈ {pass,fail,warn}`、`confidence ∈ [0,100]`、`suggestedAction ∈ {登记入库, 生成补货单, 复核通过, 登记留样, 记录合规, 人工复核}`；不齐则降级。
5. **降级**：任一环节失败（限流/超时/解析失败/置信度<阈值/校验失败）统一返回 `ok:false` + 人工复核结果，**不阻断业务**。
6. **审计**：记录 `traceId / type / userId / 耗时 / 是否降级 / moonshot_usage(token)`，留存 30 天。
7. **写回对接**：BFF **不直接写库**，仅返回 `suggestedAction`；前端点确认按钮后另调 `POST /api/actions/{id}/confirm`（PRD §6.2 已有契约）入云端队列。

---

## 6. 错误与降级矩阵

| 失败场景 | 检测点 | 降级动作 | 是否阻断业务 | 备注 |
|---|---|---|---|---|
| 网络失败（连接/读超时） | fetch 抛错 / 5xx | 返回 `ok:false` + 人工复核卡片 | 否 | 提示「网络异常，请人工复核」 |
| API key 失效（401/403） | Moonshot 返回 401/403 | 同上 + 告警运维 | 否 | 不向前端暴露 key 问题细节 |
| 限流（429） | Moonshot 429 | 同上 + 令牌桶冷却 | 否 | 不重试，直接降级 |
| JSON 解析失败 | BFF JSON.parse 抛错 | 同上 | 否 | 记 raw 截断前 500 字入审计 |
| schema 校验失败 | 字段缺失/status 非法 | 同上 | 否 | 记校验错误明细入审计 |
| 置信度 < 阈值（默认 70） | `confidence < 70` | 强制 `suggestedAction='人工复核'`，note 追加「置信度低」 | 否 | 阈值由管理后台可配 |
| 模型超 token（finish_reason=length） | Moonshot 返回 length | 同上 | 否 | 调小 max_tokens 或拆图重试 |
| 图片过大/格式不支持 | BFF 入参校验 | 同上 | 否 | 前端预压 + BFF 兜底压缩 |

> 一切视觉失败都退化为「人工复核」，业务流程继续走人工路径，确保不因 AI 故障阻断门店运营。

---

## 7. 红线复核清单

逐条确认本契约不触碰 PRD 红线：

| # | 红线条款 | 本契约遵守情况 |
|---|---|---|
| 1 | AI 只读 + 确认，写操作需用户点确认 | ✅ Kimi 仅输出识别/判定/suggestedAction；写操作统一走 App 确认 → `/api/actions/{id}/confirm` → 队列 → `/api/sync` |
| 2 | 自动生成 ≠ 自动下单（补货/采购建议需确认） | ✅ `stock` 的 `生成补货单` 仅为建议，须老板确认才转采购 |
| 3 | 结算单只读输出层，不写 DB | ✅ `recv` 验货不生成结算单，结算单保持只读 |
| 4 | `calcQtyOf` 用量换算零改动 | ✅ 本契约不调用 `calcQtyOf`；用量换算由 PRD 模块二 F2 在另一处复用 |
| 5 | `dishRecipeCost` 成本拆解零改动 | ✅ 本契约不调用 `dishRecipeCost`；成本仅在 PRD 模块二 F4 调用 |
| 6 | 三向合并 `/api/sync`（带 rev 乐观锁）零改动 | ✅ 本契约只通过 `/api/actions/{id}/confirm` 入队，由店内消费器调 `/api/sync`，未改 rev 机制 |
| 7 | `rebuildStock/seedDB` 受保护逻辑不被覆盖 | ✅ 本契约不涉及这些函数 |
| 8 | 色源锁定（红=火龙果等不可替换） | ✅ `recv`/`stock` 的 system prompt 明确色源锁定，不建议替换 |
| 9 | 图片不落库 | ✅ 图片 base64 仅 BFF 内存中传 Moonshot，响应后销毁 |
| 10 | API key 不入端代码 | ✅ 前端只调 BFF `/api/kimi/vision`，key 仅 BFF 环境变量 |
| 11 | AI 不直接算账 | ✅ 视觉识别不涉及毛利/成本计算，重量估值仅与成品标准区间比对 |
| 12 | 隐私（着装不存人脸） | ✅ `uniform` 仅返回合规判定，不存储人脸/原图 |

---

## 附录 A：变量占位汇总

| 占位 | 来源 | 注入点 |
|---|---|---|
| `{{采购单}}` | 进销存·采购管理（只读快照） | `recv` user prompt |
| `{{账面库存}}` | 进销存·原料库存（只读快照） | `stock` user prompt |
| `{{安全库存}}` | 管理后台配置（只读） | `stock` user prompt |
| `{{成品标准}}` | `recipes` 表只读（色别/成品重/褶纹阈值） | `qc` user prompt |
| `{{摆盘SOP}}` | `recipes` 表只读（宫廷御膳标准） | `plate` user prompt |
| `{{当前时间}}` | 店内服务器 ISO8601 | `sample` user prompt |
| `{{着装SOP}}` | 管理后台配置（只读） | `uniform` user prompt |
| `{{IMAGE_BASE64}}` | 端侧拍照压缩后 base64 | 所有用例 image_url |
| `{{SYSTEM_PROMPT_BY_TYPE}}` | BFF 按 type 选取 §3 system prompt | 所有用例 messages[0] |
| `{{USER_PROMPT_BY_TYPE_WITH_CTX}}` | BFF 按 type 选取模板 + ctx 注入 | 所有用例 messages[1].text |

> 所有 `{{...}}` 均由 BFF 服务端组装，前端只传 `type / imageBase64 / ctx`，不接触 prompt 模板与 API key。
