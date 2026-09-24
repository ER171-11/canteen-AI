import SwiftUI

// TODO: 对应原型 p-m-pos（堂食收银：桌台网格 / 并拆单撤销栈 → kmp-shared pos.UndoStack，
//  结算写操作必须经 ConfirmGateway → /api/actions）。
struct PosView: View {
    var body: some View {
        Text("堂食收银（骨架）")
            .font(.headline)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.pwBg.ignoresSafeArea())
    }
}

#Preview { PosView() }
