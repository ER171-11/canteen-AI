# iOS 工程接入说明（README_iOS_SETUP）

> **本阶段（Wave0–5）不建 iOS 工程**：Linux 交付以 [apps/boss-app](../boss-app) 为可演示主路径；Android 同契约追赶见 [../android-app/README_BUILD.md](../android-app/README_BUILD.md)。以下步骤仅在 macOS + Xcode 时执行。

本目录（`apps/ios-app/`）只包含 Swift 源码布局，**不含 .xcodeproj**（交付环境无 Xcode）。
请按以下步骤在 macOS 上手工建工程并接入。

## 1. 新建 Xcode 工程

1. Xcode → New → Project → iOS → App。
2. Product Name: `PandaWufu`；Interface: **SwiftUI**；Language: **Swift**。
3. 最低部署版本 iOS 15+（`NavigationStack` 需要）。
4. 建好后删除模板自带的 `ContentView.swift`，把 `Sources/` 下的所有 `.swift`
   拖入工程（勾选 Copy items if needed，保持 group 结构）：
   - `Sources/App/PandaWufuApp.swift` —— 用本文件**替换**模板生成的 `@main` App。
   - `Sources/DesignSystem/`、`Sources/Features/` —— 全部加入 App target。

## 2. 编译 KMP Shared.framework

在 macOS（带 JDK 17 + Android SDK，仅 KMP 工具链需要）上：

```bash
cd kmp-shared
gradle linkDebugFrameworkIosSimulatorArm64   # 模拟器
# 或 gradle linkDebugFrameworkIosArm64       # 真机
```

产物在 `kmp-shared/build/bin/iosSimulatorArm64/debugFramework/Shared.framework`。

## 3. 接入 Framework（推荐 CocoaPods/SPM 之外的直链方式，骨架期最简单）

1. Xcode → App target → General → Frameworks, Libraries, and Embedded Content
   → 添加 `Shared.framework`（Embed & Sign）。
2. Build Settings → Framework Search Paths 加入
   `$(SRCROOT)/../../kmp-shared/build/bin/iosSimulatorArm64/debugFramework`。
3. Swift 文件中 `import Shared` 即可访问 KMP 类型。

（也可改用 KMP 官方 CocoaPods 插件或 `kotlin-xcode-sync`，骨架期不做强制。）

## 4. ViewModel / Flow 桥接（SKIE 或 KMP-NativeCoroutines）

KMP `StateFlow`/`Flow` 不能被 Swift 直接 await，需桥接，二选一：

- **SKIE**（推荐）：在 `kmp-shared/build.gradle.kts` 加
  `id("co.touchlab.skie") version "0.6.x"`，编译产物自动把 Flow 桥为
  Swift `AsyncSequence`，SwiftUI 中：
  ```swift
  .task { for await state in viewModel.state { self.state = state } }
  ```
- **KMP-NativeCoroutines**：commonMain 加
  `implementation("com.rickclephas.kmp:kmp-nativecoroutines-core:1.0.x")`，
  ViewModel 暴露处加 `@NativeCoroutines`，Swift 侧调用生成的 `*Native` 方法。

`Sources/Features/Home/HomeView.swift` 中已留好注释占位。

## 5. BFF 联调

- 模拟器可直接访问 `http://127.0.0.1:8787`（宿主机）。
- 真机改为局域网 IP，并在 `Info.plist` 临时允许明文 HTTP：
  ```xml
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
  ```
  上线前必须移除并全量走 https。

## 6. 红线提醒

与 kmp-shared/README.md 一致：端侧不写库；写操作一律经 `ConfirmGateway`
两段式（propose → confirm）→ `POST /api/actions`；Kimi 图片仅内存；预测≠下单。
