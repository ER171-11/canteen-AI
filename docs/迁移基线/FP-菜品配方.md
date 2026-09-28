# 迁移基线 · 菜品配方（源：旧 HTML 系统）

> 源系统：`old/store-inventory-legacy/熊猫五福餐厅进销存系统_真实数据版.html`
> 源页面：`#tab-dish`「菜品配方」（HTML 第 323–349 行区域）
> 目标系统：`apps/admin-web/src/pages/kitchen/RecipesPage.tsx` + `DishesPage.tsx` + `components/BomTable.tsx`
> 模式：**替代**（全部 ⬜ 视为回归缺陷，需排期补齐）
> 建立日期：2026-09-28　状态：🟡 **待人工复核**（AI 抽取，未经人工签字）　规范依据：`docs/迁移颗粒度规范.md`

---

## 功能点清单

| FP ID | 功能点 | 旧版证据 | 新版现状 | 状态 | 处置 / 关联 |
|---|---|---|---|---|---|
| FP-DISH-01 | 新增菜品（名称/类型/售价/估算成本/在售） | HTML:326 `#btnNewDish` → `openDish(null)` :2656 | `DishesPage.tsx`:194「新增菜品」→ Modal :209、`dish.upsert` :217 | ⬆️ 已移植 | 验证：新增后到审批中心可见 |
| FP-DISH-02 | 编辑菜品主数据 | HTML:2656 `openDish(d)`（字段 :2660-2664） | `DishesPage.tsx`:150「编辑」→ Modal :209-265（name/cat/price/est/on） | ⬆️ 已移植 | 验证：改任一道菜并提交 |
| FP-DISH-03 | 修改菜品售价 | HTML:2637 `data-price` → :2649 即时保存 | `DishesPage.tsx`:153「调价」→ Modal :267-294，`dish.price` :275（含调价原因） | ⬆️ 已移植 | 验证：点调价 → 填新价与原因 → 入队（形态由行内改弹窗，能力更强） |
| FP-DISH-04 | 修改估算食材成本（未配配方时使用） | HTML:2636 `data-est` → :2648 | `DishesPage.tsx`:258「成本估」字段（`dish.upsert` 携带 est :223） | ⬆️ 已移植 | 验证：编辑菜品改成本估 |
| FP-DISH-05 | 停售 / 上架切换 | HTML:2642 `data-dishtoggle` → :2653 | `DishesPage.tsx`:156-168「上架/下架」→ `dish.set_active` :161 | ⬆️ 已移植 | 验证：点「下架」，列表 Tag 变「已下架」 |
| FP-DISH-06 | 删除菜品（含其配方，有销售记录则禁删） | HTML:2654 `data-dishdel` → `delDish()` :2675（保护 :2676） | 无（`DishesPage.tsx` 操作列 :145-171 无删除） | ⬜ 待补 | 写类：`dish.delete` 建议动作 + 引用校验 |
| FP-DISH-07 | 编辑配方 BOM（增删原料行、填净料用量与单位） | HTML:2641 `data-rec` → `openRecipe()` :2697、`recRowsHtml()` :2682、添加行 :2733、删行 :2732、保存 :2734 | `RecipesPage.tsx`:254「编辑配料」→ Modal :431、`recipe.upsert` :443、Form.List :522-564 | ⬆️ 已移植 | 验证：选配方 → 编辑配料 → 加行/删行 → 提交 |
| FP-DISH-08 | 配方编辑时实时算「毛料消耗 + 行成本 + 合计 + 毛利率」 | HTML:2715-2729 `sync()`（毛料 `qty/yld` :2720、行成本 `lc` :2692、合计 :2724、毛利率 :2726） | 部分：合计/毛利率在只读成本卡 `RecipesPage.tsx`:297-310、bom_lines 表 :351-380；**编辑弹窗内无实时行成本、无毛料还原** | ⬜ 待补 | 只读展示已有一半；缺编辑态实时反馈与出成率还原（依赖 FP-ING-04） |
| FP-DISH-09 | 成本来源标识（配方成本 vs 估算成本） | HTML:2634 `dishCostType()` :1131 | `RecipesPage.tsx`:269-277「动态均价 / 静态价盘」Tag | ⬆️ 已移植 | 验证：成本卡标题旁 Tag |
| FP-DISH-10 | 菜品毛利率展示（并按 ≥60% / <45% 分色） | HTML:2638 `gm` 分色 | `RecipesPage.tsx`:306-310（动态）、:328-332（静态价盘） | ⬆️ 已移植 | 验证：看成本卡毛利率 |
| FP-DISH-11 | 近 30 天销量展示 | HTML:2639 `dishSalesAgg(d,30)`、`dishSalesAgg()` :2613 | `DishesPage.tsx`:131「销量」列（`q` 字段，口径未标明近 30 天） | ⬜ 待补 | 只读聚合：需明确口径或补「近30天」标注 |
| FP-DISH-12 | 近 30 天毛利额展示 | HTML:2639 `a.gp`（:2630 取 `dishSalesAgg(d,30)`） | 无（DishesPage 列无毛利；`WeeklyReportPage.tsx` 的毛利分析非本页） | ⬜ 待补 | 只读聚合，随 FP-DISH-11 |
| FP-DISH-13 | 配方原料数展示 +「未配置」提示 | HTML:2640 `nLines?…:'未配置'` | `BomTable.tsx`:12/19 空态「未配置」；`RecipesPage.tsx`:384-396 渲染 face_main/main/aux/seasoning | ⬆️ 已移植 | 验证：未配原料的配方显示「未配置」 |
| FP-DISH-14 | 菜品分类筛选 | HTML:330 `#dishTabs` → `renderDishTabs()` :2620、:2611 | `DishesPage.tsx`:179「按分类筛选」Select（RecipesPage 另有按五色分组 :195-212） | ⬆️ 已移植 | 验证：切换分类下拉 |
| FP-DISH-15 | 菜品名称搜索 | HTML:329 `#dishSearch` → :2610 | `DishesPage.tsx`:187 `Input.Search` | ⬆️ 已移植 | 验证：输入菜名回车 |
| FP-DISH-16 | 批量导入食谱卡（xlsx/伪 xls/html/csv/json，表头自动定位 + 手动指定列 + 预览确认） | HTML:327 `#fileRecImport` → :3797 监听、`previewRecImport()` :3709、`commitRecImport()` :3754；说明 :344-346 | 无；admin-web 全量无导入组件，后端 `bff/routes/` 无食谱卡导入端点 | ⬜ 待补 | 写类：**录入通道缺失，优先**；复用既有解析链路 + 唯一写入口 |
| FP-DISH-17 | 下载食谱卡导入模板 | HTML:328 `#btnRecTpl` → `downloadRecTemplate()` :3784 | 无 | ⬜ 待补 | 随 FP-DISH-16，只读文件输出 |
| FP-DISH-18 | 导入时未匹配原料/菜品自动建档 | HTML:2747-2749 注释规则 + `commitRecImport()` :3754 | 部分：`RecipesPage.tsx`:455 `ensure_ings`（缺料自动建档，:472 文案）仅覆盖手工编辑路径 | ⬜ 待补 | 写类：随 FP-DISH-16 打通 |

## 汇总

| 项 | 数 |
|---|---|
| FP 总数 | 18 |
| ⬆️ 已移植 | 11 |
| 🔄 等价替代 | 0 |
| ⬜ 待补 | 7 |
| ⚰️ 废弃 | 0 |

> **2026-09-28 更正**：汇总原记「⬆️ 10 / ⬜ 8」，与上方 18 行的实际标注（⬆️ 11 / ⬜ 7）不符，已按行标注为准更正。

**结论**：菜品配方是 8 页中**完成度最高**的一页（18 项中 10 项已移植），
主要缺口是**批量录入通道（食谱卡导入全家桶）**与**编辑态实时成本反馈**。

## 建议补齐顺序

1. **FP-DISH-11 / 12** 近 30 天销量与毛利（只读聚合，老板看板要用）
2. **FP-DISH-08** 配方编辑态实时成本 + 毛料还原（依赖 FP-ING-04 出成率）
3. **FP-DISH-16 / 17 / 18** 食谱卡批量导入全家桶（唯一批量录入通道，业务闭环）
4. **FP-DISH-06** 删除菜品（低优先，可先用停售替代）

## 备注

- 本清单由 AI 从源码抽取，**未经人工复核**，按 `docs/迁移颗粒度规范.md` §2.2 复核后才可转为正式基线。
- FP-DISH-03 形态由「行内直改」变为「弹窗 + 审批队列」，属**能力增强**，不计为缺失。
