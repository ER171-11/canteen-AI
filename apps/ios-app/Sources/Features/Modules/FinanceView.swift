import SwiftUI

// TODO: 对应原型 p-m-finance（财务税务：收支台账 / 税负测算 / 报表导出）。
struct FinanceView: View {
    var body: some View {
        Text("财务税务（骨架）")
            .font(.headline)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.pwBg.ignoresSafeArea())
    }
}

#Preview { FinanceView() }
