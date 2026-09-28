import SwiftUI
// import Shared  // TODO: 接入 KMP Shared.framework 后取消注释

// SI 目标面板（iOS）：老板定标，SI 用只读快照评估达成度并给建议。
// 数据源 KMP SiRepository：GET /api/si/goals、POST /api/si/goals。
struct GoalView: View {
    @State private var score = 0
    // @StateObject private var model = SiViewModelWrapper()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("SI 目标")
                    .font(.title.bold())
                    .foregroundColor(.pwTxt)
                Text("老板定标 · SI 盯进度 · 偏差给建议")
                    .font(.caption)
                    .foregroundColor(.pwSub)

                VStack(alignment: .leading, spacing: 6) {
                    Text("目标达成度").font(.caption).foregroundColor(.pwSub)
                    Text("\(score)%")
                        .font(.system(size: 26, weight: .bold))
                        .foregroundColor(score >= 60 ? .pwFiveGreen : .pwFiveRed)
                    Text("SI 只读快照评估 · 改目标须老板确认")
                        .font(.caption2).foregroundColor(.pwSub)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.pwCard)
                .cornerRadius(PWRadius.medium)
                .shadow(color: .pwShadow, radius: 14, x: 0, y: 8)

                VStack(alignment: .leading, spacing: 8) {
                    Text("目标（0）").font(.headline).foregroundColor(.pwTxt)
                    Text("接入 SiRepository 后自动加载").font(.caption).foregroundColor(.pwSub)
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
    GoalView()
}
