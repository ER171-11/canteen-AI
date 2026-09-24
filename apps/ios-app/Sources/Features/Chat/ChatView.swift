import SwiftUI

// TODO: 对应原型 p-chat（AI 对话 Tab：消息流 / 快捷指令 / Kimi SSE delta 流式渲染）。
struct ChatView: View {
    var body: some View {
        Text("AI 对话（骨架）")
            .font(.headline)
            .foregroundColor(.pwTxt)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.pwBg.ignoresSafeArea())
    }
}

#Preview {
    ChatView()
}
