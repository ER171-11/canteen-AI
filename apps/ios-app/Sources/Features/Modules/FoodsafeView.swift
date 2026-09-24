import SwiftUI

// TODO: 对应原型 p-m-foodsafe（食安证照：证照台账 / 留样记录，Kimi 拍照留样登记 sample）。
struct FoodsafeView: View {
    var body: some View {
        Text("食安证照（骨架）")
            .font(.headline)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.pwBg.ignoresSafeArea())
    }
}

#Preview { FoodsafeView() }
