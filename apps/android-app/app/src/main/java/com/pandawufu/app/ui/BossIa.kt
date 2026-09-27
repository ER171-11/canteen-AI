package com.pandawufu.app.ui

/**
 * 熊猫五福老板 App · 信息架构（单一事实源）。
 *
 * 角色心智（熊猫功夫餐厅老板 David Sun / 店长）：
 * 早上一眼「今天赚没赚够 → 该批什么 → 该办什么 → 店里忙不忙」；
 * 进销在「货品」、备料在「后厨」、问数在「AI」、卖货服务在「前厅」、
 * 钱人店设置在「我的」。前厅与后厨应对称；现状后厨已是 L0，前厅仍挂「我的」。
 * 改账 / 下单 / 调价一律经「确认台」点头才落库（AI 不直写）。
 *
 * 层次约定：
 * L0 底栏五席（全局导航）
 * L1 页内管道 / 卡片分组 / 「我的」业务分组
 * L2 模块页（或底栏页内 Tab）
 * L3 页内 pill / 筛选项 / 列表行动作
 * L4 确认台（全局叠层）或模块内写操作草稿
 *
 * 另含：Auth 岗权 · 日路径 Journey · 首页深链 · 确认动作 type 目录。
 */
object BossIa {

    /** 一层话：老板为什么来这个 App */
    const val JOB_TO_BE_DONE =
        "看清今天赚没赚够，批完该批的，办完该办的，再盯货与后厨别断档。"

    /** 顶栏常驻品牌（L0/L2 一律露出，不让页名抢走） */
    object Brand {
        const val NAME = "熊猫五福"
        /** 实体店名（与 BFF org.stores[0].name 对齐的短称） */
        const val STORE = "熊猫功夫餐厅"
        /** 老板真名（与 BFF org 用户 boss.display_name 对齐） */
        const val BOSS_NAME = "David Sun"
        const val TAGLINE = "老板 AI 助手"
        /** 主 Tab：品牌为标题，页名为副标题前缀 */
        fun tabSubtitle(page: String, job: String, storeLine: String? = null): String {
            val head = "$page · $job"
            val store = storeLine?.takeIf { it.isNotBlank() }
            return if (store != null) "$head · $store" else head
        }
        /** 子模块：功能副标题前挂品牌，保持辨识 */
        fun moduleSubtitle(detail: String): String =
            if (detail.startsWith(NAME)) detail else "$NAME · $detail"
    }

    // ───────────────────────────────────────── Auth / 岗权（进 App 前）
    /** 登录与演示岗：决定能看什么、能不能点确认台 */
    object Auth {
        const val TITLE = "进店"
        const val SUB = "微信 / 账号密码 · 岗权决定可读可写"
        data class DemoRole(val label: String, val account: String, val hint: String, val see: String)
        val demoRoles = listOf(
            DemoRole(Brand.BOSS_NAME, "boss", "全店拍板 · ${Brand.STORE}", "五席全开 · 确认台可写"),
            DemoRole("店长", "manager", "店务统筹", "五席全开 · 确认台可写"),
            DemoRole("收银", "cashier", "前厅收银", "偏前厅 · 写权看岗配置"),
            DemoRole("厨房", "kitchen", "工单出品", "偏后厨/货品读"),
            DemoRole("财务", "finance", "对账结算", "偏钱事/分析")
        )
        const val RULE_BOSS_MANAGER = "老板/店长：模块全开，确认台默认可写。"
        const val RULE_OTHER = "其它岗：按 permissions 的 {module}.read|write；无写权只看不批。"
        const val OFFLINE = "曾登录可离线进店看缓存；联网后冲刷离线队列。"
    }

    // ───────────────────────────────────────── 日路径（老板怎么用）
    /** 典型时段路径：把模块串成老板听得懂的办事顺序 */
    object Journey {
        data class Step(val whenHint: String, val where: String, val doWhat: String)
        val morning = listOf(
            Step("开门前", "今日", "看营收保本 · 待批 · 待办"),
            Step("备货", "货品·缺货", "勾选意向 → 确认台"),
            Step("备料", "后厨·工单", "开本餐工单 / 看出品"),
            Step("开台", "前厅·堂食收银", "巡台 · 预订核对")
        )
        val peak = listOf(
            Step("高峰", "前厅·堂食收银", "巡台改态 · 点菜 · 结账"),
            Step("高峰", "后厨·出品", "盯堂食/外卖待做"),
            Step("高峰", "前厅·预订排队", "叫号 · 翻台预估"),
            Step("插空", "AI", "问一句缺料/毛利，不直接改数")
        )
        val closing = listOf(
            Step("打烊前", "今日·进销损", "对数 · 日结确认"),
            Step("打烊前", "损耗 / 食安", "报损 · 留样消毒打卡"),
            Step("打烊后", "财务 / 前厅·外卖", "渠道对账"),
            Step("复盘", "经营分析", "保本 · 爆品 · 下周预测")
        )
    }

    // ───────────────────────────────────────── L0 底栏
    /** L0：底栏五席，每席只干一件老板听得懂的事 */
    object Tab {
        const val TODAY = "今日"
        const val TODAY_JOB = "营收一眼 · 待批 · 待办"
        const val GOODS = "货品"
        const val GOODS_JOB = "缺货 → 下单 → 入库 → 账面"
        const val AI = "AI"
        const val AI_JOB = "问店决策 · 改数走确认台"
        const val KITCHEN = "后厨"
        const val KITCHEN_JOB = "工单 → 出品 → 品控"
        const val FRONT = "前厅"
        const val FRONT_JOB = "迎客 → 开台 → 服务 → 结账/外卖"
        const val MINE = "我的"
        const val MINE_JOB = "进销 · 钱事 · 人合规 · 店设置"
        /** 「我的」页顶部分工说明 */
        const val MINE_BOUNDARY =
            "前厅在底栏「前厅」· 后厨在「后厨」· 问数在「AI」· 进销/钱人店在本页"
    }

    // ───────────────────────────────────────── 前厅（与后厨对称的业务域）
    /**
     * 前厅 = 销售 + 客流服务。老板心里和「后厨」成对：
     * 后厨管「做出来」，前厅管「卖出去、伺候好、收回钱」。
     *
     * 现状：方案 C 已落地 —— 前厅与后厨同为 L0 底栏；货品在「我的·进销」。
     */
    object FrontHall {
        const val TITLE = "前厅"
        const val JOB = "客流 → 开台点菜 → 服务中 → 结账 / 外卖履约"
        const val PIPE_HINT = "1.迎客排队 → 2.开台点菜 → 3.服务跟单 → 4.结账/外卖"

        /** 前厅内两股活：销售 vs 服务 */
        val salesJobs = listOf("堂食收银", "外卖", "会员")
        val serviceJobs = listOf("预订排队", "候餐服务", "口碑", "堂食服务模式")

        /** L2 归属（挂在「我的·前厅」；若升 L0 可整组上浮） */
        val moduleLabels = listOf("堂食收银", "预订排队", "外卖", "会员", "口碑")

        val leafOf = mapOf(
            "迎客" to listOf("预订确认", "排队取号/叫号", "候餐发茶/小食"),
            "开台销售" to listOf("巡台改态", "点菜挂单", "加菜/催菜/退菜", "并台拆台转台"),
            "服务中" to listOf("桌态盯梢", "打包外带", "客诉当场", "传菜挂号催菜"),
            "收钱履约" to listOf("结账扣料", "外卖接单/出餐协同", "会员储值核券"),
            "客评" to listOf("差评回访", "好评素材")
        )

        /** 已有实现 vs 原型/老板口头常提但未成一等公民的能力 */
        val gaps = emptyList<String>()

        /** 导航选型：方案 C 已采纳（底栏今日|前厅|AI|后厨|我的） */
        object NavOptions {
            const val ADOPTED = "C"
            const val A_KEEP =
                "A·维持：前厅留在「我的」分组，只改名「开台→前厅」+ 首页强化入口（改动最小）"
            const val B_HUB =
                "B·前厅枢纽页：我的点进「前厅」先见管道（迎客→收银→外卖→会员→口碑），再进子模块"
            const val C_L0 =
                "C·升 L0（已采纳）：底栏 今日|前厅|AI|后厨|我的；货品收入「我的·进销」"
        }
    }

    // ───────────────────────────────────────── L1·今日
    /**
     * L1·今日：卡片阅读顺序。
     * 钱 → 批 → 办 → 看店 → 客流 → 对数 → 启发 → 入口兜底。
     */
    object Home {
        val sectionOrder = listOf(
            "营收保本",
            "待你确认",
            "今日待办",
            "门店状态",
            "预订排队",
            "今日进销损",
            "老板一眼AI",
            "店务与设置"
        )
        const val GREET_FALLBACK = "门店经营助手"
        const val CONFIRM_HINT = "系统算好了，你点一次才落库。"
        const val TODO_HINT = "点进对应页办理；划走只是先不看。"
        const val AI_CARD_HINT = "简报在此；细问去「AI」，完整报表在经营分析。"
        const val LEDGER_HINT = "今日进、销、损一眼对数 · 点行进单据"
        const val STORE_STATUS_HINT = "后厨工单/出品/品控摘要 · 点「后厨」办"
        const val SETTINGS_HINT = "货品进销 · 确认台 · 分析 · 餐厅 · 岗位"

        /** 待办 kind → 跳转路由（对齐 HomeScreen） */
        val todoJump = mapOf(
            "restock" to "inventory/restock",
            "prep" to "kitchen",
            "channel_takeout" to "m/takeout",
            "channel_booking" to "m/booking",
            "vip_birthday" to "m/vip",
            "equipment_over" to "m/equipment"
        )
        /** 进销损行 → 跳转 */
        val ledgerJump = mapOf(
            "售出" to "m/pos",
            "入库" to "inventory/recv",
            "报损" to "m/loss"
        )
        /** 卡片 → 主出口 */
        val sectionExit = mapOf(
            "营收保本" to "m/analysis",
            "待你确认" to "m/actions",
            "今日待办" to "m/actions",
            "门店状态" to "front",
            "预订排队" to "m/booking",
            "今日进销损" to "inventory/recv",
            "老板一眼AI" to "m/analysis",
            "店务与设置" to "more"
        )
    }

    // ───────────────────────────────────────── L1·货品
    /** L1·货品：办货链 + 主数据（对齐 InventoryTab） */
    object Goods {
        const val PIPE_HINT = "1.缺货 → 2.下单 → 3.入库"
        /** L2 Tab 顺序：看账面 → 办货链 → 主数据 */
        val tabOrder = listOf("库存", "缺货", "下单", "入库", "产品库", "供应商")
        fun stockSub(critical: Int, low: Int, n: Int): String = when {
            critical > 0 -> "告急 $critical · 偏低 $low · 去「缺货」"
            low > 0 -> "偏低 $low 项 · 去「缺货」开意向"
            n > 0 -> "账面 $n 种 · 缺了走办货链"
            else -> "看库存 · 缺货 → 下单 → 入库"
        }
        const val RESTOCK_SUB = "第1步 · 按建议勾选，生成采购意向"
        const val PURCHASE_SUB = "第2步 · 确认后下单给供应商"
        const val RECV_SUB = "第3步 · 货到齐后入库改账面"
        const val CATALOG_SUB = "主数据 · 产品包规与安全线"
        const val VENDORS_SUB = "主数据 · 供应商档案（报价在供应链）"
        /** L3 各 Tab 老板会看到的内容粒度 */
        val leafOf = mapOf(
            "库存" to listOf("告急/偏低/够用分层", "安全线", "点行进缺货", "拍照盘点/账面核对", "跳产品库改包规"),
            "缺货" to listOf("补货建议清单", "勾选 → 确认台开意向", "可改数量后提交", "自动生成≠自动下单"),
            "下单" to listOf("采购草稿/在途单", "确认下单 / 标记状态", "跳转入库"),
            "入库" to listOf("待收货/已入库", "齐货入库改账面", "回看采购单"),
            "产品库" to listOf("SKU·包规·安全库存", "改数经确认台"),
            "供应商" to listOf("档案·联系人·账期入口", "报价比价去「供应链」")
        )
        /** 本席写出的确认 type */
        val actionTypes = listOf(
            "restock.create", "order.mark", "recv.inbound", "recv.accept",
            "ing.upsert", "vendor.upsert", "stock.count"
        )
    }

    // ───────────────────────────────────────── L1·后厨
    /** L1·后厨：本餐备料链；菜谱 = 出品标准（厨师须遵照执行） */
    object Kitchen {
        const val PIPE_HINT = "1.工单 → 2.出品 → 3.品控"
        val tabOrder = listOf("工单", "出品", "品控", "菜谱")
        const val WO_SUB = "第1步 · 按菜谱标准推进工单（完成扣 BOM）"
        const val BOARD_SUB = "第2步 · 看出品进度与外卖待做"
        const val QC_SUB = "第3步 · 对照菜谱标准抽检成品/留样"
        /** 菜谱不是随便翻的档案，是灶上必须照着做的出品标准 */
        const val RECIPE_SUB = "出品标准 · 厨师须遵照执行"
        const val RECIPE_RULE = "分量、工序、质检点以菜谱为准；改标准须老板确认后生效"
        val leafOf = mapOf(
            "工单" to listOf("本餐工单列表", "按 SOP 推进", "开始/完成（扣 BOM）", "缺料提示", "回链菜谱标准"),
            "出品" to listOf("堂食出品进度", "外卖待做", "跳回工单补产"),
            "品控" to listOf("对照菜谱质检点", "成品/留样记录", "抽检结果", "异常跟进"),
            "菜谱" to listOf("出品标准 SOP", "标准 BOM 分量", "份量换算", "替代料（须确认）", "转工单 / 转采购", "改标准须确认台")
        )
        val actionTypes = listOf(
            "workorder.create", "workorder.advance", "workorder.step_clock",
            "recipe.upsert", "recipe.substitute", "restock.create"
        )
    }

    // ───────────────────────────────────────── L1·AI
    /** L1·AI：问店决策，写操作出确认台 */
    object Ai {
        const val TITLE = "问店 AI"
        const val SUB = "问店决策 · 改账/下单必须过确认台"
        const val INTRO =
            "可问销量、毛利、库存、菜谱用量、排班与外卖。需要改数时我会给提案卡片，你在确认台点头才执行。"
        const val QUICK = "快捷问一句"
        /** L2 场景分组（对齐 ChatScene） */
        val scenes = listOf("进销", "后厨", "经营", "店务")
        val promptsOf = mapOf(
            "进销" to listOf("下周备货建议", "缺料与报价"),
            "后厨" to listOf("菜谱用量换算", "菜品与配方"),
            "经营" to listOf("今日营收概况", "毛利结构分析"),
            "店务" to listOf("待办与预警", "人员与排班")
        )
    }

    // ───────────────────────────────────────── L1·我的
    /**
     * L1·我的：店务分组。
     * 方案 C：前厅已升 L0；本页首组为「进销」（原货品底栏），前厅模块仍可搜/收藏。
     */
    object Mine {
        val groupOrder = listOf("进销", "前厅", "钱事", "人与合规", "店与报表")
        val groupHint = mapOf(
            "进销" to "原底栏货品 · 缺货→下单→入库 · 主数据",
            "前厅" to "主入口在底栏「前厅」· 此处搜收藏不丢功能",
            "钱事" to "对账、报损与确认台",
            "人与合规" to "排班、食安、设备",
            "店与报表" to "经营分析 · 餐厅设置 · 岗位"
        )
        const val PRIMARY_HINT = "货品 · 确认台 · 分析 · 餐厅 · 岗位 · 供应链"
        /** 确认台对外统一叫这个，不叫「审批」 */
        const val CONFIRM_DESK = "确认台"
        const val CONFIRM_DESK_SUB = "草稿确认/驳回 · 店内执行"
        /** 今日常用：进销+店务（前厅走底栏） */
        val primaryLabels = listOf("库存", "缺货", CONFIRM_DESK, "经营分析", "我的餐厅", "门店岗位")
        val primaryRoutes = listOf(
            "inventory", "inventory/restock", "m/actions", "m/analysis", "m/restaurant", "m/org"
        )
    }

    /** 「我的·进销」条目（货品从底栏迁入） */
    data class GoodsEntry(
        val label: String,
        val gridSub: String,
        val route: String,
        val keywords: String,
        val iconBgArgb: Long = 0xFFFCE4E1
    )

    val goodsEntries: List<GoodsEntry> = listOf(
        GoodsEntry("库存", "账面·安全线", "inventory", "库存 账面 盘点 告急", 0xFFFCE4E1),
        GoodsEntry("缺货", "办货第1步", "inventory/restock", "缺货 补货 意向", 0xFFFFF0F4),
        GoodsEntry("下单", "办货第2步", "inventory/purchase", "采购 下单 PO", 0xFFFCEDD0),
        GoodsEntry("入库", "办货第3步", "inventory/recv", "入库 收货", 0xFFE2F0E2),
        GoodsEntry("产品库", "包规·安全线", "inventory/catalog", "产品库 SKU 包规", 0xFFEDE3F4),
        GoodsEntry("供应商", "档案·账期", "inventory/vendors", "供应商 档案", 0xFFE3EDF7)
    )

    // ───────────────────────────────────────── L2 模块目录（我的）
    /**
     * L2 模块完整目录。与 MoreScreen + 各 *Screen pills 对齐。
     * keywords / iconBgArgb 供「我的」搜索与宫格配色。
     */
    data class Module(
        val label: String,
        val group: String,
        val route: String,
        val oneLiner: String,
        /** 「我的」宫格短副标题 */
        val gridSub: String,
        val pills: List<String>,
        /** 各 pill 下老板会碰到的信息/动作（L3） */
        val leaves: Map<String, List<String>>,
        /** 老板进这个模块时心里在问什么 */
        val bossAsk: String,
        val keywords: String = "",
        /** 宫格图标底色 ARGB，与原型色板对齐 */
        val iconBgArgb: Long = 0xFFEDE3F4,
        /** 本模块会提交的确认 type */
        val actionTypes: List<String> = emptyList()
    )

    val modules: List<Module> = listOf(
        Module(
            label = "堂食收银",
            group = "前厅",
            route = "m/pos",
            gridSub = "巡台·点菜·结账",
            oneLiner = "巡台改态 → 点菜挂单 → 结账扣料",
            pills = listOf("巡台", "点菜", "结账"),
            leaves = mapOf(
                "巡台" to listOf("桌态 free/busy/clean/rsv", "并台/拆台/转台", "服务模式：加菜催菜退菜打包客诉", "就餐中桌盯梢"),
                "点菜" to listOf("菜类筛选", "购物车", "挂单回巡台", "就餐桌加菜"),
                "结账" to listOf("账单明细", "打包外带登记", "收款确认", "结账扣料经确认台")
            ),
            bossAsk = "哪桌在吃？点齐了没？钱收了没？服务跟上了吗？",
            keywords = "收银 桌台 巡台 并单 拆单 支付 前厅 加菜 催菜 退菜 打包 客诉",
            iconBgArgb = 0xFFFCEDD0,
            actionTypes = listOf("pos.table_state", "pos.pay", "pos.rush", "pos.ready", "pos.pass", "pos.pack", "pos.void", "review.followup")
        ),
        Module(
            label = "预订排队",
            group = "前厅",
            route = "m/booking",
            gridSub = "叫号·翻台",
            oneLiner = "迎客 · 叫号 · 翻台 · 候餐",
            pills = listOf("今日预订", "排队叫号", "候餐服务", "翻台预估"),
            leaves = mapOf(
                "今日预订" to listOf("预订桌/人数/时段", "确认/改期", "到店改桌态"),
                "排队叫号" to listOf("等位队列", "取号", "叫号/过号"),
                "候餐服务" to listOf("估时看板", "发茶水/小食登记", "等位明细安抚"),
                "翻台预估" to listOf("预计空台时间", "高峰提示", "加排服务人力提示")
            ),
            bossAsk = "晚上订了几桌？外面还排多少？等位安抚了吗？",
            keywords = "预订 排队 叫号 翻台 迎客 候餐 前厅",
            iconBgArgb = 0xFFEDE3F4,
            actionTypes = listOf("booking.upsert", "queue.join", "queue.call", "queue.serve", "pos.table_state")
        ),
        Module(
            label = "外卖",
            group = "前厅",
            route = "m/takeout",
            gridSub = "美团/饿了么",
            oneLiner = "渠道接单 · 出餐协同 · 对账",
            pills = listOf("概览", "对账", "差评"),
            leaves = mapOf(
                "概览" to listOf("平台单量/金额", "待接/制作中", "待做转后厨工单", "对账确认"),
                "对账" to listOf("渠道结算核对", "差异跟进"),
                "差评" to listOf("差评列表", "回访动作")
            ),
            bossAsk = "外卖忙不忙？出餐跟得上吗？钱对上没有？",
            keywords = "外卖 美团 饿了么 对账 前厅 渠道",
            iconBgArgb = 0xFFE2F0E2,
            actionTypes = listOf("takeout.ack", "workorder.create", "review.followup")
        ),
        Module(
            label = "会员",
            group = "前厅",
            route = "m/vip",
            gridSub = "储值/券/生日",
            oneLiner = "熟客经营 · 储值/券/生日",
            pills = listOf("会员", "储值", "券", "生日", "到店"),
            leaves = mapOf(
                "会员" to listOf("会员数/活跃", "等级分布", "到店识别 vip.checkin"),
                "储值" to listOf("储值余额", "充值活动"),
                "券" to listOf("在发券种", "核销概况", "收银核券联动"),
                "生日" to listOf("近七日寿星", "关怀/发券"),
                "到店" to listOf("到店识别记录", "到店欢迎/关怀")
            ),
            bossAsk = "熟客回来了吗？券还能不能在前厅核？",
            keywords = "会员 储值 券 生日 前厅 熟客",
            iconBgArgb = 0xFFFCE4E1,
            actionTypes = listOf("vip.campaign", "vip.coupon_redeem", "vip.checkin")
        ),
        Module(
            label = "财务",
            group = "钱事",
            route = "m/finance",
            gridSub = "对账·结算",
            oneLiner = "对账 · 结算",
            pills = listOf("对账", "发票", "税务", "现金流", "分账"),
            leaves = mapOf(
                "对账" to listOf("日结核对", "堂食/外卖 vs 采购", "渠道差异"),
                "发票" to listOf("开票记录", "待开清单"),
                "税务" to listOf("税务节点提醒"),
                "现金流" to listOf("进/出/结余", "冻结/解冻"),
                "分账" to listOf("平台/门店分账", "审批")
            ),
            bossAsk = "账平了吗？这个月钱够不够转？",
            keywords = "财务 对账 结算 税务",
            iconBgArgb = 0xFFE2F0E2,
            actionTypes = listOf("finance.recon", "finance.freeze", "finance.approve")
        ),
        Module(
            label = "损耗",
            group = "钱事",
            route = "m/loss",
            gridSub = "报损·盘点差",
            oneLiner = "报损 · 盘点差",
            pills = listOf("分析", "报损", "盘点差"),
            leaves = mapOf(
                "分析" to listOf("损耗结构", "高损品项"),
                "报损" to listOf("报损单", "确认台落库"),
                "盘点差" to listOf("账面 vs 实盘", "差异原因")
            ),
            bossAsk = "钱是不是从损耗里漏走了？",
            keywords = "损耗 报损",
            iconBgArgb = 0xFFFCEDD0,
            actionTypes = listOf("loss.report")
        ),
        Module(
            label = "口碑",
            group = "前厅",
            route = "m/review",
            gridSub = "差评·好评·客诉",
            oneLiner = "客评与客诉跟进（服务收口）",
            pills = listOf("评分", "差评", "好评"),
            leaves = mapOf(
                "评分" to listOf("综合评分", "渠道分布"),
                "差评" to listOf("待回访", "处理状态", "当场客诉登记"),
                "好评" to listOf("好评摘要", "可运营素材")
            ),
            bossAsk = "客人在说什么？差评/客诉回了没？",
            keywords = "口碑 差评 好评 回访 客诉 前厅 服务",
            iconBgArgb = 0xFFFCE4E1,
            actionTypes = listOf("review.followup")
        ),
        Module(
            label = "确认台",
            group = "钱事",
            route = "m/actions",
            gridSub = "待批草稿·店内执行",
            oneLiner = "待批草稿 · 店内执行",
            pills = listOf("全部", "草稿", "待执行", "已执行", "已驳回"),
            leaves = mapOf(
                "全部" to listOf("跨模块动作流"),
                "草稿" to listOf("确认 / 驳回", "看摘要与影响"),
                "待执行" to listOf("店内执行进度"),
                "已执行" to listOf("落库结果", "错误回看"),
                "已驳回" to listOf("驳回原因")
            ),
            bossAsk = "系统算好了，我点不点头？",
            keywords = "审批 确认台 队列",
            iconBgArgb = 0xFFEDE3F4,
            actionTypes = emptyList() // 本页批其它模块的 type
        ),
        Module(
            label = "排班",
            group = "人与合规",
            route = "m/staff",
            gridSub = "班表·打卡·人效",
            oneLiner = "班表 · 打卡 · 人效",
            pills = listOf("排班", "打卡", "人效", "培训"),
            leaves = mapOf(
                "排班" to listOf("今日班表", "缺口提示", "改班"),
                "打卡" to listOf("出勤/迟到", "异常"),
                "人效" to listOf("人效指标", "对比"),
                "培训" to listOf("培训记录", "待训名单")
            ),
            bossAsk = "今天人齐不齐？有没有白养的岗？",
            keywords = "排班 员工 人效 培训",
            iconBgArgb = 0xFFE3EDF7,
            actionTypes = listOf("staff.clock", "staff.shift_upsert")
        ),
        Module(
            label = "食安",
            group = "人与合规",
            route = "m/foodsafe",
            gridSub = "留样·消毒·证照",
            oneLiner = "留样 · 消毒 · 证照",
            pills = listOf("留样", "消毒", "证照", "溯源"),
            leaves = mapOf(
                "留样" to listOf("今日留样", "拍照记录"),
                "消毒" to listOf("消毒打卡", "漏做提醒"),
                "证照" to listOf("证照到期", "补证提醒"),
                "溯源" to listOf("原料批次", "扫码追踪")
            ),
            bossAsk = "查出来能过关吗？证快不过期吧？",
            keywords = "食安 证照 溯源 留样 消毒",
            iconBgArgb = 0xFFE2F0E2,
            actionTypes = listOf("sample.log", "fs.disinfect", "fs.cert.upsert", "fs.trace_scan")
        ),
        Module(
            label = "设备",
            group = "人与合规",
            route = "m/equipment",
            gridSub = "温度·能耗·维保",
            oneLiner = "温度 · 能耗 · 维保",
            pills = listOf("温度", "能耗", "维保"),
            leaves = mapOf(
                "温度" to listOf("冷柜温度", "超温告警"),
                "能耗" to listOf("用电/用水趋势"),
                "维保" to listOf("维保计划", "故障单", "登记维保")
            ),
            bossAsk = "冷柜温度正常吗？设备要不要修？",
            keywords = "设备 能耗 冷柜 维保",
            iconBgArgb = 0xFFFCEDD0,
            actionTypes = listOf("equipment.maintain")
        ),
        Module(
            label = "经营分析",
            group = "店与报表",
            route = "m/analysis",
            gridSub = "KPI·热力·预测",
            oneLiner = "KPI · 热力 · 预测",
            pills = listOf("营收", "时段", "菜品", "保本", "效率", "预测"),
            leaves = mapOf(
                "营收" to listOf("KPI 卡", "趋势", "导出周报"),
                "时段" to listOf("热力/时段对比"),
                "菜品" to listOf("爆品/滞销", "推置顶收银"),
                "保本" to listOf("理论日保本", "类型结构"),
                "效率" to listOf("翻台/坪效/人效"),
                "预测" to listOf("销量预测", "转采购建议")
            ),
            bossAsk = "钱从哪来？哪道菜在拖后腿？下周备多少？",
            keywords = "分析 趋势 矩阵 热力 效率 保本 预测",
            iconBgArgb = 0xFFEDE3F4,
            actionTypes = listOf("analysis.export_week", "analysis.restock", "config.update")
        ),
        Module(
            label = "我的餐厅",
            group = "店与报表",
            route = "m/restaurant",
            gridSub = "资料·桌台·菜单",
            oneLiner = "资料 · 桌台 · 营业偏好 · 菜单挂菜谱",
            pills = listOf("资料", "桌台", "经营", "菜单"),
            leaves = mapOf(
                "资料" to listOf("店名/地址/电话", "改资料经确认台"),
                "桌台" to listOf("桌号/容量/分区", "增删改"),
                "经营" to listOf("营业时段", "默认菜类", "面粉安全库存"),
                "菜单" to listOf("菜品上下架/调价", "挂靠菜谱 BOM", "智能关联")
            ),
            bossAsk = "店面资料对不对？菜单和菜谱挂上了吗？",
            keywords = "餐厅 设置 配置 门店 桌台 营业 偏好 菜单",
            iconBgArgb = 0xFFFCEDD0,
            actionTypes = listOf(
                "pos.table_upsert", "pos.table_remove", "config.update",
                "dish.upsert", "dish.price", "dish.set_active", "dish.auto_link"
            )
        ),
        Module(
            label = "门店岗位",
            group = "店与报表",
            route = "m/org",
            gridSub = "组织·权限·开账号",
            oneLiner = "组织 · 权限 · 开账号",
            pills = listOf("概览"),
            leaves = mapOf(
                "概览" to listOf("门店列表", "岗位账号", "筹备新店", "开账号", "改岗权")
            ),
            bossAsk = "谁能改数？新店/新人怎么开？",
            keywords = "门店 岗位 组织 权限 账号",
            iconBgArgb = 0xFFE3EDF7,
            actionTypes = emptyList() // 直连 org API，不经确认台草稿
        ),
        Module(
            label = "供应链",
            group = "店与报表",
            route = "m/supply",
            gridSub = "报价比价（档案在货品）",
            oneLiner = "报价比价（档案在货品）",
            pills = listOf("供应商", "报价", "账期"),
            leaves = mapOf(
                "供应商" to listOf("列表跳货品档案", "账期入口"),
                "报价" to listOf("多供应商比价", "选价", "开采购意向"),
                "账期" to listOf("账期约定", "到期提醒")
            ),
            bossAsk = "这批货谁更便宜？账期扛得住吗？",
            keywords = "供应链 供应商 报价 比价",
            iconBgArgb = 0xFFE3EDF7,
            actionTypes = listOf("supply.po", "vendor.upsert", "quote.upsert")
        )
    )

    fun moduleByRoute(route: String): Module? = modules.find { it.route == route }
    fun modulesIn(group: String): List<Module> = modules.filter { it.group == group }

    // ───────────────────────────────────────── L2 聚合页文案
    /** L2·我的餐厅 pills */
    object Restaurant {
        const val TITLE = "我的餐厅"
        const val SUB = "资料 · 桌台 · 营业偏好 · 菜单挂菜谱"
        val pills = listOf("资料", "桌台", "经营", "菜单")
    }

    /** L2·堂食收银 pills */
    object Pos {
        const val TITLE = "堂食收银"
        const val SUB = "巡台改态 → 点菜挂单 → 结账扣料"
        val pills = listOf("巡台", "点菜", "结账")
    }

    // ───────────────────────────────────────── L4 确认台（全局）
    /** 任何写操作的最后一站；与「我的 · 确认台」列表同源 */
    object Confirm {
        const val TITLE = "确认台"
        const val RULE = "系统算好了 → 老板点一次 → 才落库"
        val statuses = listOf("草稿", "待执行", "已执行", "已驳回")
        /** 首页也会直接抛的 type */
        val homeTypes = listOf("workorder.create", "day.close")
        /** 按业务域归类的 type（实现扫描自 App 源码） */
        val byDomain = mapOf(
            "货品" to Goods.actionTypes,
            "后厨" to Kitchen.actionTypes,
            "前厅" to listOf(
                "pos.table_state", "pos.pay", "pos.rush", "pos.ready", "pos.pass", "pos.pack", "pos.void",
                "booking.upsert", "queue.join", "queue.call", "queue.serve",
                "takeout.ack", "vip.campaign", "vip.coupon_redeem", "vip.checkin",
                "review.followup"
            ),
            "钱事" to listOf(
                "finance.recon", "finance.freeze", "finance.approve",
                "loss.report", "day.close"
            ),
            "人与合规" to listOf(
                "staff.clock", "staff.shift_upsert",
                "sample.log", "fs.disinfect", "fs.cert.upsert", "fs.trace_scan",
                "equipment.maintain"
            ),
            "店与报表" to listOf(
                "analysis.export_week", "analysis.restock", "config.update",
                "pos.table_upsert", "pos.table_remove",
                "dish.upsert", "dish.price", "dish.set_active", "dish.auto_link",
                "supply.po", "vendor.upsert", "quote.upsert",
                "workorder.create", "recipe.upsert"
            )
        )
        val typicalTypes = listOf(
            "采购意向/下单/入库",
            "结账扣料",
            "报损/盘点差",
            "调价/上下架",
            "工单创建",
            "外卖对账",
            "餐厅资料/桌台/菜单",
            "日结"
        )
    }

    /** 边界口诀：避免模块抢活 */
    object Boundary {
        const val GOODS_VS_SUPPLY = "供应商档案在「货品」；报价比价在「供应链」。"
        const val KITCHEN_VS_FOODSAFE = "本餐出品/品控在「后厨」；留样消毒证照在「食安」。"
        const val HOME_VS_ANALYSIS = "今日看一眼；完整 KPI/保本/预测在「经营分析」。"
        const val AI_VS_CONFIRM = "AI 只建议；改数必须过确认台。"
        const val POS_VS_BOOKING = "桌态与收银在「堂食收银」；订座叫号在「预订排队」——同属前厅。"
        const val FRONT_VS_KITCHEN = "前厅管卖与服务；后厨管做与品控。传菜进度应对前厅可见。"
        const val FRONT_VS_MINE = "前厅是业务域；「我的」是容器。长期应避免把前厅活埋在设置感页面里。"
        const val ORG_VS_RESTAURANT = "账号岗权在「门店岗位」；店面资料/菜单在「我的餐厅」。"
        const val STOCK_VS_LOSS = "日常账面/盘点在「货品」；报损分析在「损耗」。"
    }
}
