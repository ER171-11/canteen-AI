# ADR-011 数据 schema 版本化与桌面端自动更新

日期：2026-10-21
状态：已采纳
关联：ADR-006（写操作幂等边界）、ADR-009（服务端快照形态与录入职责边界）、ADR-010（本地 SQLite 退场与云端单一主存）

## 背景 / 问题

每次发新版新增字段（`ings[].type`、`tags`、`qc_report_url`、`sup_vendors[].certs` 等）时，老版本的历史快照不会自动补齐，导致：

1. 升级后老数据读不到新字段（新功能拿到空值 / 回退默认），历史数据形同「丢失」。
2. 字段回灌全靠手工跑脚本（`store-node/seed/backfill_ing_type.js`、`migrate_from_zip.js`），不可重复、易漏。
3. 桌面端（Electron / NSIS 安装包）没有任何更新通道：用户只能手动下载 exe 覆盖安装，无版本清单、无启动自检。

## 决策

分两条腿，对齐市面 App 的「检查更新 + 数据继承」：

### A. 数据继承 —— schema 版本化 + 启动自动迁移

- 快照数据里的 `data.v`（schema 版本）正式化为唯一版本依据，常量 `SCHEMA_VERSION`（当前 = 4，对齐 `data.seed/snapshot.json`，历史口径对齐 `migrate_from_zip.js` 的 v3→v4）。
- 新增 `bff/lib/schema.js`：
  - `MIGRATIONS[from] = fn` 迁移注册表，`migrateData(data, target)` 逐级迁移；
  - `migrateOnBoot()` 启动时读 `snapshot.json` → 落后则「备份 + 迁移 + 写回」；
  - 缺某一步迁移函数时抛错（绝不静默跳版本）。
- `bff/server.js` 与桌面端同源副本 `desktop/app/bff/server.js` 在 `listen` 前各执行一次 `migrateOnBoot()`。

**红线（与 ADR-006/009 一致）**：
- 只做「结构补齐 / 字段归一」，不产生业务语义写；**不改 `rev`**（rev 是乐观锁，只在业务写时递增）。
- 迁移前把原 `snapshot.json` 复制到 `data/backups/snapshot_pre_migrate_v<from>_<ts>.json`，失败可回滚。
- 迁移函数必须幂等、不原地改入参；迁移失败保持数据原样，只打日志。

### B. 检查更新 —— electron-updater + GitHub Releases

- 桌面端引入 `electron-updater`（桌面端唯一第三方运行时依赖），provider = github。
- `desktop/electron-main.js`：`initAutoUpdate()` 启动后静默 `checkForUpdates()`，发现更新弹原生 dialog 询问下载，下载完成再询问是否「立即重启安装」；`autoInstallOnAppQuit = true` 兜底。
- 仅 `app.isPackaged` 时启用；`require('electron-updater')` 失败降级为「无更新检查」，绝不阻断 BFF / 页面启动。
- 支持 `CANTEEN_UPDATE_URL` 环境变量覆盖更新源（自建静态服务器 / 内网镜像）。
- `desktop/electron-preload.js` 暴露 `canteenDesktop.appVersion()` / `.checkUpdate()` 供前端手动触发（预留）。

## 使用约定（每次发版动数据结构时）

1. `bff/lib/schema.js`：`SCHEMA_VERSION` +1，`MIGRATIONS` 补一条「旧版 → 新版」；
2. `bff/lib/schema.test.js` 补「旧数据 → 迁移后字段齐全」用例；
3. 同步 `bff/lib/schema.js` → `desktop/app/bff/lib/schema.js`（桌面端打包用 `app/bff` 副本，`**/*.test.js` 已被排除不打包）；
4. 发版时 bump `desktop/package.json` 的 `version`，填好 `build.publish.owner/repo`，上传 GitHub Releases。

## 发布流程（GitHub Releases）

1. 把 `desktop/package.json` 的 `build.publish.owner/repo` 改成真实 GitHub 仓库；
2. 构建并上传：`cd desktop && npm run dist`（需 `GH_TOKEN` 且有仓库 push 权限）；仅本地打包装、不上传用 `npx electron-builder --win nsis --publish never`；
3. electron-builder 生成 `latest.yml` + `canteenAI-Setup-<version>.exe` + `.blockmap` 并上传到 Releases；
4. 客户端下次启动自动检测到新版本并提示更新。

## 影响 / 权衡

- 引入第一个桌面端第三方运行时依赖（electron-updater），但被 try/catch 兜底，不影响零依赖 BFF 的底线。
- 迁移只在启动时跑一次，成本 O(快照大小)，且带冷备份，风险可控。
- 未覆盖：店内 SQLite → 云端 → 桌面的「跨端数据同步」仍是 ADR-010 的后续项；本 ADR 只解决「升级不丢数据 + 检查更新」。
