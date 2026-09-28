import SwiftUI

@main
struct PandaWufuApp: App {
    init() {
        // App 启动时初始化红线网关（写操作唯一入口，禁止绕过）。
        // KMP 侧：ConfirmGateway.shared.init(actionRepository: ActionRepositoryImpl(bff: bff))
        // TODO: 待接入 Shared.framework 后取消注释
        // SharedDI.shared.setup()
    }

    var body: some Scene {
        WindowGroup {
            RootTabView()
        }
    }
}

struct RootTabView: View {
    @State private var selection = 0

    var body: some View {
        ZStack(alignment: .bottom) {
            TabView(selection: $selection) {
                HomeView()
                    .tabItem { Label("简报", systemImage: "house") }
                    .tag(0)
                InventoryView()
                    .tabItem { Label("进销存", systemImage: "shippingbox") }
                    .tag(1)
                ChatView()
                    .tabItem { Text("SI") }   // 中间位，图标由悬浮渐变按钮承载
                    .tag(2)
                KitchenView()
                    .tabItem { Label("厨房", systemImage: "fork.knife") }
                    .tag(3)
                MoreView()
                    .tabItem { Label("更多", systemImage: "ellipsis") }
                    .tag(4)
            }
            .tint(Color.pwInk)

            // 中间 AI 悬浮按钮：粉紫渐变（#F48FB1 → #9B6BBF）
            Button(action: { selection = 2 }) {
                Image(systemName: "sparkles")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundColor(.white)
                    .frame(width: 56, height: 56)
                    .background(
                        LinearGradient(
                            colors: [Color.pwAiPink, Color.pwAiPurple],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .clipShape(Circle())
                    .shadow(color: Color.pwShadow, radius: 14, x: 0, y: 8)
            }
            .offset(y: -18)
        }
    }
}

#Preview {
    RootTabView()
}
