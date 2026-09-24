import SwiftUI

// TODO: 对应原型 p-kitchen（厨房 Tab：五色饺子产能 / 菜谱成本 / Kimi 拍照品控 qc·plate）。
struct KitchenView: View {
    var body: some View {
        Text("厨房（骨架）")
            .font(.headline)
            .foregroundColor(.pwTxt)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.pwBg.ignoresSafeArea())
    }
}

#Preview {
    KitchenView()
}
