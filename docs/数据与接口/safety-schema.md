# 食安拍照上报 · 快照结构（safety schema）

> 面向 agent/开发者的数据契约：员工拍照上报的**点位主数据**与**核验记录**在店内快照里的存放位置、字段语义与聚合口径。
> 关联：`docs/分端机制与开发接入指南.md`（分端 + 权限双轨 + 跨端写回）、`docs/safety_points_implementation.md`（`ext.fs_points` 点位统筹）。
> 代码落点：`bff/lib/safety_plan.js`（纯函数 + 内置种子点位）、`bff/lib/algorithms/safety_check.js`（三个写算法）、`bff/routes/safety.js`（只读端点）。

---

## 0. 一句话

食安拍照上报的数据落在**快照 `data.safety`** 子树下（**不是** `ext`）：

```
data.safety.points[]   点位主数据（应检清单；空态回退 BFF 内置种子）
data.safety.checks[]   核验记录（员工上报 → AI 初判 → 人工复核）
```

- **写**：全部走 `POST /api/actions`（`safety.check` / `safety.ai_judge` / `safety.review`）→ 审批确认 → 算法层落快照，**前端与店内都不直写**。
- **读**：`GET /api/safety/progress` 只调 `loadSnapshot()`，不写库、不入队、不改快照。
- **图片**：只存 `photo_url` 引用（对象存储直传后的访问地址），**图片本体不入库、不过 BFF、不落盘**。
- 与 `ext.fs_points` 的区别：`ext.fs_points` 是**巡检/消毒**点位主数据（`docs/safety_points_implementation.md`）；`data.safety.*` 是**拍照核验**链路，两者互不覆盖、互不迁移。

---

## 1. `data.safety.points` — 点位（应检清单）

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `id` | string | ✅ | 稳定标识，`SC-01`…（沿用 `SC-` 前缀，避免与巡检 `Kxx`/消毒 `Dxx` 冲突） |
| `name` | string | ✅ | 点位名，如「冷藏柜 A 内部」 |
| `zone` | string | ✅ | 所属区域：`冷藏` / `清洗` / `备餐` / `垃圾区` / `前厅` … |
| `target` | string | ➖ | 该点位的**核验要点文案**（直接拼进视觉模型提示词，描述「什么算合格」） |
| `demo_image_url` | string\|null | ➖ | 规范样图地址（占位 URL 即可，**不预置真实照片**） |
| `enabled` | number | ✅ | `1` 启用 / `0` 逻辑删除（保留历史 `checks` 引用，不物理删除） |
| `sort` | number | ➖ | 排序权重，升序 |
| `note` | string\|null | ➖ | 备注 |

**空态兜底**：`data.safety.points` 缺失或全为 `enabled=0` 时，读取层回退 BFF 内置种子点位（`bff/lib/safety_plan.js` 的 `DEFAULT_POINTS`，8 个，覆盖冷藏/清洗/备餐/垃圾区等），保证新环境初始化后进度页仍有点位列表。内置种子**不预置写库**。

---

## 2. `data.safety.checks` — 核验记录

| 字段 | 类型 | 语义 |
|---|---|---|
| `id` | string | 核验记录 id（`chk_<base36 时间戳><6 位随机>`），算法层生成，全局唯一 |
| `point_id` | string | 关联 `data.safety.points[].id`（未知 id 在入队/校验阶段驳回） |
| `operator` | string | 上报人（工号/姓名；缺省取动作 `operator`） |
| `photo_url` | string\|null | 照片访问地址（对象存储直传后回填；**不存图片本体/base64**） |
| `ai_result` | `'pending'\|'pass'\|'fail'\|'error'` | AI 初判结果。`pending`=未回；`error`=调用失败（保留记录，可重试） |
| `ai_reason` | string\|null | AI 判定依据（自然语言摘要） |
| `ai_confidence` | number\|null | AI 置信度 `0-100`；`null`=未回/不可用 |
| `final_result` | `'pass'\|'fail'\|null` | 人工复核结论。**`null` = 未复核** |
| `review_reason` | string\|null | 人工复核理由（改判必填） |
| `status` | `'pending'\|'ai_done'\|'reviewed'\|'error'` | 流程状态（见下表） |
| `created_at` | string | 上报时刻 ISO8601（`taken_at` 缺失时由算法补当前时刻） |
| `reviewed_at` | string\|null | 复核时刻（`status='reviewed'` 时存在） |
| `reviewed_by` | string\|null | 复核人（老板/店长） |
| `model` | string\|null | AI 初判所用视觉模型（审计用） |

### 2.1 `status` 状态机

```
上报 safety.check ──► pending（ai_result=pending，员工端立即返回，不等待 AI）
                        │
      safety.ai_judge ──┼──► ai_done（ai_result=pass|fail，带 ai_reason/ai_confidence）
                        └──► error   （ai_result=error，保留原记录，可重新初判）

safety.review（老板/店长）──► reviewed（写入 final_result + review_reason，**ai_result 原样保留**）
                                同一 check 可多次复核，以最新一次为准
```

**硬红线**：`safety.review` 必须在 `bff/lib/policy.js` 的 `NEVER_AUTO` 中——AI 初判**不得**覆盖/替代人工复核；复核只写 `final_result`/`review_reason`，**不允许清空 `ai_result`**。

> 边界说明：`pending`（AI 未回）与 `error`（AI 失败）状态下**仍允许**人工直接下结论（人工优先）——否则 AI 不可用时现场无法闭环；此时 `ai_result` 保持原值（**不得伪造/改写初判**）。

### 2.2 派生口径 `effective_result`（不落库）

聚合层按下式给出「这条记录最终算过没过」，不新增存储字段：

```
effective_result = final_result                       // 已复核：以人工为准
                 || (ai_result === 'pass' ? 'pass'    // 未复核：暂以 AI 为准
                   : ai_result === 'fail' ? 'fail'
                   : null)                            // pending / error → 无结论
```

---

## 3. 进度聚合口径（`GET /api/safety/progress`）

| 返回字段 | 口径 |
|---|---|
| `date` | 统计日期 `YYYY-MM-DD`（默认今日，可用 `?date=` 指定） |
| `total_points` | 点位清单长度（`enabled≠0`） |
| `completed_points` | 当日有 `checks` 记录的**去重**点位数 |
| `pass_count` | `effective_result === 'pass'` 的记录数 |
| `fail_count` | `effective_result === 'fail'` 的记录数 |
| `review_count` | **待人工复核**：`final_result` 为空且 `ai_result === 'fail'`（AI 判不过，必须人工确认） |
| `error_count` | **AI 失败待处理**：`final_result` 为空且 `ai_result === 'error'` |
| `points[]` | 每个点位一条：最新一条 `check` + 点位信息 + `status` |

`points[].status`（展示态）：`none`（未上报）/ `pending`（待 AI）/ `pass` / `fail` / `review`（待人工复核）/ `error`（AI 失败待处理）。
`points[]` 同时回传该点的 `check_id / operator / photo_url / ai_result / ai_reason / ai_confidence / final_result / review_reason / created_at`，供后台直接渲染照片与 AI 初判。

> 红线自查：本端点**只读**——只调 `loadSnapshot()`，不写库、不入队、不改快照，无任何 `writeFile`/`enqueue` 调用。

---

## 4. 示例快照（可直接 `JSON.parse`）

```json
{
  "rev": 42,
  "generated_at": "2026-10-12T09:30:00.000Z",
  "data": {
    "safety": {
      "points": [
        {
          "id": "SC-01",
          "name": "冷藏柜 A 内部",
          "zone": "冷藏",
          "target": "冷柜内食材分区离地存放、无裸露、温度显示 0-4℃、无异味",
          "demo_image_url": "https://example.com/safety/demo/SC-01.jpg",
          "enabled": 1,
          "sort": 10,
          "note": "0-4℃ 冷藏区"
        },
        {
          "id": "SC-02",
          "name": "洗消池（三步池）",
          "zone": "清洗",
          "target": "水池洁净无残渣、消毒液配比标签在有效期内、抹布分区分色",
          "demo_image_url": "https://example.com/safety/demo/SC-02.jpg",
          "enabled": 1,
          "sort": 20,
          "note": null
        }
      ],
      "checks": [
        {
          "id": "chk_m1x2y3a4b5c6",
          "point_id": "SC-01",
          "operator": "张三",
          "photo_url": "https://cdn.example.com/safety/ST001/2026-10-12/SC-01-1a2b3c.jpg",
          "ai_result": "fail",
          "ai_reason": "冷藏柜内有两袋原料未密封且直接落地存放，与「离地存放、无裸露」要求不符；温度显示 6℃，超出 0-4℃ 范围。",
          "ai_confidence": 88.5,
          "final_result": null,
          "review_reason": null,
          "status": "ai_done",
          "created_at": "2026-10-12T01:12:30.000Z",
          "reviewed_at": null,
          "reviewed_by": null,
          "model": "kimi-k2.7-code-highspeed"
        },
        {
          "id": "chk_m1x2y3a4b5d7",
          "point_id": "SC-02",
          "operator": "李四",
          "photo_url": "https://cdn.example.com/safety/ST001/2026-10-12/SC-02-4d5e6f.jpg",
          "ai_result": "pass",
          "ai_reason": "三步池洁净，消毒液标签在有效期内，抹布按红/蓝分色悬挂。",
          "ai_confidence": 93.2,
          "final_result": "fail",
          "review_reason": "现场复查发现池底有残渣，AI 未拍到；人工改判不合格并已当场整改。",
          "status": "reviewed",
          "created_at": "2026-10-12T01:20:05.000Z",
          "reviewed_at": "2026-10-12T02:05:11.000Z",
          "reviewed_by": "店长",
          "model": "kimi-k2.7-code-highspeed"
        }
      ]
    }
  },
  "ext": {}
}
```

对应 `GET /api/safety/progress?date=2026-10-12` 的返回（节选）：

```json
{
  "ok": true,
  "date": "2026-10-12",
  "total_points": 8,
  "completed_points": 2,
  "pass_count": 0,
  "fail_count": 2,
  "review_count": 1,
  "error_count": 0,
  "points": [
    {
      "point_id": "SC-01",
      "name": "冷藏柜 A 内部",
      "zone": "冷藏",
      "status": "review",
      "check_id": "chk_m1x2y3a4b5c6",
      "operator": "张三",
      "photo_url": "https://cdn.example.com/safety/ST001/2026-10-12/SC-01-1a2b3c.jpg",
      "ai_result": "fail",
      "ai_reason": "冷藏柜内有两袋原料未密封且直接落地存放…",
      "ai_confidence": 88.5,
      "final_result": null,
      "review_reason": null,
      "created_at": "2026-10-12T01:12:30.000Z",
      "effective_result": "fail"
    },
    {
      "point_id": "SC-02",
      "name": "洗消池（三步池）",
      "zone": "清洗",
      "status": "fail",
      "check_id": "chk_m1x2y3a4b5d7",
      "operator": "李四",
      "photo_url": "https://cdn.example.com/safety/ST001/2026-10-12/SC-02-4d5e6f.jpg",
      "ai_result": "pass",
      "ai_reason": "三步池洁净…",
      "ai_confidence": 93.2,
      "final_result": "fail",
      "review_reason": "现场复查发现池底有残渣…",
      "created_at": "2026-10-12T01:20:05.000Z",
      "effective_result": "fail"
    }
  ]
}
```

口径对齐校验（上例）：`effective_result`：SC-01 = AI `fail`（未复核）→ `fail`；SC-02 = 人工 `fail` → `fail`。故 `fail_count=2`、`review_count=1`（SC-01 未复核且 AI 判 fail）、`error_count=0`、`completed_points=2`、`total_points=8`。

---

## 5. 写动作登记表（`bff/lib/algorithms/registry.js`）

| type | payload | 落点 | 分级 |
|---|---|---|---|
| `safety.check` | `{ point_id, photo_url, taken_at?, operator? }` | `data.safety.checks` 新增一行（`ai_result='pending'`） | 可自动执行 |
| `safety.ai_judge` | `{ check_id }` | 更新该行 `ai_result/ai_reason/ai_confidence/model`；失败写 `error`，**不删记录、不动 `final_result`** | 可自动执行 |
| `safety.review` | `{ check_id, final_result, reason }` | 更新该行 `final_result/review_reason/reviewed_at/reviewed_by`；**保留 `ai_result`** | **`NEVER_AUTO`：必须人工确认** |

写接口统一 `POST /api/actions`（需 `actions.write`）。只读端点权限由前端菜单/路由过滤；`admin-web` 与 Android **双轨**校验（见 `docs/分端机制与开发接入指南.md` §6.E）。
