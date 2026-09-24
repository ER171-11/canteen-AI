import SwiftUI

// 原型 kt-qc：品控记录 + Kimi 拍照入口（Sprint 3 开放）。
// 【KMP 切换点】数据替换为 KitchenViewModel.state.qc（GET /api/kitchen/qc?date=）；
//   拍照按钮 → KimiRepository.callVisionStream(type: "qc", ...)（Sprint 3）。
private struct MockQcRecord: Identifiable {
    let id: String
    let title: String
    let detail: String
    let result: String
}

@MainActor
final class MockQcModel: ObservableObject {
    @Published var records: [MockQcRecord] = [
        .init(id: "q1", title: "剂子抽检 (10–11g)", detail: "10:30 · 李师傅", result: "pass"),
        .init(id: "q2", title: "成品抽检 (25–27g)", detail: "11:00 · 李师傅", result: "pass"),
        .init(id: "q3", title: "褶纹规整（拍照识别）", detail: "11:20 · Kimi", result: "warn")
    ]
    @Published var showSprint3Hint = false
}

struct QcView: View {
    @StateObject private var model = MockQcModel()

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                Button(action: { model.showSprint3Hint = true }) {
                    VStack(spacing: 4) {
                        Text("📷 拍成品照").font(.subheadline.bold()).foregroundColor(.pwAiPurple)
                        Text("饺子成品 · Kimi 识别褶纹/色泽/形态/重量估值").font(.caption).foregroundColor(.pwSub)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(18)
                    .overlay(RoundedRectangle(cornerRadius: PWRadius.small).stroke(Color.pwAiPurple, lineWidth: 1))
                }
                .alert("提示", isPresented: $model.showSprint3Hint) {
                    Button("知道了", role: .cancel) {}
                } message: {
                    Text("Kimi 拍照品控 Sprint 3 开放")
                }

                Text("品控记录").font(.headline)
                ForEach(model.records) { rec in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(rec.title).font(.subheadline.bold())
                            Text(rec.detail).font(.caption).foregroundColor(.pwSub)
                        }
                        Spacer()
                        Text(rec.result == "pass" ? "合格" : "临界")
                            .font(.caption2)
                            .foregroundColor(rec.result == "pass" ? .pwFiveGreen : .pwFiveYellow)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background((rec.result == "pass" ? Color.pwFiveGreen : Color.pwFiveYellow).opacity(0.14))
                            .cornerRadius(8)
                    }
                    .padding(12)
                    .background(Color.pwCard)
                    .cornerRadius(PWRadius.small)
                    .shadow(color: Color.pwShadow, radius: 14, x: 0, y: 8)
                }
            }
        }
    }
}

#Preview { QcView() }
