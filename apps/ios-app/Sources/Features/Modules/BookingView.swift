import SwiftUI

// TODO: 对应原型 p-m-booking（预订排队：预订日历 / 排队叫号）。
struct BookingView: View {
    var body: some View {
        Text("预订排队（骨架）")
            .font(.headline)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.pwBg.ignoresSafeArea())
    }
}

#Preview { BookingView() }
