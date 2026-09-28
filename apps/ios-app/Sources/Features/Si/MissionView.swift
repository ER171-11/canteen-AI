import SwiftUI
// import Shared  // TODO: 接入 KMP Shared.framework 后取消注释

// SI 战役（iOS）：超长期经营目标，SI 值守推进（低风险步骤可政策内自动）。
// 数据源 KMP SiRepository：GET/POST /api/si/missions、/{id}/advance|pause|resume、DELETE、/tick。
struct MissionView: View {
    // @StateObject private var model = SiViewModelWrapper()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("SI 战役")
                    .font(.title.bold())
                    .foregroundColor(.pwTxt)
                Text("超长期目标 · SI 持续执行 · 低风险可自动")
                    .font(.caption)
                    .foregroundColor(.pwSub)

                VStack(alignment: .leading, spacing: 8) {
                    Text("让 SI 立一个战役").font(.headline).foregroundColor(.pwTxt)
                    Text("保障不断料 / 守住毛利率 / 冲刺保本 / 压降损耗 / 食安零失分")
                        .font(.caption).foregroundColor(.pwSub)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.pwCard)
                .cornerRadius(PWRadius.medium)
                .shadow(color: .pwShadow, radius: 14, x: 0, y: 8)

                VStack(alignment: .leading, spacing: 8) {
                    Text("进行中（0）").font(.headline).foregroundColor(.pwTxt)
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
    MissionView()
}
