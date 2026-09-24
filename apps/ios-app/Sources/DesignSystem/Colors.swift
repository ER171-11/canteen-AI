import SwiftUI

// 视觉 token 全量（取自原型 熊猫五福App原型.html CSS 变量）
extension Color {
    // 主色 / 底色 / 卡片
    static let pwInk = Color(red: 0x1A/255, green: 0x1A/255, blue: 0x1A/255)      // --ink 主色
    static let pwBg = Color(red: 0xEE/255, green: 0xF1/255, blue: 0xF5/255)       // --bg 页面底
    static let pwCard = Color.white                                                // 卡片 #FFFFFF
    static let pwTxt = Color(red: 0x2B/255, green: 0x2B/255, blue: 0x2B/255)      // --txt 正文
    static let pwSub = Color(red: 0x8A/255, green: 0x8F/255, blue: 0x98/255)      // --sub 次要文字
    static let pwLine = Color(red: 0xEC/255, green: 0xEE/255, blue: 0xF2/255)     // --line 分隔线

    // AI 渐变
    static let pwAiPink = Color(red: 0xF4/255, green: 0x8F/255, blue: 0xB1/255)
    static let pwAiPurple = Color(red: 0x9B/255, green: 0x6B/255, blue: 0xBF/255)

    // 五福五色（寓意见 kmp-shared FiveColor：红=长寿 黑=聚财 黄=富贵 绿=康宁 紫=好德）
    static let pwFiveRed = Color(red: 0xE8/255, green: 0x58/255, blue: 0x4A/255)
    static let pwFiveBlack = Color(red: 0x3A/255, green: 0x3A/255, blue: 0x3A/255)
    static let pwFiveYellow = Color(red: 0xF2/255, green: 0xB2/255, blue: 0x33/255)
    static let pwFiveGreen = Color(red: 0x5B/255, green: 0xA8/255, blue: 0x5B/255)
    static let pwFivePurple = Color(red: 0x9B/255, green: 0x6B/255, blue: 0xBF/255)

    // 阴影 0 8px 28px rgba(40,50,70,.10)
    static let pwShadow = Color(red: 40/255, green: 50/255, blue: 70/255).opacity(0.10)

    // POS 桌台四态（取自原型 .tbl.free/.busy/.clean/.rsv，bg / 文字 / 边框）
    static let pwTableFreeBg = Color(red: 0xE2/255, green: 0xF0/255, blue: 0xE2/255)
    static let pwTableFreeTxt = Color(red: 0x2E/255, green: 0x7D/255, blue: 0x32/255)
    static let pwTableFreeBorder = Color(red: 0xB6/255, green: 0xDD/255, blue: 0xB6/255)
    static let pwTableBusyBg = Color(red: 0xFC/255, green: 0xE4/255, blue: 0xE1/255)
    static let pwTableBusyTxt = Color(red: 0xC6/255, green: 0x28/255, blue: 0x28/255)
    static let pwTableBusyBorder = Color(red: 0xF5/255, green: 0xB0/255, blue: 0xAA/255)
    static let pwTableCleanBg = Color(red: 0xFC/255, green: 0xED/255, blue: 0xD0/255)
    static let pwTableCleanTxt = Color(red: 0x9C/255, green: 0x2C/255, blue: 0x2C/255)
    static let pwTableCleanBorder = Color(red: 0xF0/255, green: 0xCF/255, blue: 0x7A/255)
    static let pwTableRsvBg = Color(red: 0xE3/255, green: 0xED/255, blue: 0xF7/255)
    static let pwTableRsvTxt = Color(red: 0x15/255, green: 0x65/255, blue: 0xC0/255)
    static let pwTableRsvBorder = Color(red: 0xA8/255, green: 0xC8/255, blue: 0xE8/255)
}

// 圆角 token：14 / 20 / 26
enum PWRadius {
    static let small: CGFloat = 14
    static let medium: CGFloat = 20
    static let large: CGFloat = 26
}
