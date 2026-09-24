import SwiftUI

// TODO: 对应原型 p-m-takeout（外卖平台：美团/饿了么订单对账 / 差评预警）。
struct TakeoutView: View {
    var body: some View {
        Text("外卖平台（骨架）")
            .font(.headline)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.pwBg.ignoresSafeArea())
    }
}

#Preview { TakeoutView() }
