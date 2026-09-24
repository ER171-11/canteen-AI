import SwiftUI
// import Shared  // TODO: 接入 KMP Shared.framework 后取消注释

// 对应原型 p-kitchen（pill 子页：菜谱 kt-rec / 工单 kt-sop / 出品看板 kt-board / 品控 kt-qc）。
// 【KMP 切换点】SKIE 接入后：删除 MockKitchenModel，改为订阅
//   KMP KitchenViewModel.state（for await state in viewModel.state），
//   并把 selection 变化映射为 KitchenIntent.SelectTab(...)。
@MainActor
final class MockKitchenModel: ObservableObject {
    @Published var selection = 0
    static let tabs = ["菜谱", "工单", "出品看板", "品控"]
}

struct KitchenView: View {
    @StateObject private var model = MockKitchenModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("厨房中枢")
                .font(.title.bold())
                .foregroundColor(.pwTxt)
            Picker("子页", selection: $model.selection) {
                ForEach(MockKitchenModel.tabs.indices, id: \.self) { i in
                    Text(MockKitchenModel.tabs[i]).tag(i)
                }
            }
            .pickerStyle(.segmented)

            switch model.selection {
            case 0: RecipesView()
            case 1: WorkordersView()
            case 2: BoardView()
            default: QcView()
            }
        }
        .padding(16)
        .background(Color.pwBg.ignoresSafeArea())
    }
}

#Preview {
    KitchenView()
}
