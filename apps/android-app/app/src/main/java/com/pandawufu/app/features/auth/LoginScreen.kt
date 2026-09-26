package com.pandawufu.app.features.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pandawufu.app.AppModule
import com.pandawufu.app.BuildConfig
import com.pandawufu.app.auth.WeChatAuth
import com.pandawufu.app.ui.BossIa
import com.pandawufu.app.ui.designsystem.AiPink
import com.pandawufu.app.ui.designsystem.AiPurple
import com.pandawufu.app.ui.designsystem.BrandBar
import com.pandawufu.app.ui.designsystem.CardBg
import com.pandawufu.app.ui.designsystem.FiveGreen
import com.pandawufu.app.ui.designsystem.FiveRed
import com.pandawufu.app.ui.designsystem.FiveYellow
import com.pandawufu.app.ui.designsystem.GreetBlock
import com.pandawufu.app.ui.designsystem.Ink
import com.pandawufu.app.ui.designsystem.PageBg
import com.pandawufu.app.ui.designsystem.PandaCard
import com.pandawufu.app.ui.designsystem.Sub
import com.pandawufu.app.ui.designsystem.Txt
import kotlinx.coroutines.launch

private data class DemoRole(val label: String, val account: String, val hint: String)

private val demoRoles = listOf(
    DemoRole(BossIa.Brand.BOSS_NAME, "boss", "全店拍板 · ${BossIa.Brand.STORE}"),
    DemoRole("店长", "manager", "店务统筹"),
    DemoRole("收银", "cashier", "桌台收银"),
    DemoRole("厨房", "kitchen", "工单出品"),
    DemoRole("财务", "finance", "对账结算")
)

@Composable
fun LoginScreen(onLoggedIn: () -> Unit, modifier: Modifier = Modifier) {
    val lastAccount = AppModule.sessionStore?.account
    var modeRegister by remember { mutableStateOf(false) }
    var account by remember { mutableStateOf(lastAccount ?: "") }
    var password by remember { mutableStateOf(if (lastAccount.isNullOrBlank()) "wufu123" else "") }
    var invite by remember { mutableStateOf("WUFU2026") }
    var displayName by remember { mutableStateOf("") }
    var showPassword by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showTechHint by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    val context = LocalContext.current
    val online by AppModule.networkMonitor.online.collectAsState()
    val offlineReady = remember { AppModule.canEnterOffline() }
    val sessionSummary = remember { AppModule.localSessionSummary() }

    fun submit() {
        if (loading) return
        val acc = account.trim()
        if (acc.isEmpty()) {
            error = "请输入账号"
            return
        }
        if (password.isEmpty()) {
            error = "请输入密码"
            return
        }
        if (modeRegister && invite.trim().isEmpty()) {
            error = "请填写门店邀请码"
            return
        }
        loading = true
        error = null
        scope.launch {
            val result = if (modeRegister) {
                AppModule.registerDetailed(
                    acc,
                    password,
                    invite.trim(),
                    displayName.trim().ifEmpty { null }
                )
            } else {
                AppModule.loginDetailed(acc, password)
            }
            loading = false
            when (result) {
                AppModule.AuthResult.Ok -> onLoggedIn()
                is AppModule.AuthResult.Fail -> {
                    error = result.message
                    showTechHint = result.offlineHint
                }
            }
        }
    }

    Column(
        modifier
            .fillMaxSize()
            .background(PageBg)
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 24.dp)
            .padding(bottom = 96.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        BrandBar(
            title = BossIa.Brand.NAME,
            subtitle = if (online) "${BossIa.Brand.TAGLINE} · 已联网" else "${BossIa.Brand.TAGLINE} · 离线"
        )

        Box(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(16.dp))
                .background(Brush.horizontalGradient(listOf(Color(0xFF1A1A1A), Color(0xFF3A2A35))))
                .padding(horizontal = 16.dp, vertical = 14.dp)
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    if (modeRegister) "新员工入职" else "本店登录",
                    color = Color.White,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.ExtraBold
                )
                Text(
                    if (modeRegister) "用邀请码开通账号 · 岗权由店长在后台调整"
                    else "老板与下属岗位共用 · 支持离线 · 联网自动同步",
                    color = Color.White.copy(alpha = 0.78f),
                    fontSize = 12.sp
                )
            }
        }

        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            StatusChip(
                text = if (online) "已联网" else "离线",
                bg = if (online) FiveGreen.copy(alpha = 0.18f) else FiveYellow.copy(alpha = 0.22f),
                fg = if (online) FiveGreen else Ink
            )
            if (offlineReady && !sessionSummary.isNullOrBlank()) {
                StatusChip(
                    text = "本机可续用",
                    bg = AiPink.copy(alpha = 0.16f),
                    fg = AiPurple
                )
            }
        }

        if (!modeRegister && offlineReady && !sessionSummary.isNullOrBlank()) {
            PandaCard {
                Text("上次登录", fontSize = 12.sp, color = Sub, fontWeight = FontWeight.SemiBold)
                Text(sessionSummary, fontSize = 14.sp, color = Txt, fontWeight = FontWeight.Bold)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = {
                            AppModule.sessionStore?.restoreToHolder()
                            if (AppModule.canEnterOffline()) onLoggedIn()
                            else error = "本地会话已失效，请重新登录"
                        },
                        modifier = Modifier.weight(1f),
                        shape = RoundedCornerShape(16.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = Ink, contentColor = Color.White)
                    ) {
                        Text(if (online) "快速进入" else "离线进入", fontWeight = FontWeight.Bold)
                    }
                    OutlinedButton(
                        onClick = {
                            account = AppModule.sessionStore?.account.orEmpty()
                            password = ""
                        },
                        shape = RoundedCornerShape(16.dp)
                    ) { Text("换账号") }
                }
            }
        }

        PandaCard {
            GreetBlock(
                name = if (modeRegister) "欢迎加入" else "账号登录",
                accent = if (modeRegister) "·注册" else "·门店",
                sub = if (modeRegister) "注册后默认可读，写权限由店长开通"
                else "输入账号密码进入；演示岗可点下方一键填充"
            )

            if (!modeRegister) {
                Text("演示岗位（一键填入）", fontSize = 11.sp, color = Sub)
                Row(
                    Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    demoRoles.forEach { role ->
                        val selected = account == role.account
                        Box(
                            Modifier
                                .clip(RoundedCornerShape(20.dp))
                                .background(if (selected) Ink else CardBg)
                                .border(1.dp, if (selected) Ink else Color(0xFFE5E7EB), RoundedCornerShape(20.dp))
                                .clickable {
                                    account = role.account
                                    password = "wufu123"
                                    error = null
                                }
                                .padding(horizontal = 12.dp, vertical = 8.dp)
                        ) {
                            Column {
                                Text(
                                    role.label,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = if (selected) Color.White else Txt
                                )
                                Text(
                                    role.hint,
                                    fontSize = 10.sp,
                                    color = if (selected) Color.White.copy(alpha = 0.75f) else Sub
                                )
                            }
                        }
                    }
                }
            }

            OutlinedTextField(
                value = account,
                onValueChange = { account = it; error = null },
                label = { Text("账号") },
                placeholder = { Text(if (modeRegister) "自设账号，如 zhangsan" else "如 boss / manager") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                shape = RoundedCornerShape(14.dp),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Ascii,
                    imeAction = ImeAction.Next
                ),
                keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) })
            )
            OutlinedTextField(
                value = password,
                onValueChange = { password = it; error = null },
                label = { Text("密码") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                trailingIcon = {
                    TextButton(onClick = { showPassword = !showPassword }) {
                        Text(if (showPassword) "隐藏" else "显示", fontSize = 12.sp)
                    }
                },
                shape = RoundedCornerShape(14.dp),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    imeAction = if (modeRegister) ImeAction.Next else ImeAction.Done
                ),
                keyboardActions = KeyboardActions(
                    onNext = { focus.moveFocus(FocusDirection.Down) },
                    onDone = { submit() }
                )
            )
            if (modeRegister) {
                OutlinedTextField(
                    value = displayName,
                    onValueChange = { displayName = it },
                    label = { Text("姓名（可选）") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    shape = RoundedCornerShape(14.dp),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                    keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) })
                )
                OutlinedTextField(
                    value = invite,
                    onValueChange = { invite = it; error = null },
                    label = { Text("门店邀请码") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    shape = RoundedCornerShape(14.dp),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { submit() })
                )
            }

            error?.let { msg ->
                Column(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .background(FiveRed.copy(alpha = 0.08f))
                        .padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    Text(msg, color = FiveRed, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    if (showTechHint) {
                        Text(
                            "模拟器请用 10.0.2.2；真机可用 adb reverse tcp:8787 或局域网 IP\n当前：${BuildConfig.BFF_BASE_URL}",
                            color = Sub,
                            fontSize = 11.sp
                        )
                        if (offlineReady) {
                            Text("本机已有会话时，也可点上方「离线进入」", color = Sub, fontSize = 11.sp)
                        }
                    }
                }
            }

            if (loading) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.Center
                ) {
                    CircularProgressIndicator(color = AiPink, strokeWidth = 3.dp)
                }
            } else {
                if (!modeRegister) {
                    Button(
                        onClick = {
                            loading = true
                            error = null
                            showTechHint = false
                            scope.launch {
                                val fp = AppModule.sessionStore?.deviceFp(
                                    context
                                ) ?: "android-app"
                                val codeResult = WeChatAuth.requestAuthCode(context, fp)
                                val code = codeResult.getOrElse {
                                    loading = false
                                    error = it.message ?: "微信授权失败"
                                    return@launch
                                }
                                val result = AppModule.loginWechatDetailed(code)
                                loading = false
                                when (result) {
                                    AppModule.AuthResult.Ok -> onLoggedIn()
                                    is AppModule.AuthResult.Fail -> {
                                        error = result.message
                                        showTechHint = result.offlineHint
                                    }
                                }
                            }
                        },
                        modifier = Modifier.fillMaxWidth().height(48.dp),
                        shape = RoundedCornerShape(20.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = Color(0xFF07C160),
                            contentColor = Color.White
                        )
                    ) {
                        Text(
                            when {
                                !online -> "微信登录（需联网）"
                                WeChatAuth.isSdkReady() -> "微信登录"
                                else -> "微信登录（开发模拟）"
                            },
                            fontWeight = FontWeight.Bold,
                            fontSize = 15.sp
                        )
                    }
                    Text(
                        if (WeChatAuth.isSdkReady())
                            "使用微信授权进入本店；首次登录为只读岗，店长可在后台改岗"
                        else
                            "未配置 wechat.app.id 时为开发模拟（不唤起微信客户端）",
                        fontSize = 11.sp,
                        color = Sub
                    )
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.Center
                    ) {
                        Box(
                            Modifier
                                .weight(1f)
                                .height(1.dp)
                                .background(Color(0xFFE5E7EB))
                        )
                        Text("  或账号密码  ", fontSize = 11.sp, color = Sub)
                        Box(
                            Modifier
                                .weight(1f)
                                .height(1.dp)
                                .background(Color(0xFFE5E7EB))
                        )
                    }
                }
                Button(
                    onClick = { submit() },
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                    shape = RoundedCornerShape(20.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Ink, contentColor = Color.White)
                ) {
                    Text(
                        if (modeRegister) "注册并进入" else if (online) "账号登录" else "账号登录（可离线续用）",
                        fontWeight = FontWeight.Bold,
                        fontSize = 15.sp
                    )
                }
                TextButton(
                    onClick = {
                        modeRegister = !modeRegister
                        error = null
                        showTechHint = false
                    },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(
                        if (modeRegister) "已有账号？返回登录" else "新员工？用邀请码注册",
                        color = AiPurple,
                        fontWeight = FontWeight.SemiBold
                    )
                }
            }
        }

        Spacer(Modifier.height(8.dp))
        Text(
            "写操作一律经确认台 · 不直连店内库",
            fontSize = 10.sp,
            color = Sub,
            modifier = Modifier.align(Alignment.CenterHorizontally)
        )
    }
}

@Composable
private fun StatusChip(text: String, bg: Color, fg: Color) {
    Box(
        Modifier
            .clip(RoundedCornerShape(20.dp))
            .background(bg)
            .padding(horizontal = 10.dp, vertical = 5.dp)
    ) {
        Text(text, fontSize = 11.sp, fontWeight = FontWeight.Bold, color = fg)
    }
}
