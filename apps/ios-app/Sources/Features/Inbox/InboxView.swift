import SwiftUI
// import Shared  // TODO: 接入 KMP Shared.framework 后取消注释

// SI 收件箱（iOS）：需拍板 / 执行中 / 预警 / SI 通知。
// 与 Android features/inbox/InboxScreen.kt 同构，数据源为 KMP SiRepository：
//   - GET /api/inbox          → InboxDto
//   - GET /api/report/briefing→ BriefingDto
//   - POST /api/inbox/ack     → 标记通知已读
// 写操作仍必须经 ConfirmGateway（KMP），SI 绝不直接落库。
//
// KMP 接入（二选一，见 README_iOS_SETUP.md）：
//   - SKIE：`for await state in siViewModel.state` 订阅 StateFlow；
//   - KMP-NativeCoroutines：`siViewModel.stateNative`。
struct InboxView: View {
    @State private var selected = 0
    private let pills = ["需拍板", "执行中", "预警", "通知"]

    // @StateObject private var model = SiViewModelWrapper()  // 包装 KMP SiViewModel

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text("SI 收件箱")
                        .font(.title.bold())
                        .foregroundColor(.pwTxt)
                    Text("系统算好了 · 你点一次才落库")
                        .font(.caption)
                        .foregroundColor(.pwSub)

                    // SI 结论（BriefingDto.headline + bullets）
                    VStack(alignment: .leading, spacing: 6) {
                        Text("SI 结论")
                            .font(.headline)
                            .foregroundColor(.pwTxt)
                        Text("正在读取门店数据…")
                            .font(.subheadline)
                            .foregroundColor(.pwTxt)
                        Text("SI 只读取数 · 提案须你确认才落库")
                            .font(.caption2)
                            .foregroundColor(.pwSub)
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.pwCard)
                    .cornerRadius(PWRadius.medium)
                    .shadow(color: .pwShadow, radius: 14, x: 0, y: 8)

                    Picker("", selection: $selected) {
                        ForEach(pills.indices, id: \.self) { i in
                            Text(pills[i]).tag(i)
                        }
                    }
                    .pickerStyle(.segmented)

                    VStack(alignment: .leading, spacing: 8) {
                        Text("\(pills[selected])（0）")
                            .font(.headline)
                            .foregroundColor(.pwTxt)
                        Text("暂无内容 · 接入 SiRepository 后自动加载")
                            .font(.caption)
                            .foregroundColor(.pwSub)
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.pwCard)
                    .cornerRadius(PWRadius.medium)

                    Text("说明：SI 只读快照 + 工具取数，提案不会自动落库；确认后才进入店内执行器。")
                        .font(.caption2)
                        .foregroundColor(.pwSub)

                    NavigationLink(destination: PolicyView()) {
                        HStack {
                            Text("SI 授权与审计")
                                .font(.subheadline.weight(.semibold))
                                .foregroundColor(.pwTxt)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .foregroundColor(.pwSub)
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.pwCard)
                        .cornerRadius(PWRadius.medium)
                    }

                    NavigationLink(destination: GoalView()) {
                        HStack {
                            Text("SI 经营目标")
                                .font(.subheadline.weight(.semibold))
                                .foregroundColor(.pwTxt)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .foregroundColor(.pwSub)
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.pwCard)
                        .cornerRadius(PWRadius.medium)
                    }

                    NavigationLink(destination: SimulateView()) {
                        HStack {
                            Text("SI What-if 模拟")
                                .font(.subheadline.weight(.semibold))
                                .foregroundColor(.pwTxt)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .foregroundColor(.pwSub)
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.pwCard)
                        .cornerRadius(PWRadius.medium)
                    }

                    NavigationLink(destination: TeamView()) {
                        HStack {
                            Text("SI 专家团")
                                .font(.subheadline.weight(.semibold))
                                .foregroundColor(.pwTxt)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .foregroundColor(.pwSub)
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.pwCard)
                        .cornerRadius(PWRadius.medium)
                    }

                    NavigationLink(destination: MissionView()) {
                        HStack {
                            Text("SI 战役")
                                .font(.subheadline.weight(.semibold))
                                .foregroundColor(.pwTxt)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .foregroundColor(.pwSub)
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.pwCard)
                        .cornerRadius(PWRadius.medium)
                    }
                }
                .padding(16)
            }
            .background(Color.pwBg.ignoresSafeArea())
        }
    }
}

#Preview {
    InboxView()
}
