import SwiftUI

// 原型 kt-rec：功夫菜单（五色分组列表）+ 点击展开 BOM/参数/步骤。
// 【KMP 切换点】数据替换为 KitchenViewModel.state.recipes；
//   点击行 → KitchenIntent.SelectRecipe(skuId)，展开 → state.selectedRecipe/selectedSteps。
private struct MockRecipe: Identifiable {
    let id: String
    let color: String
    let name: String
    let desc: String
    let main: [String]
    let steps: [String]
}

@MainActor
final class MockRecipesModel: ObservableObject {
    @Published var recipes: [MockRecipe] = [
        .init(id: "dum-red", color: "红", name: "红色·冬菇荸荠饺", desc: "火龙果汁和面 · 寓意长寿",
              main: ["雪花粉 5.0kg", "火龙果汁 2.2kg", "猪前肩肉 5.0kg"],
              steps: ["和面 20min", "醒发 30min", "包制 20min", "煮制 10min"]),
        .init(id: "dum-blk", color: "黑", name: "黑色·猪肉三鲜饺", desc: "墨鱼汁和面 · 寓意聚财",
              main: ["雪花粉", "墨鱼汁", "猪肉三鲜馅"], steps: ["和面", "包制", "煮制"]),
        .init(id: "dum-yel", color: "黄", name: "黄色·茴香大葱饺", desc: "南瓜泥和面 · 寓意富贵",
              main: ["雪花粉", "南瓜泥", "茴香大葱馅"], steps: ["和面", "包制", "煮制"]),
        .init(id: "dum-grn", color: "绿", name: "绿色·猪肉玉米饺", desc: "菠菜汁和面 · 寓意康宁",
              main: ["雪花粉", "菠菜汁", "猪肉玉米馅"], steps: ["和面", "包制", "煮制"]),
        .init(id: "dum-pur", color: "紫", name: "紫色·猪肉香芹饺", desc: "紫薯粉和面 · 寓意好德",
              main: ["雪花粉", "紫薯粉", "猪肉香芹馅"], steps: ["和面", "包制", "煮制"])
    ]
    @Published var expandedId: String? = nil
}

struct RecipesView: View {
    @StateObject private var model = MockRecipesModel()

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                ForEach(model.recipes) { r in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 10) {
                            Text(r.color)
                                .font(.caption.bold())
                                .foregroundColor(.white)
                                .frame(width: 34, height: 34)
                                .background(fiveColor(r.color))
                                .clipShape(Circle())
                            VStack(alignment: .leading) {
                                Text(r.name).font(.subheadline.bold()).foregroundColor(.pwTxt)
                                Text(r.desc).font(.caption).foregroundColor(.pwSub)
                            }
                            Spacer()
                            Image(systemName: model.expandedId == r.id ? "chevron.up" : "chevron.down")
                                .foregroundColor(.pwSub)
                        }
                        if model.expandedId == r.id {
                            Divider()
                            Text("主料").font(.caption.bold())
                            ForEach(r.main, id: \.self) { Text("· \($0)").font(.caption).foregroundColor(.pwSub) }
                            Text("SOP 步骤").font(.caption.bold())
                            ForEach(r.steps, id: \.self) { Text("· \($0)").font(.caption).foregroundColor(.pwSub) }
                        }
                    }
                    .padding(12)
                    .background(Color.pwCard)
                    .cornerRadius(PWRadius.small)
                    .shadow(color: Color.pwShadow, radius: 14, x: 0, y: 8)
                    .onTapGesture {
                        withAnimation { model.expandedId = model.expandedId == r.id ? nil : r.id }
                    }
                }
            }
        }
    }
}

func fiveColor(_ c: String) -> Color {
    switch c {
    case "红": return .pwFiveRed
    case "黑": return .pwFiveBlack
    case "黄": return .pwFiveYellow
    case "绿": return .pwFiveGreen
    case "紫": return .pwFivePurple
    default: return .pwSub
    }
}

#Preview { RecipesView() }
