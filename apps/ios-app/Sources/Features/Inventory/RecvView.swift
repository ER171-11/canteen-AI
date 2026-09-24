import SwiftUI

// 原型 inv-recv：进货入库记录（snapshot.recv）+ 拍照验货占位（Sprint 3 开放）。
// 【KMP 切换点】数据替换为 InventoryViewModel.state.recv；
//   拍照按钮 → KimiRepository.callVisionStream(type: "recv", ...)（Sprint 3）。
private struct MockRecv: Identifiable {
    let id: String
    let supplier: String
    let summary: String
    let status: String
    let amount: String?
}

@MainActor
final class MockRecvModel: ObservableObject {
    @Published var records: [MockRecv] = [
        .init(id: "REC-0924", supplier: "张记", summary: "墨鱼汁0.3kg+冬菇1.5kg", status: "待收货", amount: nil),
        .init(id: "REC-0923", supplier: "菜篮子", summary: "猪肉10kg+面粉20kg", status: "已入库", amount: "¥1,260")
    ]
    @Published var showSprint3Hint = false
}

struct RecvView: View {
    @StateObject private var model = MockRecvModel()

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                Button(action: { model.showSprint3Hint = true }) {
                    VStack(spacing: 4) {
                        Text("📷 拍照验货").font(.subheadline.bold()).foregroundColor(.pwAiPurple)
                        Text("对准送货单/实物 · Kimi 自动核对数量·鲜度·规格").font(.caption).foregroundColor(.pwSub)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(18)
                    .overlay(RoundedRectangle(cornerRadius: PWRadius.small).stroke(Color.pwAiPurple, lineWidth: 1))
                }
                .alert("提示", isPresented: $model.showSprint3Hint) {
                    Button("知道了", role: .cancel) {}
                } message: {
                    Text("Kimi 拍照验货 Sprint 3 开放")
                }

                Text("进货入库（\(model.records.count)）").font(.headline)
                ForEach(model.records) { rec in
                    HStack {
                        VStack(alignment: .leading) {
                            Text("\(rec.id) · \(rec.supplier)").font(.subheadline.bold())
                            Text(rec.summary).font(.caption).foregroundColor(.pwSub)
                        }
                        Spacer()
                        if let amount = rec.amount { Text(amount).font(.subheadline) }
                        Text(rec.status)
                            .font(.caption2)
                            .foregroundColor(rec.status == "已入库" ? .pwFiveGreen : .pwFiveYellow)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background((rec.status == "已入库" ? Color.pwFiveGreen : Color.pwFiveYellow).opacity(0.14))
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

#Preview { RecvView() }
