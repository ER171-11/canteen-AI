import SwiftUI

// TODO: 对应原型 p-more（更多 Tab：12 模块宫格入口）。
struct MoreView: View {
    private let modules: [(String, String)] = [
        ("经营分析", "m/analysis"), ("排班员工", "m/staff"), ("会员营销", "m/vip"),
        ("堂食收银", "m/pos"), ("外卖平台", "m/takeout"), ("预订排队", "m/booking"),
        ("食安证照", "m/foodsafe"), ("设备能耗", "m/equipment"), ("财务税务", "m/finance"),
        ("供应链", "m/supply"), ("顾客口碑", "m/review"), ("损耗报损", "m/loss")
    ]

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 10), count: 3)

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 10) {
                    ForEach(modules, id: \.1) { name, key in
                        NavigationLink(destination: moduleView(for: key)) {
                            Text(name)
                                .font(.subheadline)
                                .foregroundColor(.pwTxt)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 20)
                                .background(Color.pwCard)
                                .cornerRadius(PWRadius.small)
                                .shadow(color: Color.pwShadow, radius: 14, x: 0, y: 8)
                        }
                    }
                }
                .padding(16)
            }
            .background(Color.pwBg.ignoresSafeArea())
            .navigationTitle("更多")
        }
    }

    @ViewBuilder
    private func moduleView(for key: String) -> some View {
        switch key {
        case "m/analysis": AnalysisView()
        case "m/staff": StaffView()
        case "m/vip": VipView()
        case "m/pos": PosView()
        case "m/takeout": TakeoutView()
        case "m/booking": BookingView()
        case "m/foodsafe": FoodsafeView()
        case "m/equipment": EquipmentView()
        case "m/finance": FinanceView()
        case "m/supply": SupplyView()
        case "m/review": ReviewView()
        default: LossView()
        }
    }
}

#Preview {
    MoreView()
}
