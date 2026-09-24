import SwiftUI

// TODO: 对应原型 p-m-staff（排班员工：班次表 / 人效 / Kimi 拍照着装合规 uniform）。
struct StaffView: View {
    var body: some View {
        Text("排班员工（骨架）")
            .font(.headline)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.pwBg.ignoresSafeArea())
    }
}

#Preview { StaffView() }
