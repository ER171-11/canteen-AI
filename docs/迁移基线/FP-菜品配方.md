# 迁移基线 · 菜品配方（源：旧 HTML 系统）

> 源系统：`old/store-inventory-legacy/熊猫五福餐厅进销存系统_真实数据版.html`
> 源页面：`#tab-dish`「菜品配方」（HTML 第 323–349 行区域）
> 目标系统：`apps/admin-web/src/pages/kitchen/RecipesPage.tsx` + `DishesPage.tsx` + `components/BomTable.tsx`
> 模式：**替代**（全部 ⬜ 视为回归缺陷，需排期补齐）
> 建立日期：2026-09-28　最近更新：2026-10-13（**18/18 收官**）　状态：🟡 **待人工复核**（AI 抽取，未经人工签字）　规范依据：`docs/规范/迁移颗粒度规范.md`
> **行号复核**：2026-10-10 W1 补齐 FP-DISH-11/12 后，按 `DishesPage.tsx`（308 行）/`export.js`（360 行）/`admin.js`（116 行）全表复核新版行号。
> **收官复核**：2026-10-13 补齐 FP-DISH-06/16/17/18 后，按 `DishesPage.tsx` / `RecipesPage.tsx` / `components/RecipeImportModal.tsx` / `recipeTemplate.ts` / `bff/routes/kitchen.js` / `bff/lib/recipe_import.js` / `bff/lib/algorithms/dish.js` / `bff/routes/admin.js` 再核新版行号。

---

## 功能点清单

| FP ID | 功能点 | 旧版证据 | 新版现状 | 状态 | 处置 / 关联 |
|---|---|---|---|---|---|
| FP-DISH-01 | 新增菜品（名称/类型/售价/估算成本/在售） | HTML:326 `#btnNewDish` → `openDish(null)` :2656 | `DishesPage.tsx`:194「新增菜品」→ Modal :209、`dish.upsert` :217 | ⬆️ 已移植 | 验证：新增后到审批中心可见 |
| FP-DISH-02 | 编辑菜品主数据 | HTML:2656 `openDish(d)`（字段 :2660-2664） | `DishesPage.tsx`:150「编辑」→ Modal :209-265（name/cat/price/est/on） | ⬆️ 已移植 | 验证：改任一道菜并提交 |
| FP-DISH-03 | 修改菜品售价 | HTML:2637 `data-price` → :2649 即时保存 | `DishesPage.tsx`:153「调价」→ Modal :267-294，`dish.price` :275（含调价原因） | ⬆️ 已移植 | 验证：点调价 → 填新价与原因 → 入队（形态由行内改弹窗，能力更强） |
| FP-DISH-04 | 修改估算食材成本（未配配方时使用） | HTML:2636 `data-est` → :2648 | `DishesPage.tsx`:258「成本估」字段（`dish.upsert` 携带 est :223） | ⬆️ 已移植 | 验证：编辑菜品改成本估 |
| FP-DISH-05 | 停售 / 上架切换 | HTML:2642 `data-dishtoggle` → :2653 | `DishesPage.tsx`:156-168「上架/下架」→ `dish.set_active` :161 | ⬆️ 已移植 | 验证：点「下架」，列表 Tag 变「已下架」 |
| FP-DISH-06 | 删除菜品（含其配方，有销售记录则禁删） | HTML:2654 `data-dishdel` → `delDish()` :2675（保护 :2676） | `DishesPage.tsx`:183-201「删除」Popconfirm（`sold` 时禁用 + Tooltip 原因；提交 `dish.delete` :194）→ `registry.js`:70 → `dish.js`:642 `applyDishDelete`（引用校验 `dishReferencedBySales` :614，命中销售即拒 :650-652；同时解除 `data.rec[id/sku_id]` 配方绑定 :653-662，金丰配方主数据保留）；`admin.js`:162-167 下发 `sold`（与执行器同规则） | ⬆️ 已移植 | 2026-10-13 补齐。验证：删一道无销售记录的菜 → 审批中心确认 → 菜品消失且配方绑定解除；有销售的菜按钮禁用；两条断言见 `bff/lib/algorithms/dish_import_delete.test.js` |
| FP-DISH-07 | 编辑配方 BOM（增删原料行、填净料用量与单位） | HTML:2641 `data-rec` → `openRecipe()` :2697、`recRowsHtml()` :2682、添加行 :2733、删行 :2732、保存 :2734 | `RecipesPage.tsx`:254「编辑配料」→ Modal :431、`recipe.upsert` :443、Form.List :522-564 | ⬆️ 已移植 | 验证：选配方 → 编辑配料 → 加行/删行 → 提交 |
| FP-DISH-08 | 配方编辑时实时算「毛料消耗 + 行成本 + 合计 + 毛利率」 | HTML:2715-2729 `sync()`（毛料 `qty/yld` :2720、行成本 `lc` :2692、合计 :2724、毛利率 :2726） | `RecipesPage.tsx` `calcLine()`（毛料=净料/出成率、行成本=毛料×均价）、编辑弹窗 Form.List 行内「毛料消耗/行成本」实时列、底部「配方成本（实时）+ 毛利率」条（`Form.useWatch` 联动）；只读成本卡 `recipe_cost.js` 同步做 `qty/yld` 毛料还原 | ⬆️ 已移植 | 验证：编辑配料改用量/选原料 → 行成本与合计实时刷新 |
| FP-DISH-09 | 成本来源标识（配方成本 vs 估算成本） | HTML:2634 `dishCostType()` :1131 | `RecipesPage.tsx`:269-277「动态均价 / 静态价盘」Tag | ⬆️ 已移植 | 验证：成本卡标题旁 Tag |
| FP-DISH-10 | 菜品毛利率展示（并按 ≥60% / <45% 分色） | HTML:2638 `gm` 分色 | `RecipesPage.tsx`:306-310（动态）、:328-332（静态价盘） | ⬆️ 已移植 | 验证：看成本卡毛利率 |
| FP-DISH-11 | 近 30 天销量展示 | HTML:2639 `dishSalesAgg(d,30)`、`dishSalesAgg()` :2613 | `DishesPage.tsx`:129-137「近30天销量」列（`q30`）+ `bff/routes/export.js`:189-206 `dishSalesAgg` + `admin.js`:100-110 附 `q30` | ⬆️ 已移植 | 只读聚合；口径「date≥today−29 含今日」，与旧版 `daysAgo(29)` 一致 |
| FP-DISH-12 | 近 30 天毛利额展示 | HTML:2639 `a.gp`（:2630 取 `dishSalesAgg(d,30)`） | `DishesPage.tsx`:138-147「近30天毛利额」列（`gp30`，正绿负红）；`gp30=营收−每份成本×销量`（同源 `dishSalesAgg`） | ⬆️ 已移植 | 只读聚合，随 FP-DISH-11 |
| FP-DISH-13 | 配方原料数展示 +「未配置」提示 | HTML:2640 `nLines?…:'未配置'` | `BomTable.tsx`:12/19 空态「未配置」；`RecipesPage.tsx`:384-396 渲染 face_main/main/aux/seasoning | ⬆️ 已移植 | 验证：未配原料的配方显示「未配置」 |
| FP-DISH-14 | 菜品分类筛选 | HTML:330 `#dishTabs` → `renderDishTabs()` :2620、:2611 | `DishesPage.tsx`:179「按分类筛选」Select（RecipesPage 另有按五色分组 :195-212） | ⬆️ 已移植 | 验证：切换分类下拉 |
| FP-DISH-15 | 菜品名称搜索 | HTML:329 `#dishSearch` → :2610 | `DishesPage.tsx`:187 `Input.Search` | ⬆️ 已移植 | 验证：输入菜名回车 |
| FP-DISH-16 | 批量导入食谱卡（xlsx/伪 xls/html/csv/json，表头自动定位 + 手动指定列 + 预览确认） | HTML:327 `#fileRecImport` → :3797 监听、`previewRecImport()` :3709、`commitRecImport()` :3754；说明 :344-346 | `RecipesPage.tsx`:233「批量导入」→ `components/RecipeImportModal.tsx`（文件选择 :238-249、`runPreview` :137、手动指定列面板 :275-353）→ 预览 `api/recipeImport.ts`:98 `POST /api/kitchen/recipes/import/preview`（`routes/kitchen.js`:237 → `lib/recipe_import.js`:375 `previewRecImport`，格式层 `sniffFormat/parseXlsxBytes/parseHtmlTables/parseCsvText` 整层复用 `recv_import.js`）→ 提交 `recipe.import`（`RecipeImportModal.tsx`:173-208，整批一个动作；`registry.js`:74 → `dish.js`:735 `applyRecipeImport`） | ⬆️ 已移植 | 2026-10-13 补齐。写类：预览纯计算零写（`kitchen_import.test.js` 断言上传体零落盘），提交走审批队列；已有菜不重复建档、菜名多行自动合并 |
| FP-DISH-17 | 下载食谱卡导入模板 | HTML:328 `#btnRecTpl` → `downloadRecTemplate()` :3784 | `RecipesPage.tsx`:236「下载模板」→ `recipeTemplate.ts`:23 `downloadRecipeTemplate()`（列口径 `REC_TEMPLATE_COLS` :14-21 与 BFF `IMP_REC_DEFS` 同义词表对齐；输出带 BOM 的 CSV，纯只读、零请求） | ⬆️ 已移植 | 2026-10-13 补齐。验证：点「下载模板」得「食谱卡批量导入模板_日期.csv」，含 2 行示例 |
| FP-DISH-18 | 导入时未匹配原料/菜品自动建档 | HTML:2747-2749 注释规则 + `commitRecImport()` :3754 | `dish.js`:744-767 `applyRecipeImport`：先按文件内「库存单位/原料分类」补建原料（对齐旧版 `createIngFromImport` HTML:2806），再逐道菜复用**唯一写入口** `upsertRecipe`（:851，`ensure_ings` 缺料建档 + `sync_dish` 同步菜品壳） | ⬆️ 已移植 | 2026-10-13 补齐。与手工「新增菜谱」同一条写路径，不另起分支 |

## 汇总

| 项 | 数 |
|---|---|
| FP 总数 | 18 |
| ⬆️ 已移植 | 18 |
| 🔄 等价替代 | 0 |
| ⬜ 待补 | 0 |
| ⚰️ 废弃 | 0 |

> **2026-09-28 更正**：汇总原记「⬆️ 10 / ⬜ 8」，与上方 18 行的实际标注（⬆️ 11 / ⬜ 7）不符，已按行标注为准更正。
> **2026-10-13 收官**：汇总 ⬆️ 18 / ⬜ 0，与行标注一致（`scripts/gen-debt-table.ps1 -Check` 可验）。

**结论**：菜品配方 **18/18 全部 ⬆️ 已移植**，为 9 页基线中首个满分页。
2026-10-13 补齐最后 4 项：删除菜品（FP-DISH-06）+ 食谱卡批量导入全家桶（FP-DISH-16/17/18）。
> **2026-10-10 W1 更新**：补齐近 30 天销量/毛利额（FP-DISH-11/12）两列，均为只读聚合；
> 复用 `export.dishSalesAgg`（`dishCostMap` 配方成本 + `near30Agg` 近30天销量，同口径不重复实现），
> 菜品列表由 `/api/admin/dishes` 直接附带 `q30`/`gp30`，前端零额外请求。
> **2026-10-13 收官更新**：
> - **FP-DISH-06** 删除菜品：`dish.delete` 走 `/api/actions` 审批队列（不直改库），有销售记录禁删（`sold` 前端禁用 + 执行器二次拦截），删除同时解绑 `data.rec` 配方、保留金丰配方主数据。
> - **FP-DISH-16/17/18** 食谱卡导入：预览走只读端点（纯计算、零写、8MB 上限、失败 400 带文案），
>   提交整批一个 `recipe.import` 动作进审批队列；未匹配原料/菜品沿用 `upsertRecipe` 的建档口径，
>   不新增第二条写路径。验证：`bff/lib/recipe_import.test.js`、`bff/lib/algorithms/dish_import_delete.test.js`、
>   `bff/routes/kitchen_import.test.js` 全绿。

## 建议补齐顺序

1. ~~**FP-DISH-11 / 12** 近 30 天销量与毛利（只读聚合，老板看板要用）~~ ✅ 已完成（W1，2026-10-10）
2. ~~**FP-DISH-08** 配方编辑态实时成本 + 毛料还原~~ ✅ 已完成（W1，2026-10-10）
3. ~~**FP-DISH-16 / 17 / 18** 食谱卡批量导入全家桶（唯一批量录入通道，业务闭环）~~ ✅ 已完成（2026-10-13）
4. ~~**FP-DISH-06** 删除菜品（低优先，可先用停售替代）~~ ✅ 已完成（2026-10-13）

→ 本页无剩余待补项；后续仅需人工复核签字（规范 §2.2）与真机走查。

## 备注

- 本清单由 AI 从源码抽取，**未经人工复核**，按 `docs/规范/迁移颗粒度规范.md` §2.2 复核后才可转为正式基线。
- FP-DISH-03 形态由「行内直改」变为「弹窗 + 审批队列」，属**能力增强**，不计为缺失。
- 本页 4 个写类动作（`dish.delete` / `recipe.import`）均只在审批中心确认后才落库；
  食谱卡导入为**整批一个动作**（同 `recv.import` 型），撤回按批次粒度处理。
