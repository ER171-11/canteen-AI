import SwiftUI

// TODO: 对应原型 p-inventory（进销存 Tab：库存预警 / 五色备货 AI 预测(预测≠下单) / Kimi 拍照盘点 stock）。
struct InventoryView: View {
    var body: some View {
        Text("进销存（骨架）")
            .font(.headline)
            .foregroundColor(.pwTxt)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.pwBg.ignoresSafeArea())
    }
}

#Preview {
    InventoryView()
}
