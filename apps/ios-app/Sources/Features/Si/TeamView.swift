import SwiftUI
// import Shared  // TODO: 接入 KMP Shared.framework 后取消注释

// SI 专家团 + 知识库（iOS）：六域值守巡检 + 数据挖掘/人工沉淀的经营打法。
// 数据源 KMP SiRepository：GET /api/si/team、GET/POST/DELETE /api/si/knowledge。
struct TeamView: View {
    // @StateObject private var model = SiViewModelWrapper()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("SI 专家团")
                    .font(.title.bold())
                    .foregroundColor(.pwTxt)
                Text("六域值守 · 知识沉淀 · 统筹门店系统")
                    .font(.caption)
                    .foregroundColor(.pwSub)

                VStack(alignment: .leading, spacing: 6) {
                    Text("总协调").font(.headline).foregroundColor(.pwTxt)
                    Text("接入 SiRepository 后显示：采购/食安/财务/营销/客流/设备 六域巡检")
                        .font(.caption).foregroundColor(.pwSub)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.pwCard)
                .cornerRadius(PWRadius.medium)
                .shadow(color: .pwShadow, radius: 14, x: 0, y: 8)

                VStack(alignment: .leading, spacing: 8) {
                    Text("SI 沉淀的打法").font(.headline).foregroundColor(.pwTxt)
                    Text("数据挖掘：高毛利组合 / 损耗主因 / 低谷时段 / 配方资产")
                        .font(.caption).foregroundColor(.pwSub)
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
    TeamView()
}
