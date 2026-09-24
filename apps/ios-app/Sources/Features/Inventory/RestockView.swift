import SwiftUI

// 原型 inv-restock：补货建议（由库存告急/偏低项推导；AI 建议·需确认）。
// 【KMP 切换点】数据替换为 InventoryViewModel.state.restock；
//   「转单」为写操作，届时必须经 ConfirmGateway → /api/actions（Sprint 后续接入）。
private struct MockRestock: Identifiable {
    let id: String
    let title: String
    let reason: String
}

@MainActor
final class MockRestockModel: ObservableObject {
    @Published var suggestions: [MockRestock] = [
        .init(id: "r1", title: "火龙果汁 · 补 1.56kg", reason: "安全线 2kg，现 0.44kg（告急）"),
        .init(id: "r2", title: "冬菇 · 补 1.1kg", reason: "安全线 2kg，现 0.9kg（偏低）"),
        .init(id: "r3", title: "墨鱼汁 · 补 0.22kg", reason: "安全线 0.4kg，现 0.18kg（偏低）")
    ]
}

struct RestockView: View {
    @StateObject private var model = MockRestockModel()

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                Text("⚠ 补货建议由 AI 自动生成，自动生成 ≠ 自动下单；转采购需老板/店长确认。")
                    .font(.caption)
                    .foregroundColor(.pwSub)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.pwCard.opacity(0.6))
                    .cornerRadius(10)

                ForEach(model.suggestions) { s in
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(s.title).font(.subheadline.bold())
                            Text(s.reason).font(.caption).foregroundColor(.pwSub)
                            Text("AI 建议 · 需确认")
                                .font(.caption2)
                                .foregroundColor(.pwAiPurple)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.pwAiPink.opacity(0.2))
                                .cornerRadius(8)
                        }
                        Spacer()
                        Text("转单")
                            .font(.caption)
                            .foregroundColor(.white)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(Color.pwSub.opacity(0.3))
                            .cornerRadius(10)
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

#Preview { RestockView() }
