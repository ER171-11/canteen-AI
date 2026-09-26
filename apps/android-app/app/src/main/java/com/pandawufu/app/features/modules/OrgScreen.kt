package com.pandawufu.app.features.modules

import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.pandawufu.app.AppModule
import com.pandawufu.shared.model.OrgCreateStoreRequest
import com.pandawufu.shared.model.OrgCreateUserRequest
import com.pandawufu.shared.model.OrgOverviewResponse
import com.pandawufu.shared.model.OrgUpdateUserRequest
import kotlinx.coroutines.launch

/** 门店 / 岗位 / 账号 — 老板可在 App 内开店、开账号 */
@Composable
fun OrgScreen() {
    var data by remember { mutableStateOf<OrgOverviewResponse?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var showCreateUser by remember { mutableStateOf(false) }
    var showCreateStore by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val canWriteOrg = AppModule.can("org", write = true) ||
        AppModule.role == "老板" ||
        AppModule.permissions.contains("org.write")

    fun reload() {
        scope.launch {
            loading = true
            error = null
            try {
                AppModule.ensureSession()
                val resp = AppModule.bffClient.orgOverview()
                if (!resp.ok) {
                    val fail = com.pandawufu.shared.util.LoadFailure.fromMessage(resp.error)
                    error = fail.error ?: fail.hint ?: (resp.error ?: "加载失败")
                    data = null
                } else {
                    data = resp
                }
            } catch (e: Exception) {
                val fail = com.pandawufu.shared.util.LoadFailure.from(e)
                error = fail.error ?: fail.hint
                data = null
            } finally {
                loading = false
            }
        }
    }

    LaunchedEffect(Unit) { reload() }

    ModuleScaffold(
        title = "门店岗位",
        subtitle = if (canWriteOrg) "开店 · 开账号 · 岗位权限" else "只读 · 找老板开账号",
        loading = loading && data == null,
        error = error,
        onRetry = { reload() },
        empty = !loading && data == null,
        emptyText = "暂无组织数据"
    ) {
        data?.inviteHint?.let {
            Text(it, style = MaterialTheme.typography.bodySmall)
        }
        if (canWriteOrg) {
            Button(
                onClick = { showCreateStore = true },
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth()
            ) { Text("筹备新门店") }
            Button(
                onClick = { showCreateUser = true },
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth()
            ) { Text("开岗位账号") }
        }
        data?.let { org ->
            if (org.stores.isNotEmpty()) {
                ModuleCard("门店（${org.stores.size}）") {
                    org.stores.forEach { s ->
                        KvRow(
                            s.name ?: s.id ?: "-",
                            listOfNotNull(s.city, s.status, s.address).joinToString(" · ")
                        )
                    }
                }
            }
            if (org.positions.isNotEmpty()) {
                ModuleCard("岗位（${org.positions.size}）") {
                    org.positions.forEach { p ->
                        KvRow(
                            p.name ?: p.id ?: "-",
                            if (p.write == true) "可写 · ${p.permissions.size} 权" else "只读 · ${p.permissions.size} 权"
                        )
                    }
                }
            }
            if (org.users.isNotEmpty()) {
                ModuleCard("账号（${org.users.size}）") {
                    org.users.take(40).forEach { u ->
                        KvRow(
                            "${u.displayName ?: u.account ?: "-"} · ${u.role ?: ""}",
                            listOfNotNull(u.positionName, u.storeName, u.account).joinToString(" · ")
                        )
                        val acc = u.account
                        if (canWriteOrg && !acc.isNullOrBlank() && acc != AppModule.account) {
                            OutlinedButton(
                                onClick = {
                                    scope.launch {
                                        try {
                                            AppModule.ensureSession()
                                            val resp = AppModule.bffClient.orgUpdateUser(
                                                OrgUpdateUserRequest(account = acc, status = "disabled")
                                            )
                                            Toast.makeText(
                                                context,
                                                if (resp.ok) "已停用 $acc" else (resp.error ?: "失败"),
                                                Toast.LENGTH_SHORT
                                            ).show()
                                            if (resp.ok) reload()
                                        } catch (e: Exception) {
                                            Toast.makeText(context, e.message ?: "失败", Toast.LENGTH_SHORT).show()
                                        }
                                    }
                                },
                                shape = RoundedCornerShape(10.dp),
                                modifier = Modifier.fillMaxWidth()
                            ) { Text("停用 $acc") }
                        }
                    }
                }
            }
        }
    }

    if (showCreateStore) {
        var name by remember { mutableStateOf("") }
        var city by remember { mutableStateOf("") }
        var address by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { showCreateStore = false },
            title = { Text("筹备新门店") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        label = { Text("门店名") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = city,
                        onValueChange = { city = it },
                        label = { Text("城市") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = address,
                        onValueChange = { address = it },
                        label = { Text("地址") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    Text("状态将设为「筹备中」；推送店内快照后简报才有真数", style = MaterialTheme.typography.bodySmall)
                }
            },
            confirmButton = {
                Button(onClick = {
                    if (name.isBlank()) {
                        Toast.makeText(context, "请填门店名", Toast.LENGTH_SHORT).show()
                        return@Button
                    }
                    scope.launch {
                        try {
                            AppModule.ensureSession()
                            val resp = AppModule.bffClient.orgCreateStore(
                                OrgCreateStoreRequest(
                                    name = name.trim(),
                                    city = city.trim().ifBlank { null },
                                    address = address.trim().ifBlank { null },
                                    status = "筹备中"
                                )
                            )
                            Toast.makeText(
                                context,
                                if (resp.ok) "已创建 ${resp.store?.name}" else (resp.error ?: "失败"),
                                Toast.LENGTH_SHORT
                            ).show()
                            if (resp.ok) {
                                showCreateStore = false
                                reload()
                            }
                        } catch (e: Exception) {
                            Toast.makeText(context, e.message ?: "失败", Toast.LENGTH_SHORT).show()
                        }
                    }
                }) { Text("创建") }
            },
            dismissButton = {
                OutlinedButton(onClick = { showCreateStore = false }) { Text("取消") }
            }
        )
    }

    if (showCreateUser) {
        var account by remember { mutableStateOf("") }
        var displayName by remember { mutableStateOf("") }
        var password by remember { mutableStateOf("wufu123") }
        val positions = data?.positions.orEmpty()
        val stores = data?.stores.orEmpty()
        var positionId by remember {
            mutableStateOf(positions.firstOrNull { it.name == "收银" }?.id ?: positions.firstOrNull()?.id.orEmpty())
        }
        var storeId by remember { mutableStateOf(stores.firstOrNull()?.id.orEmpty()) }

        AlertDialog(
            onDismissRequest = { showCreateUser = false },
            title = { Text("开岗位账号") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = account,
                        onValueChange = { account = it },
                        label = { Text("登录账号") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = displayName,
                        onValueChange = { displayName = it },
                        label = { Text("显示名") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = password,
                        onValueChange = { password = it },
                        label = { Text("初始密码") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    if (positions.isNotEmpty()) {
                        Text("岗位", style = MaterialTheme.typography.labelMedium)
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            positions.take(6).forEach { p ->
                                FilterChip(
                                    selected = positionId == p.id,
                                    onClick = { positionId = p.id.orEmpty() },
                                    label = { Text(p.name ?: p.id ?: "-") }
                                )
                            }
                        }
                    }
                    if (stores.isNotEmpty()) {
                        Text("门店", style = MaterialTheme.typography.labelMedium)
                        stores.take(4).forEach { s ->
                            FilterChip(
                                selected = storeId == s.id,
                                onClick = { storeId = s.id.orEmpty() },
                                label = { Text((s.name ?: s.id ?: "-").take(18)) }
                            )
                        }
                    }
                }
            },
            confirmButton = {
                Button(onClick = {
                    if (account.isBlank()) {
                        Toast.makeText(context, "请填登录账号", Toast.LENGTH_SHORT).show()
                        return@Button
                    }
                    scope.launch {
                        try {
                            AppModule.ensureSession()
                            val resp = AppModule.bffClient.orgCreateUser(
                                OrgCreateUserRequest(
                                    account = account.trim().lowercase(),
                                    password = password.ifBlank { "wufu123" },
                                    displayName = displayName.trim().ifBlank { null },
                                    positionId = positionId.ifBlank { null },
                                    storeId = storeId.ifBlank { null }
                                )
                            )
                            Toast.makeText(
                                context,
                                if (resp.ok) "已开通 ${resp.user?.account}" else (resp.error ?: "失败"),
                                Toast.LENGTH_SHORT
                            ).show()
                            if (resp.ok) {
                                showCreateUser = false
                                reload()
                            }
                        } catch (e: Exception) {
                            Toast.makeText(context, e.message ?: "失败", Toast.LENGTH_SHORT).show()
                        }
                    }
                }) { Text("开通") }
            },
            dismissButton = {
                OutlinedButton(onClick = { showCreateUser = false }) { Text("取消") }
            }
        )
    }
}
