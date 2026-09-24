import SwiftUI

// TODO: 对应原型 p-m-loss（损耗报损：报损记录 / 损耗率 / 原因归因）。
struct LossView: View {
    var body: some View {
        Text("损耗报损（骨架）")
            .font(.headline)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.pwBg.ignoresSafeArea())
    }
}

#Preview { LossView() }
