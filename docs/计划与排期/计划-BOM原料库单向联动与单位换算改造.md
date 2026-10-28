# 计划文档：BOM 餐谱 × 原料仓「单向联动 + 结构化换算」改造

> 状态：**已落地**（2026-10-23 执行完毕，随 `0.1.1` 发布；2026-10-28 补齐测试与文档回填）。
> 关联：当前 bug —— BOM 编辑器选原料后「单位（包规）被强制覆盖」，但实际不影响计算，属误导。
> 生成日期：2026-10-22 ｜ 落地日期：2026-10-23

---

## 一、背景与核心矛盾

用户原话：「选原料时单位会跟着变，不大合理」。根因已查清：

- BOM 行上的 `unit` 字段目前**只是个展示副本**——选原料时在 `RecipesPage.tsx:598` 被 `next[field.name].unit = hit.unit` 强写成原料库存单位（桶/瓶），但**成本计算完全不看这个字段**。
- 成本口径（`shared/recipe-cost/index.mjs` 的 `calcLineCost`）只收 `qty` 和 `ing`，隐含「数量按原料库存单位填写」；桶/瓶→克 靠 `gramsPerUnit()` 从**原料名里正则抠规格**（`1.9L→1900g`）间接折算，解析失败则行成本显示「—」。
- 于是「选了就改单位、但改了又不算」是半吊子状态，既误导填数人，又无法支持「菜谱按自身单位（g/kg/ml）填写」的真实诉求。

**用户的架构设想（已确认）：** 原料仓与菜谱是两份数据的交流，但**原料仓只改 BOM 的「原料列」**，用量/单位严格按菜谱一方口径，中间的单位差异由**独立的换算程序**处理。

---

## 二、三项已确认决策（执行红线）

| # | 决策点 | 结论 |
|---|---|---|
| q0 | 原料库换算数据 | 加**结构化字段** `base_unit`（g/ml/个）+ `pack_in_base`（每库存单位含多少基础单位），替代名称正则抠规格 |
| q1 | 引用未建档原料 | **拦截报错**，要求先建档；删除现有的「缺料自动建档」反向写库逻辑，保持单向原则 |
| q2 | 维度不兼容 | 菜谱单位与原料包规维度冲突（重量↔体积、缺折算系数）时**报警 + 行成本留空（—）**，不阻断保存 |

附加约定：出成率 `yld` 继续由原料仓侧提供（属原料属性，符合单向模型）。

---

## 三、当前机制（执行前必读，含精确落点）

### 3.1 前端联动覆盖逻辑（bug 根源）
`apps/admin-web/src/pages/kitchen/RecipesPage.tsx`
- `586-589`：下拉 `label` 拼 `名称 · 库存单位`，后缀的规格（1.9L）是名称自带文本。
- `591-600`：`onChange` 内 `if (hit?.unit) next[field.name].unit = hit.unit` —— **需删除的覆盖逻辑**。
- `565`：新增行默认 `add({ unit: 'g' })`（保留，作为可编辑占位）。
- `572`：`const c = calcLineCost(line?.qty, ing)` —— 当前调用（不传 unit）。
- `609-620`：毛料消耗 / 行成本渲染列。
- `485-502`：`onOk` 提交走 `submitAndConfirmAction({ type: 'recipe.upsert', payload: { ..., ensure_ings, sync_dish } })`。
- `514-516`：缺料提示文案；`549-551`：`ensure_ings`（缺料建档）Switch；`215-216`：初始 `ensure_ings:true, sync_dish:true`。

### 3.2 成本核心（前后端共用唯一事实来源）
`shared/recipe-cost/index.mjs`（ESM 零依赖零 I/O）
- `UNIT_TO_G`（10 行）；`ASSUMED_SPEC_G`（12-17，白名单兜底）。
- `SPEC_RE`（29）/ `gramsPerUnit(ing)`（84-98）：靠名称正则 + 白名单猜克重。
- `calcLineCost(qty, ing)`（124-133）：只收 qty/ing，返回 `{ gross, lineCost }`，**不看行单位**。
- 前端经 `apps/admin-web/src/lib/recipeCostCore.ts:5` re-export 此文件。

### 3.3 后端成本卡
`bff/lib/recipe_cost.js` `buildCostCard`（107 起）：`gramsPerUnit` 同款；`167` 行 `unit: ing.unit` 直接取原料单位；行成本 `unitPrice = perUnit/gpu`（150-157）。

### 3.4 后端保存反向建档（待删除）
`bff/lib/algorithms/dish.js` `upsertRecipe`（851 起）
- `928-966`：**缺料自动建档**——按正则从 BOM 行反推单位并 `applyIngUpsert` 写 `data.ings`，违反单向原则。**改为拦截报错**。
- `applyIngUpsert` 来自 store-node 合并逻辑，不改动。

### 3.5 原料数据结构
`apps/admin-web/src/api/types.ts` `IngItem`（904-951）：含 `unit/buy/pack/packQty/conv/avg/yld/last/on/...`。**需加 `base_unit?` / `pack_in_base?`**。
- `SnapshotData.ings?: IngItem[]`（1315-1316）；原料是快照 JSON `data.ings`，**非独立 SQL 表**。
- 采购单位→库存单位换算 `conv` 用于进销存（`bff/lib/supply.js:211-217`、`bff/lib/price.js:92-131`），**不进 BOM 成本**，本次不动。

### 3.6 原料录入表单落点
`apps/admin-web/src/pages/inventory/StockPage.tsx`
- `175-183`：编辑态初始值（含 `conv`、`yld`）。
- `473-477`：提交时 `yld` 百分比→分数折算。
- `555-559`：`pack` / `conv` 录入项；`596-598`：`yld`「出成率 %」录入项。**新字段 `base_unit` / `pack_in_base` 加在 yld 附近**。

---

## 四、目标架构（设计规格）

### 4.1 数据流契约
```
菜谱 BOM 行(name, qty, unit)  ──┐
                                 ├─→ 换算程序 shared/recipe-cost（纯函数）
原料仓 IngItem(base_unit,       ─┘
  pack_in_base, avg, yld)          │
   ├─ 维度兼容 → 行成本 = numPacks × avg / yld
   └─ 维度不兼容 → { lineCost:null, dimMismatch:true } → UI 行标红 + 显示「—」
菜谱引用名 ──→ 缺失校验(dish.js) ──缺料──→ 拦截报错(列出缺失原料)
```
**单向原则：原料仓只写「原料列」；用量/单位永远以菜谱侧为准。**

### 4.2 换算核心 API（shared/recipe-cost/index.mjs 扩展）
新增导出（不破坏旧签名）：
- `DIM_OF_UNIT`：重量{g/克/kg/公斤/斤/两} / 体积{ml/l/L/升} / 计数{个/只/把/袋/根/片/枚/份}。
- `unitToBase(dim, unit)`：1 个该单位 = 多少基础单位（重量用 g 基准、体积用 ml 基准、计数=1）。
- `packInBase(ing)`：优先 `ing.pack_in_base`；缺失回退 `gramsPerUnit(ing)`（兼容旧数据）。
- `inferBaseUnit(ing)`：从 `name`（SPEC_RE 抠 1.9L/500g）+ `unit` 推导 `{ base_unit, pack_in_base }`，用于旧数据兜底。
- `calcLineCost(qty, ing, unit?)`（改造）：
  - 传 `unit`：维度感知路径 `numPacks = qty × unitToBase(ing.dim, unit) / packInBase(ing)`；`lineCost = numPacks × avg / yld`。
  - 维度不一致或 `packInBase` 缺失：返回 `{ gross, lineCost: null, dimMismatch: true }`。
  - 不传 `unit`：保留旧行为（视为按库存单位填），**既有调用零回归**。

### 4.3 原料库类型与录入
- `IngItem` 增加：
  ```ts
  /** 基础/标准单位：g(重量) | ml(体积) | 个(计数)，成本折算统一口径 */
  base_unit?: 'g' | 'ml' | '个'
  /** 每 1 个库存单位含多少基础单位（桶 1.9L → base_unit='ml', pack_in_base=1900） */
  pack_in_base?: number
  ```
- `StockPage.tsx` 表单增加「基础单位 / 每包基础量」录入，随 `applyIngUpsert` 写回快照（百分比思维同 yld）。

### 4.4 前端编辑器行为
- **删除** `598` 行 `if (hit?.unit) next[field.name].unit = hit.unit`（只回填 `name`，严守「只改原料列」）。
- 行成本改用 `calcLineCost(line.qty, ing, line.unit)`；`dimMismatch` 时该行整体标红 + 行成本列显示「—」。
- 下拉 `label` 仍展示 `名称 · 库存单位`，仅作参考，不再回写单位。

### 4.5 缺料拦截（单向原则）
- `dish.js` 删除 `928-966` 自动建档；改为保存前收集 `main/aux/seasoning` 全部原料名与 `data.ings` 比对，缺失则**返回明确错误（列出缺失名）**，阻断保存。
- 前端：`514-516` 文案改为「配料须先在产品库建档」；移除 `ensure_ings` Switch（`549-551`、`215-216`、`498`）；`onOk` 提交前做同样预校验，`message.error` 列出缺失原料并阻断。

### 4.6 后端成本卡对齐（保守）
- `recipe_cost.js` `buildCostCard` 接入新 `calcLineCost(qty, ing, unit)`；对无显式单位的历史 BOM 字符串保留 `UNIT_TO_G` 旧解析兜底，**既有成本报表不回归**。

---

## 五、任务分解（跨对话执行清单）

| ID | 任务 | 依赖 | 状态 |
|---|---|---|---|
| core-convert | 扩展 `shared/recipe-cost` 为维度感知换算核心（base_unit/pack_in_base + inferBaseUnit 兜底） | — | ✅ |
| types-editor | `IngItem` 加 base_unit/pack_in_base；`StockPage` 原料表单增加录入 | core-convert | ✅ |
| recipes-ui | 改造 `RecipesPage`：移除单位覆盖、接入带单位换算、不兼容行标红 | core-convert | ✅ |
| unknown-block | `dish.js` 移除自动建档改为缺料拦截；前端提交前校验并提示 | recipes-ui | ✅ |
| backend-align | `bff/recipe_cost.js` 接入新换算（保留旧解析兜底） | core-convert | ✅ |
| verify | 单测 + `tsc --noEmit` + 浏览器 E2E（选料不改单位 / 不兼容报警 / 缺料拦截） | 全部前置 | ✅（单测 9/9 + 算法层 26/26 + `tsc` 通过） |

### 执行注意
- **禁止改动** `serializeRecipe`（dish.js:1073）与 BOM 行 `{name,qty,unit}` JSON 存储结构，单位早已落库，仅消费方式变化。
- `calcLineCost` 签名变更需同步前端两处调用（当前 `572` 与 `lib/recipeCostCore` 透传）与后端引用处；旧调用（不传 unit）行为不变。
- 不在选原料 `onChange` 内做任何跨字段副作用。
- 拦截缺料返回的错误结构需与前端 `message.error(err.response?.data?.error)`（507 行）解析一致。
- 向后兼容：结构化字段可选，`inferBaseUnit` 兜底，旧数据无需人工补录即可继续出成本；新字段为空时退化为现行行为，杜绝静默成本突变。
- 维度冲突永不静默算错，一律 `lineCost:null + dimMismatch`，UI 显式标红。

---

## 六、验收标准

1. 选原料后，**单位框不再被覆盖**（保持菜谱侧原值，新增行默认 `g`）。
2. 菜谱行按自身单位（g/kg/ml/桶/瓶）填写，行成本正确折算（例：桶 1.9L、avg 12 元/桶，菜谱填 18g → 18/1900×12 ≈ 0.11 元）。
3. 维度不兼容（重量↔体积、或原料缺 pack_in_base）时，该行标红、行成本显示「—」，保存不被阻断。
4. 引用未建档原料保存时，被拦截并列出缺失原料名；不再自动反向建档。
5. `tsc --noEmit` 通过；既有成本报表（无显式单位的历史 BOM）数值不回归。

---

## 七、待后续对话确认 / 开放问题

- 原料 `base_unit` 的录入是否强制（新建原料必须填），还是允许留空走 `inferBaseUnit` 兜底？建议新建强制、旧数据兜底。
- 计数维度（个/只/把）的「每包基础量」如何定义（如 1 袋=30 枚）？是否纳入换算还是仅展示？
- 是否需要一次性脚本把现有 `data.ings` 的 `pack_in_base` 按 `inferBaseUnit` 预填，降低运行期兜底压力？

---

## 八、落地记录（2026-10-23 执行 / 2026-10-28 测试与文档回填）

**换算核心**（`shared/recipe-cost/index.mjs`，前后端唯一事实来源）
- 新增 `DIM_OF_UNIT` / `DIM_OF_BASE` / `unitToBase(dim,unit)` / `packInBase(ing)` / `inferBaseUnit(ing)`；
  `calcLineCost(qty, ing, unit?)` 改为维度感知：`numPacks = qty × unitToBase / packInBase`，`lineCost = numPacks × avg / yld`。
- 维度不兼容或 `packInBase` 缺失 → `{ gross, lineCost: null, dimMismatch: true }`（UI 标红 + 显示「—」，不阻断保存）；
  不传 `unit` 保持旧行为（既有调用零回归）。
- 单测 `shared/recipe-cost/index.test.mjs` 9/9（含「体积原料按 g 填写判不兼容」「不传 unit 零回归」）。

**原料库录入**（`apps/admin-web`）
- `IngItem` 增加 `base_unit`（g/ml/个）与 `pack_in_base`；`StockPage` 编辑弹窗在「出成率」旁新增「基础单位 / 每包基础量」两项，
  提交时随 `ing.upsert` 写回快照（未改动不写键）。

**菜谱编辑器**（`RecipesPage`）
- 删除选料 `onChange` 中的 `next[field.name].unit = hit.unit`，严守「原料仓只改原料列」；下拉开头的「名称 · 库存单位」仅作参考。
- 行成本改用 `calcLineCost(line.qty, ing, line.unit)`；`dimMismatch` 行整体标红、成本列显示「—」并提示「单位不兼容」。

**后端**（`bff/lib/algorithms/dish.js` / `bff/lib/recipe_cost.js`）
- `upsertRecipe` 删除缺料自动建档（原 928-966），改为**写库前校验**：`main/aux/seasoning` 全部原料与 `data.ings` 比对，
  缺失即 `throw 缺料未建档：<名清单>（请先在原料仓建档后再保存菜谱）`，避免「菜谱已写、原料缺失」的半成品状态；`清水/水/料水` 仍跳过。
- `applyRecipeImport`（食谱卡导入）同步删除自动建档块（2026-10-28 收口）；`ensure_ings` 入参仅为向后兼容保留、已无写库副作用，导入缺料同样拦截。
- `buildCostCard` 接入带单位行成本，历史无单位 BOM 仍走 `UNIT_TO_G` 旧解析兜底（成本报表零回归）。

**测试与验证**
- `dish.test.js` 60 例通过（两处 `recipeUpsert*` 平价夹具补齐已建档原料；新增 Node 超集断言「缺料拦截 + 不写库 + 不反向建档」，Python 参考实现仍自动建档故不对拍）。
- `dish_import_delete.test.js` 27 例通过（原「自动建未匹配原料 / ensure_ings=false 不建料」两条改为「缺料拦截 + 不写库 + 原料未被反向建档」）。
- 算法层 **26/26 全绿**（本改造前长期 24/26）；`tsc --noEmit` 通过；`recipe_cost.test.js`、`shared/recipe-cost` 单测全绿。

**未做（有意）**
- 浏览器 E2E 未脚本化（选料不改单位 / 不兼容标红为人工核对）；Android/iOS 双端不涉及 BOM 编辑。
- 新建原料的 `base_unit` 未强制必填，仍允许留空走 `inferBaseUnit` 兜底（见 §7 开放问题，待产品确认）。
