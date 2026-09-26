# Android 构建说明（对齐 liuai/native 脚手架）

## 脚手架对齐点

与 `/home/fushunwu/单项目/liuai/native` 保持一致：

| 项 | 取值 |
|---|---|
| AGP | 8.13.0 |
| Kotlin | 2.1.21 |
| Compose | `org.jetbrains.kotlin.plugin.compose` + BOM 2024.12.01 |
| 仓库 | 阿里云 google/central 镜像 + 官方兜底 |
| aapt2 | `android.aapt2FromMavenOverride` → liuai `toolchain/aapt2-qemu/aapt2` |
| Wrapper | Gradle 8.13 |

本仓额外保留 KMP `:shared`（`../../kmp-shared`），SQLDelight 为 `app.cash.sqldelight` 2.0.2。

## 冒烟（已通过）

```bash
cd apps/android-app
# 本机若注入了 musa LD_PRELOAD，务必清掉，否则 jlink / aapt2-qemu 易挂死
env -u LD_PRELOAD ./gradlew :app:assembleDebug --no-daemon
```

APK：`app/build/outputs/apk/debug/app-debug.apk`（约 18MB）

## 联调 BFF

- 默认 `BuildConfig.BFF_BASE_URL=http://10.0.2.2:8787`（模拟器 → 宿主机）
- `local.properties` 可覆写：`bff.base.url=...`
  - 模拟器：`http://10.0.2.2:8787`
  - 真机 USB：`adb reverse tcp:8787 tcp:8787` 后用 `http://127.0.0.1:8787`
  - 真机 Wi‑Fi：`http://<电脑局域网IP>:8787`
- 或环境变量 `PANDA_BFF_BASE_URL`
- 演示账号：`boss` / `wufu123`（店长 manager、收银 cashier 等同密）
- 新店无快照时首页会提示「店内快照未接通」；推送后进销/巡台才有真数
- 写操作：确认台 → `/api/actions` → 店内 `queue_consumer` 执行后列表才变

## 新老板最小验收

1. 登录 boss → 简报（无快照会标演示并给引导）
2. 更多 → 门店岗位 → 开岗位账号 / 筹备新门店
3. 进销 → 告急补货确认 → 审批队列可见草稿/已确认
4. 厨房转工单 / 巡台结账 → 确认台 → 审批队列
5. 审批队列可驳回草稿

## aarch64 说明

- aapt2 走 liuai qemu 包装器（已写入 `gradle.properties`）
- 构建前确认：`/home/fushunwu/Projects/liuAI/toolchain/aapt2-qemu/aapt2 version`
- 若遇 `JdkImageTransform` / `jlink` 长时间无输出：先 `unset LD_PRELOAD` 再编
