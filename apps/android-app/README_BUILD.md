# Android 构建说明（对齐 liuai/native 脚手架）

## 脚手架对齐点

与 `/home/fushunwu/单项目/liuai/native` 保持一致：

| 项 | 取值 |
|---|---|
| AGP | 8.13.0 |
| Kotlin | 2.1.21 |
| Compose | `org.jetbrains.kotlin.plugin.compose` + BOM 2024.12.01 |
| 仓库 | 阿里云 google/central 镜像 + 官方兜底 |
| aapt2 | 仅 arm64 Linux 需要 `android.aapt2FromMavenOverride` → liuai `toolchain/aapt2-qemu/aapt2`（Windows x86-64 已移除该行） |
| Wrapper | Gradle 8.13 |

本仓额外保留 KMP `:shared`（`../../kmp-shared`），SQLDelight 为 `app.cash.sqldelight` 2.0.2。

## 冒烟（已通过 · Linux arm64）

```bash
cd apps/android-app
# 本机若注入了 musa LD_PRELOAD，务必清掉，否则 jlink / aapt2-qemu 易挂死
env -u LD_PRELOAD ./gradlew :app:assembleDebug --no-daemon
```

APK：`app/build/outputs/apk/debug/app-debug.apk`（约 18MB）

## Windows 本机（2026-09-29 实测跑通）

### 实际采用的环境（全部装在用户目录，无需管理员）

| 组件 | 路径 | 来源 |
|---|---|---|
| JDK 17.0.20.1 (Temurin) | `%USERPROFILE%\tools\jdk17\jdk-17.0.20.1+1` | 清华 Adoptium 镜像 |
| Android SDK | `%USERPROFILE%\tools\android-sdk` | Google cmdline-tools `commandlinetools-win-13114758_latest.zip` |
| Gradle 8.13 | `%USERPROFILE%\tools\gradle-8.13` | 腾讯镜像（官方源在国内很慢） |
| AVD | `panda-test`（Android 15 / google_apis / x86_64 / Pixel 6） | `avdmanager` |
| 辅助脚本 | `%USERPROFILE%\tools\{install-sdk.cmd, make-avd.cmd, finish-install.ps1}` | 本机调试用 |

系统自带的 `C:\Program Files\Java\jdk-14.0.2` **不可用**（AGP 8.13 要求 JDK 17+）。

### 本仓已改动

- `local.properties`（gitignored）：`sdk.dir=C:/Users/mingyzhikui/tools/android-sdk`、`bff.base.url=http://10.0.2.2:8787`
  - 正斜杠是必须的：`.properties` 里 `\U` 被当转义符，`C:\Users` 会变成 `C:Users`
- `gradle.properties`：注释掉 `android.aapt2FromMavenOverride`（arm64 Linux 的 qemu 包装器，Windows x86-64 设了必失败）

### 构建

```powershell
$env:JAVA_HOME="$env:USERPROFILE\tools\jdk17\jdk-17.0.20.1+1"
$env:ANDROID_HOME="$env:USERPROFILE\tools\android-sdk"
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
cd apps\android-app
& "$env:USERPROFILE\tools\gradle-8.13\bin\gradle.bat" :app:assembleDebug --no-daemon
```

产物：`app\build\outputs\apk\debug\app-debug.apk`

> 不用 `.\gradlew.bat` 的原因：wrapper 要从 `services.gradle.org` 拉 137MB 分发包（本机握手就 3.4s），腾讯镜像 2s 下完。

### 模拟器

```powershell
$root="$env:USERPROFILE\tools"
$adb="$root\android-sdk\platform-tools\adb.exe"
& "$root\android-sdk\emulator\emulator.exe" -avd panda-test -no-boot-anim -gpu auto
& $adb wait-for-device
& $adb install -r app\build\outputs\apk\debug\app-debug.apk
& $adb shell monkey -p com.pandawufu.app -c android.intent.category.LAUNCHER 1
```

- 本机 AMD Ryzen 7 4800H + `HypervisorPresent=True` + `WinHvPlatform.dll` 在位 → WHPX 加速可用；
- AVD 内 `10.0.2.2` 即宿主机，BFF 默认绑 `0.0.0.0:8787`，无需额外配置；
- 登录 `boss / wufu123`。

### 真机（先确认 `adb devices` 能看到设备）

- **USB**：`adb reverse tcp:8787 tcp:8787`，并把 `bff.base.url` 改成 `http://127.0.0.1:8787` 重新打包；
- **Wi-Fi**：改成电脑局域网 IP（本机当前 `http://192.168.1.19:8787`），手机与电脑同网段，并放行 Windows 防火墙 8787 入站。

### 坑：仓库里带进来的旧 APK

- 旧的 `app-debug.apk` 是 Linux 机产物，`BuildConfig.BFF_BASE_URL` 已在编译期固化为 `http://192.168.1.22:8787`（本机 WLAN 是 192.168.1.19），装上也连不上；2026-09-29 已重命名为 `app-debug.apk.linux-stale` 留档。
- `BuildConfig.BFF_BASE_URL` 是编译期常量，运行时无法改，换环境必须重新打包。

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

## 现场管理四块能力（2026-09-29）

| 能力 | 入口 | 关键实现 |
|---|---|---|
| A 品控 | 厨房 → 品控页 | `features/kitchen/QcMediaSection.kt`（拍照→识别→判定→`qc.record`；强制放行 `qc.force_pass`） |
| B 桌态 | 前厅首页 | `features/fronthall/TableBoardSection.kt`（四态汇总 / 网格 / 待清排序超时） |
| C 巡检 | 更多 → 人与合规 → 闭店巡检 | `features/inspection/InspectionScreen.kt`（50 节点 / 进度环 / 30 分钟提醒 / 本地台账） |
| D 水印相机 | 各拍照入口底层 | `media/WatermarkCamera.kt` + `WatermarkCapture.kt` + `PhotoStore.kt` |

- **权限/落盘**：使用 `FileProvider`（`AndroidManifest.xml`，authority `${applicationId}.fileprovider`）授权系统相机写原图；
  原图落 `filesDir/photos/raw`、水印成品落 `filesDir/photos/wm`（`res/xml/file_paths.xml`），**无需存储权限**，卸载即清除。
- **品控照片**：经 `/api/qc/media/presign` 直传对象存储，App 只把 `photo_url`/`photo_key` 随动作提交；图片不落 BFF、不入库。
- **巡检照片**：**只存在手机本地**，服务器只记状态。
- 巡检入口需 `module.read:inspection` 权限（`AppModule.moduleOfRoute` 已登记 `m/inspection`）。

## 新老板最小验收

1. 登录 boss → 简报（无快照会标演示并给引导）
2. 更多 → 门店岗位 → 开岗位账号 / 筹备新门店
3. 进销 → 告急补货确认 → 审批队列可见草稿/已确认
4. 厨房转工单 / 巡台结账 → 确认台 → 审批队列
5. 审批队列可驳回草稿
6. 厨房 → 品控：拍照 → AI 判定 → 记录结论（不合格转「记录不合格并锁定」，厨师长强制放行须填原因）
7. 前厅首页：桌态看板四态汇总与待清排序可见
8. 更多 → 闭店巡检：分板块 50 节点、进度环、卫生间 30 分钟提醒、拍照后本地台账可查

## aarch64 说明

- aapt2 走 liuai qemu 包装器（已写入 `gradle.properties`）
- 构建前确认：`/home/fushunwu/Projects/liuAI/toolchain/aapt2-qemu/aapt2 version`
- 若遇 `JdkImageTransform` / `jlink` 长时间无输出：先 `unset LD_PRELOAD` 再编
