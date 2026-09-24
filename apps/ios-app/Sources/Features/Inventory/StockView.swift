import SwiftUI

// 原型 inv-stock：donut（充足/偏低/告急）+ 原料行（安全线进度条 + 状态 Tag）。
// 【KMP 切换点】数据替换为 InventoryViewModel.state.stock（StockPolicy 分档在 KMP 侧完成）。
struct MockStockItem: Identifiable {
    let id: String
    let name: String
    let cat: String
    let unit: String
    let qty: Double
    let safety: Double
    let status: Status
    enum Status: String {
        case enough = "充足", low = "偏低", critical = "告急"
        var color: Color {
            switch self {
            case .enough: return .pwFiveGreen
            case .low: return .pwFiveYellow
            case .critical: return .pwFiveRed
            }
        }
    }
}

@MainActor
final class MockStockModel: ObservableObject {
    @Published var items: [MockStockItem] = [
        .init(id: "i1", name: "火龙果汁", cat: "红面色源", unit: "kg", qty: 0.44, safety: 2, status: .critical),
        .init(id: "i2", name: "墨鱼汁", cat: "黑色面色源", unit: "kg", qty: 0.18, safety: 0.4, status: .low),
        .init(id: "i3", name: "五得利雪花粉八星", cat: "面主料", unit: "kg", qty: 12.5, safety: 15, status: .enough),
        .init(id: "i4", name: "猪前肩肉", cat: "主料", unit: "kg", qty: 6.2, safety: 8, status: .enough),
        .init(id: "i5", name: "冬菇", cat: "红馅辅料", unit: "kg", qty: 0.9, safety: 2, status: .low),
        .init(id: "i6", name: "菠菜汁", cat: "绿面色源", unit: "kg", qty: 1.7, safety: 2, status: .enough)
    ]
}

struct StockView: View {
    @StateObject private var model = MockStockModel()

    private var counts: (enough: Int, low: Int, critical: Int) {
        (
            model.items.filter { $0.status == .enough }.count,
            model.items.filter { $0.status == .low }.count,
            model.items.filter { $0.status == .critical }.count
        )
    }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                // donut 占位 + 图例
                HStack(spacing: 16) {
                    ZStack {
                        Circle().stroke(Color.pwFiveGreen, lineWidth: 14)
                            .frame(width: 80, height: 80)
                        // TODO: 三档占比弧形（SwiftUI Chart 或 Path），数据对齐 KMP countEnough/Low/Critical
                        Text("\(model.items.count)项").font(.caption.bold())
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        legend(.pwFiveGreen, "充足 \(counts.enough) 项")
                        legend(.pwFiveYellow, "偏低 \(counts.low) 项")
                        legend(.pwFiveRed, "告急 \(counts.critical) 项")
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.pwCard)
                .cornerRadius(PWRadius.small)

                Text("原料库存（\(model.items.count)）").font(.headline)
                ForEach(model.items) { item in
                    HStack(spacing: 10) {
                        VStack(alignment: .leading) {
                            Text(item.name).font(.subheadline.bold())
                            Text("\(item.cat) · 安全 \(fmt(item.safety))\(item.unit)").font(.caption).foregroundColor(.pwSub)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 4) {
                            Text("\(fmt(item.qty))/\(fmt(item.safety))\(item.unit)").font(.caption)
                            ProgressView(value: item.qty, total: max(item.safety, 0.001))
                                .tint(item.status.color)
                                .frame(width: 90)
                        }
                        Text(item.status.rawValue)
                            .font(.caption2)
                            .foregroundColor(item.status.color)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(item.status.color.opacity(0.14))
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

    private func legend(_ color: Color, _ text: String) -> some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 10, height: 10)
            Text(text).font(.caption)
        }
    }
}

func fmt(_ v: Double) -> String { v.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(v)) : String(v) }

#Preview { StockView() }
