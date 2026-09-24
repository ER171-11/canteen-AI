import SwiftUI
// import Shared  // TODO: 接入 KMP Shared.framework 后取消注释

// 对应原型 p-inventory（pill 子页：库存 inv-stock / 补货 inv-restock / 采购 inv-po / 进货 inv-recv）。
// 【KMP 切换点】SKIE 接入后：订阅 KMP InventoryViewModel.state，
//   selection 变化映射为 InventoryIntent.SelectTab(...)。
@MainActor
final class MockInventoryModel: ObservableObject {
    @Published var selection = 0
    static let tabs = ["库存", "补货", "采购", "进货"]
}

struct InventoryView: View {
    @StateObject private var model = MockInventoryModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("进销存")
                .font(.title.bold())
                .foregroundColor(.pwTxt)
            Picker("子页", selection: $model.selection) {
                ForEach(MockInventoryModel.tabs.indices, id: \.self) { i in
                    Text(MockInventoryModel.tabs[i]).tag(i)
                }
            }
            .pickerStyle(.segmented)

            switch model.selection {
            case 0: StockView()
            case 1: RestockView()
            case 2: PurchaseView()
            default: RecvView()
            }
        }
        .padding(16)
        .background(Color.pwBg.ignoresSafeArea())
    }
}

#Preview {
    InventoryView()
}
