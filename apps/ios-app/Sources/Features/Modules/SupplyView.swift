import SwiftUI

// TODO: 对应原型 p-m-supply（供应链：采购单 / 比价 / Kimi 拍照验货 recv；
//  生成补货单必须经 ConfirmGateway 确认）。
struct SupplyView: View {
    var body: some View {
        Text("供应链（骨架）")
            .font(.headline)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.pwBg.ignoresSafeArea())
    }
}

#Preview { SupplyView() }
