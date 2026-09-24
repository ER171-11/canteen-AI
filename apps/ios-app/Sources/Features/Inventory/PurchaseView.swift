import SwiftUI

// 原型 inv-po：采购单列表（BFF 未开放采购单端点，Sprint 1 为空态占位）。
struct PurchaseView: View {
    var body: some View {
        Text("暂无采购单\n（采购单端点待 BFF 开放）")
            .font(.caption)
            .foregroundColor(.pwSub)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

#Preview { PurchaseView() }
