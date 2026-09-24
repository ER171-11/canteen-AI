import SwiftUI

// TODO: 对应原型 p-m-analysis（经营分析：周报六色销量趋势 / 小时热力 / 节假日预测）。
struct AnalysisView: View {
    var body: some View {
        Text("经营分析（骨架）")
            .font(.headline)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.pwBg.ignoresSafeArea())
    }
}

#Preview { AnalysisView() }
