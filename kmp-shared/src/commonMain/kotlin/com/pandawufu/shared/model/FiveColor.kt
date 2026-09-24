package com.pandawufu.shared.model

import kotlinx.serialization.Serializable

/** 五福色彩。寓意取自《熊猫五福App原型.html》：
 *  红=长寿（红色·冬菇荸荠饺「寓意长寿」）、黑=聚财、黄=富贵、绿=康宁、紫=好德。
 *  注：原型经营分析页另出现第六色「白=团圆」（团圆白饺），未列入五福主枚举，
 *  若后续产品确认六色体系再扩展。 */
enum class FiveColor(val label: String, val hex: Long, val meaning: String) {
    RED("红", 0xFFE8584A, "长寿"),
    BLACK("黑", 0xFF3A3A3A, "聚财"),
    YELLOW("黄", 0xFFF2B233, "富贵"),
    GREEN("绿", 0xFF5BA85B, "康宁"),
    PURPLE("紫", 0xFF9B6BBF, "好德");
}
