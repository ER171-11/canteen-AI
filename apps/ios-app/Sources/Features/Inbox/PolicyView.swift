import SwiftUI
// import Shared  // TODO: 接入 KMP Shared.framework 后取消注释

// SI 授权与审计（iOS）：分级授权总开关 + 政策清单 + SI 决策审计。
// 与 Android features/inbox/PolicyScreen.kt 同构，数据源为 KMP SiRepository：
//   - GET/POST /api/policies、POST /api/policies/toggle、DELETE /api/policies/{id}
//   - GET /api/si/audit
// 红线：政策只决定 queued→待执行 的提前量，写路径仍是队列→consumer→/api/sync。
struct PolicyView: View {
    @State private var autoEnabled = false
    // @StateObject private var model = SiViewModelWrapper()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("SI 授权与审计")
                    .font(.title.bold())
                    .foregroundColor(.pwTxt)
                Text("政策内自动执行 · 高风险仍须老板确认")
                    .font(.caption)
                    .foregroundColor(.pwSub)

                VStack(alignment: .leading, spacing: 8) {
                    Toggle("自动执行总开关", isOn: $autoEnabled)
                        .tint(.pwAiPink)
                    Text("高风险类型（调价/改配方/人事/对外）永不自动")
                        .font(.caption2)
                        .foregroundColor(.pwSub)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.pwCard)
                .cornerRadius(PWRadius.medium)
                .shadow(color: .pwShadow, radius: 14, x: 0, y: 8)

                VStack(alignment: .leading, spacing: 8) {
                    Text("政策（0）")
                        .font(.headline)
                        .foregroundColor(.pwTxt)
                    Text("暂无政策 · 默认全部动作都需人工确认")
                        .font(.caption)
                        .foregroundColor(.pwSub)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.pwCard)
                .cornerRadius(PWRadius.medium)

                VStack(alignment: .leading, spacing: 8) {
                    Text("SI 决策审计（近 20 条）")
                        .font(.headline)
                        .foregroundColor(.pwTxt)
                    Text("暂无审计记录")
                        .font(.caption)
                        .foregroundColor(.pwSub)
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
    PolicyView()
}
