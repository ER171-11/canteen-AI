import SwiftUI

// TODO: 对应原型 p-m-review（顾客口碑：多平台评分 / 评价原文 / 差评跟进）。
struct ReviewView: View {
    var body: some View {
        Text("顾客口碑（骨架）")
            .font(.headline)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.pwBg.ignoresSafeArea())
    }
}

#Preview { ReviewView() }
