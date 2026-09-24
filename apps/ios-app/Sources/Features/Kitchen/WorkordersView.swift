import SwiftUI

// 原型 kt-sop：工单倒排时间线（done/now 状态点）。
// 【KMP 切换点】数据替换为 KitchenViewModel.state.workorders（GET /api/sop/workorder?date=）。
private struct MockSopStep: Identifiable {
    let id = UUID()
    let time: String
    let title: String
    let desc: String
    let state: State
    enum State { case done, now, todo }
}

private struct MockWorkorder: Identifiable {
    let id: String
    let color: String
    let name: String
    let qty: Int
    let status: String
    let steps: [MockSopStep]
}

@MainActor
final class MockWorkordersModel: ObservableObject {
    @Published var workorders: [MockWorkorder] = [
        .init(id: "w1", color: "红", name: "红色饺子", qty: 68, status: "进行中", steps: [
            .init(time: "10:00", title: "和面 · 5色面团", desc: "雪花粉+色源汁，压面机压制至光滑", state: .done),
            .init(time: "10:00–10:30", title: "醒发 30 分钟", desc: "保鲜膜覆盖，关键工艺点", state: .done),
            .init(time: "10:30–11:00", title: "备馅 · 拌馅", desc: "料水分三次加入，顺同一方向搅至上劲", state: .now),
            .init(time: "11:00–11:20", title: "包制", desc: "剂子10–11g · 成品25–27g", state: .todo),
            .init(time: "11:20–11:30", title: "煮制", desc: "分三次点凉水至浮起鼓胀", state: .todo)
        ])
    ]
}

struct WorkordersView: View {
    @StateObject private var model = MockWorkordersModel()

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                ForEach(model.workorders) { wo in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 8) {
                            Circle().fill(fiveColor(wo.color)).frame(width: 12, height: 12)
                            Text("\(wo.name) · 工单").font(.subheadline.bold())
                            Text("计划 \(wo.qty) 份").font(.caption).foregroundColor(.pwSub)
                            Spacer()
                            Text(wo.status).font(.caption2).foregroundColor(.pwFiveGreen)
                        }
                        ForEach(wo.steps) { step in
                            HStack(alignment: .top, spacing: 8) {
                                Circle()
                                    .fill(step.state == .done ? Color.pwFiveGreen : (step.state == .now ? Color.pwFiveRed : Color.pwSub))
                                    .frame(width: 8, height: 8)
                                    .padding(.top, 4)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("\(step.time)  \(step.title)").font(.caption.bold())
                                    Text(step.desc).font(.caption2).foregroundColor(.pwSub)
                                }
                            }
                        }
                    }
                    .padding(14)
                    .background(Color.pwCard)
                    .cornerRadius(PWRadius.small)
                    .shadow(color: Color.pwShadow, radius: 14, x: 0, y: 8)
                }
            }
        }
    }
}

#Preview { WorkordersView() }
