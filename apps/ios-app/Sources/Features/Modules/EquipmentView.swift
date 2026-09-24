import SwiftUI

// TODO: 对应原型 p-m-equipment（设备能耗：设备台账 / 能耗曲线 / 维保提醒）。
struct EquipmentView: View {
    var body: some View {
        Text("设备能耗（骨架）")
            .font(.headline)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.pwBg.ignoresSafeArea())
    }
}

#Preview { EquipmentView() }
