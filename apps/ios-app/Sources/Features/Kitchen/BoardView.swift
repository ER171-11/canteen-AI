import SwiftUI

// 原型 kt-board：今日出品看板（五色进度条 + 合格率）。
// 【KMP 切换点】数据替换为 KitchenViewModel.state.board（GET /api/kitchen/board?date=）。
private struct MockBoardItem: Identifiable {
    var id: String { color }
    let color: String
    let planned: Int
    let done: Int
    let qcPassRate: Double
}

@MainActor
final class MockBoardModel: ObservableObject {
    @Published var items: [MockBoardItem] = [
        .init(color: "红", planned: 68, done: 48, qcPassRate: 0.96),
        .init(color: "黑", planned: 59, done: 40, qcPassRate: 0.94),
        .init(color: "黄", planned: 52, done: 35, qcPassRate: 0.97),
        .init(color: "绿", planned: 47, done: 28, qcPassRate: 0.95)
    ]
}

struct BoardView: View {
    @StateObject private var model = MockBoardModel()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("今日出品看板").font(.headline)
                ForEach(model.items) { item in
                    HStack(spacing: 8) {
                        Text(item.color)
                            .font(.caption2.bold())
                            .foregroundColor(.white)
                            .frame(width: 22, height: 22)
                            .background(fiveColor(item.color))
                            .clipShape(Circle())
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text("\(item.done)/\(item.planned)").font(.subheadline.bold())
                                Spacer()
                                Text("合格率 \(Int(item.qcPassRate * 100))%")
                                    .font(.caption)
                                    .foregroundColor(.pwFiveGreen)
                            }
                            ProgressView(value: Double(item.done), total: Double(max(item.planned, 1)))
                                .tint(fiveColor(item.color))
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

#Preview { BoardView() }
