# panda-wufu-shared（KMP 共享层）

「熊猫五福餐厅」老板 App 的 Kotlin Multiplatform 共享层，承载两端（Android / iOS）共用的
模型、网络、仓库、红线网关与首个共享 ViewModel。

## 目录结构

```
kmp-shared/
├── build.gradle.kts            # KMP + AGP(library) + SQLDelight 1.5.5，Kotlin 1.9.24
├── settings.gradle.kts
├── gradle.properties
└── src/
    ├── commonMain/kotlin/com/pandawufu/shared/
    │   ├── Platform.kt               # expect AppDispatchers / platformLogD
    │   ├── model/                    # DTO + FiveColor（五福色值与寓意）
    │   ├── network/                  # BffClient（Ktor，Bearer 注入）/ SseClient（流式）
    │   ├── repository/               # Health/Snapshot/Report/Action/Kimi Repository
    │   ├── viewmodel/HomeViewModel.kt# MVI 样例（state + intent）
    │   ├── redline/                  # ConfirmGateway（写操作唯一入口）/ RedlineGuard（rev 过期检测）
    │   └── pos/UndoStack.kt          # POS 并拆单撤销栈状态机
    ├── commonMain/sqldelight/.../PandaWufuDb.sq   # undo_stack + draft_todo
    ├── androidMain/  iosMain/        # expect/actual 平台实现
    └── commonTest/                   # ConfirmGateway / UndoStack 单测
```

## 与两端的关系

- **apps/android-app**：Gradle 直接 `include` 本模块（`:shared`），Compose 层订阅
  `HomeViewModel.state`（StateFlow）。
- **apps/ios-app**：Xcode 链接本模块编译产物 `Shared.framework`，SwiftUI 侧通过
  SKIE 或 KMP-NativeCoroutines 将 `StateFlow`/`Flow` 桥接为 `AsyncSequence`/
  `@Published`（接入步骤见 `apps/ios-app/README_iOS_SETUP.md`）。

## 在本机构建（需 Android Studio / JDK 17）

本仓库在交付环境（Linux，无 Android SDK/Gradle）中未做构建验证。请在带 SDK 的机器上：

1. 安装 Android Studio（自带 JDK 17 与 Android SDK 34）。
2. 安装 Kotlin Multiplatform Mobile 插件（iOS 目标需在 macOS 上 + Xcode）。
3. 在本目录执行：
   ```bash
   gradle :kmp-shared:build            # JVM/Android 编译 + commonTest
   gradle :kmp-shared:linkDebugFrameworkIosSimulatorArm64   # macOS 上产出 Shared.framework
   ```
   （或用 Android Studio 打开 `kmp-shared/` 直接 Sync & Build。）

## 红线规则（不可违反）

1. **端侧不写库**：SQLDelight 仅存 `undo_stack`（撤销记录）与 `draft_todo`（待办草稿），
   任何业务数据一律不得落端库。
2. **写操作唯一入口**：一切写操作必须经 `redline.ConfirmGateway`
   （propose → 用户确认 → confirm）→ `POST /api/actions`。禁止 UI/ViewModel 直接调用
   `ActionRepository` / `BffClient.postAction`。
3. **Kimi 图片仅内存**：`imageBase64` 只在内存中传递，不落盘、不进日志。
4. **预测 ≠ 下单**：AI 预测 UI 之后必须接用户确认（ConfirmGateway 两段式），
   不得直接执行。
5. **rev 过期检测**：确认写操作前用 `RedlineGuard.isStale` 校验本地 rev 与服务端 rev。
