import SwiftUI

// TODO: 对应原型 p-m-vip（会员营销：储值记录 / 复购周期 / AI 活动建议）。
struct VipView: View {
    var body: some View {
        Text("会员营销（骨架）")
            .font(.headline)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.pwBg.ignoresSafeArea())
    }
}

#Preview { VipView() }
