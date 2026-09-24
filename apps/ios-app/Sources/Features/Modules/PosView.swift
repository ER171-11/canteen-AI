import SwiftUI

// 对应原型 p-m-pos / pos-floor：桌台平面图（8 桌网格，四态配色取自原型 .tbl.*）。
// Sprint 1 只读：点击/长按不响应；并单/拆单为写操作，Sprint 5 开放（届时必须走
// kmp-shared pos.UndoStack + ConfirmGateway → /api/actions）。
// 【KMP 切换点】数据替换为 snapshot.pos（经 InventoryViewModel.state.posTables 或
//   InventoryRepository.posTables()），state ∈ free|busy|clean|rsv。
struct MockPosTable: Identifiable {
    let id: String
    let no: String
    let state: State
    enum State: String {
        case free = "空闲", busy = "就餐", clean = "待清", rsv = "预订"
        var colors: (bg: Color, txt: Color, border: Color) {
            switch self {
            case .free: return (.pwTableFreeBg, .pwTableFreeTxt, .pwTableFreeBorder)
            case .busy: return (.pwTableBusyBg, .pwTableBusyTxt, .pwTableBusyBorder)
            case .clean: return (.pwTableCleanBg, .pwTableCleanTxt, .pwTableCleanBorder)
            case .rsv: return (.pwTableRsvBg, .pwTableRsvTxt, .pwTableRsvBorder)
            }
        }
    }
}

@MainActor
final class MockPosModel: ObservableObject {
    // 初始态对齐原型 KPI「5/8」：5 就餐 + 1 待清 + 2 空闲
    @Published var tables: [MockPosTable] = [
        .init(id: "T1", no: "T1", state: .busy),
        .init(id: "T2", no: "T2", state: .busy),
        .init(id: "T3", no: "T3", state: .free),
        .init(id: "T4", no: "T4", state: .clean),
        .init(id: "T5", no: "T5", state: .busy),
        .init(id: "T6", no: "T6", state: .free),
        .init(id: "T7", no: "T7", state: .busy),
        .init(id: "T8", no: "T8", state: .busy)
    ]
}

struct PosView: View {
    @StateObject private var model = MockPosModel()
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 9), count: 4)

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("堂食收银 · 桌台")
                    .font(.title.bold())
                    .foregroundColor(.pwTxt)

                HStack(spacing: 8) {
                    disabledTool("并单（Sprint 5 开放）")
                    disabledTool("拆单（Sprint 5 开放）")
                }

                LazyVGrid(columns: columns, spacing: 9) {
                    ForEach(model.tables) { table in
                        let c = table.state.colors
                        VStack(spacing: 2) {
                            Text(table.no).font(.headline).foregroundColor(c.txt)
                            Text(table.state.rawValue).font(.caption2).foregroundColor(c.txt)
                        }
                        .frame(maxWidth: .infinity)
                        .aspectRatio(1, contentMode: .fit)
                        .background(c.bg)
                        .overlay(RoundedRectangle(cornerRadius: 11).stroke(c.border, lineWidth: 1.5))
                        .cornerRadius(11)
                    }
                }

                HStack(spacing: 14) {
                    legend(.pwTableFreeBg, "空闲 \(model.tables.filter { $0.state == .free }.count)")
                    legend(.pwTableBusyBg, "就餐 \(model.tables.filter { $0.state == .busy }.count)")
                    legend(.pwTableCleanBg, "待清 \(model.tables.filter { $0.state == .clean }.count)")
                    legend(.pwTableRsvBg, "预订 \(model.tables.filter { $0.state == .rsv }.count)")
                }
            }
            .padding(16)
        }
        .background(Color.pwBg.ignoresSafeArea())
    }

    private func disabledTool(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundColor(.white)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(Color.pwSub.opacity(0.3))
            .cornerRadius(10)
    }

    private func legend(_ color: Color, _ text: String) -> some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 10, height: 10)
            Text(text).font(.caption)
        }
    }
}

#Preview {
    PosView()
}
