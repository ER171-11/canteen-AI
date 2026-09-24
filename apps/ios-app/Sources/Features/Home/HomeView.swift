import SwiftUI
// import Shared  // TODO: 接入 KMP Shared.framework 后取消注释

// TODO: 对应原型 p-home（简报 Tab：今日 KPI 卡 / 五色销量 / AI 建议 / 待办）。
// 当前为骨架：KMP HomeViewModel 接入方式见下方注释。
struct HomeView: View {
    // KMP 接入方式（二选一，详见 README_iOS_SETUP.md）：
    //  - SKIE：Shared 编译产物自动将 StateFlow/Flow 桥为 Swift AsyncSequence，
    //    用 `for await state in viewModel.state` 订阅；
    //  - KMP-NativeCoroutines：ViewModel 上加 @NativeCoroutines 注解，
    //    Swift 侧 `async let state = viewModel.stateNative` 轮询/订阅。
    // @StateObject private var model = HomeViewModelWrapper()  // 包装 KMP HomeViewModel
    @State private var rev: String = "-"
    @State private var loading = false

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text("简报")
                    .font(.title.bold())
                    .foregroundColor(.pwTxt)

                VStack(alignment: .leading, spacing: 8) {
                    if loading {
                        ProgressView()
                    } else {
                        Text("今日营收 ¥0.0")
                            .font(.headline)
                        Text("rev \(rev)")
                            .font(.caption)
                            .foregroundColor(.pwSub)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.pwCard)
                .cornerRadius(PWRadius.medium)
                .shadow(color: Color.pwShadow, radius: 14, x: 0, y: 8)

                Button("刷新") {
                    // TODO: model.dispatch(HomeIntent.Refresh())
                }
            }
            .padding(16)
            .background(Color.pwBg.ignoresSafeArea())
        }
    }
}

#Preview {
    HomeView()
}
