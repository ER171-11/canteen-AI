package com.pandawufu.app.offline

import com.pandawufu.shared.model.SupplyModuleDto
import com.pandawufu.shared.model.LossModuleDto
import com.pandawufu.shared.model.ReviewModuleDto
import com.pandawufu.shared.model.VipModuleDto
import com.pandawufu.shared.model.TakeoutModuleDto
import com.pandawufu.shared.model.EquipmentModuleDto
import com.pandawufu.shared.model.FinanceModuleDto
import com.pandawufu.shared.model.FoodsafeModuleDto
import com.pandawufu.shared.model.BookingModuleDto
import com.pandawufu.shared.model.StaffModuleDto
import com.pandawufu.shared.model.AnalysisModuleDto
import com.pandawufu.shared.model.HealthDto
import com.pandawufu.shared.model.ReportDailyDto
import com.pandawufu.shared.model.SnapshotDto
import com.pandawufu.shared.network.BffClient
import com.pandawufu.shared.repository.HealthRepository
import com.pandawufu.shared.repository.ModulesRepository
import com.pandawufu.shared.repository.ReportRepository
import com.pandawufu.shared.repository.SnapshotRepository
import kotlinx.serialization.encodeToString

/** 只读仓储缓存装饰：联网写缓存，断网回放。 */
class CachingReportRepository(
    private val inner: ReportRepository,
    private val cache: OfflineCache,
    private val bff: BffClient
) : ReportRepository {
    override suspend fun daily(): ReportDailyDto =
        try {
            val v = inner.daily()
            cache.put("report/daily", bff.json.encodeToString(v))
            v
        } catch (e: Exception) {
            val raw = cache.get("report/daily") ?: throw e
            bff.json.decodeFromString(ReportDailyDto.serializer(), raw)
        }
}

class CachingSnapshotRepository(
    private val inner: SnapshotRepository,
    private val cache: OfflineCache,
    private val bff: BffClient
) : SnapshotRepository {
    override suspend fun latest(): SnapshotDto =
        try {
            val v = inner.latest()
            cache.put("snapshot/latest", bff.json.encodeToString(v))
            v
        } catch (e: Exception) {
            val raw = cache.get("snapshot/latest")
            if (raw != null) {
                bff.json.decodeFromString(SnapshotDto.serializer(), raw)
            } else if (com.pandawufu.shared.util.LoadFailure.from(e).soft) {
                SnapshotDto(ok = true, data = com.pandawufu.shared.model.SnapshotDataDto())
            } else {
                throw e
            }
        }
}

class CachingHealthRepository(
    private val inner: HealthRepository,
    private val cache: OfflineCache,
    private val bff: BffClient
) : HealthRepository {
    override suspend fun health(): HealthDto =
        try {
            val v = inner.health()
            cache.put("health", bff.json.encodeToString(v))
            v
        } catch (e: Exception) {
            val raw = cache.get("health") ?: throw e
            bff.json.decodeFromString(HealthDto.serializer(), raw)
        }
}

class CachingModulesRepository(
    private val inner: ModulesRepository,
    private val cache: OfflineCache,
    private val bff: BffClient
) : ModulesRepository {
    private suspend inline fun <reified T> wrap(
        key: String,
        crossinline live: suspend () -> T
    ): T = try {
        val v = live()
        cache.put(key, bff.json.encodeToString(v))
        v
    } catch (e: Exception) {
        val raw = cache.get(key) ?: throw e
        bff.json.decodeFromString(raw)
    }

    override suspend fun staff(): StaffModuleDto = wrap("modules/staff") { inner.staff() }
    override suspend fun booking(date: String?): BookingModuleDto =
        wrap("modules/booking") { inner.booking(date) }
    override suspend fun foodsafe(): FoodsafeModuleDto = wrap("modules/foodsafe") { inner.foodsafe() }
    override suspend fun analysis(): AnalysisModuleDto = wrap("modules/analysis") { inner.analysis() }
    override suspend fun vip(): VipModuleDto = wrap("modules/vip") { inner.vip() }
    override suspend fun takeout(): TakeoutModuleDto = wrap("modules/takeout") { inner.takeout() }
    override suspend fun review(): ReviewModuleDto = wrap("modules/review") { inner.review() }
    override suspend fun equipment(): EquipmentModuleDto = wrap("modules/equipment") { inner.equipment() }
    override suspend fun finance(): FinanceModuleDto = wrap("modules/finance") { inner.finance() }
    override suspend fun loss(): LossModuleDto = wrap("modules/loss") { inner.loss() }
    override suspend fun supply(): SupplyModuleDto = wrap("modules/supply") { inner.supply() }
}
