import SwiftUI
// import Shared  // TODO: 接入 KMP Shared.framework 后取消注释

// SI What-if 模拟（iOS）：输入份数/调价/原料涨跌，确定性测算毛利与备料。
// 数据源 KMP SiRepository：POST /api/si/simulate（只读，不落库）。
struct SimulateView: View {
    @State private var sku = "红"
    @State private var portions = "500"
    @State private var priceDelta = "0"
    // @StateObject private var model = SiViewModelWrapper()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("SI 模拟")
                    .font(.title.bold())
                    .foregroundColor(.pwTxt)
                Text("数字孪生 · 先算后做 · 不落库")
                    .font(.caption)
                    .foregroundColor(.pwSub)

                VStack(alignment: .leading, spacing: 10) {
                    TextField("菜品 / SKU", text: $sku)
                        .textFieldStyle(.roundedBorder)
                    TextField("做多少份", text: $portions)
                        .textFieldStyle(.roundedBorder)
                    TextField("调价 %（正=涨）", text: $priceDelta)
                        .textFieldStyle(.roundedBorder)
                    Button("跑一次模拟") {
                        // TODO: model.simulate(SimRequest(...))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(Color.pwAiPink)
                    .foregroundColor(.white)
                    .cornerRadius(PWRadius.small)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.pwCard)
                .cornerRadius(PWRadius.medium)

                VStack(alignment: .leading, spacing: 6) {
                    Text("结果").font(.headline).foregroundColor(.pwTxt)
                    Text("接入 SiRepository 后显示：售价/单份成本/毛利率变化与备料需求")
                        .font(.caption)
                        .foregroundColor(.pwSub)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.pwCard)
                .cornerRadius(PWRadius.medium)
            }
            .padding(16)
        }
        .background(Color.pwBg.ignoresSafeArea())
    }
}

#Preview {
    SimulateView()
}
