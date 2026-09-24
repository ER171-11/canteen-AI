package com.pandawufu.shared.pos

/** POS 桌台单条可撤销操作（并单/拆单/加菜/退菜/改价等）。 */
data class UndoOp(
    val sessionId: String,
    val seq: Long,
    val opType: String,
    val before: String,
    val after: String,
    val ts: Long,
    val reverted: Boolean = false
)

/**
 * POS 并拆单撤销栈（对齐原型 p-m-pos 的 undo 交互）：
 *  - push：追加操作，清空 redo 概念（本栈只支持顺序撤销，无重做）；
 *  - undo：弹出最近一条未撤销操作并标记 reverted，返回它供 UI 回放 before 状态；
 *  - 已撤销条目保留在栈内（reverted=true）供审计，与 undo_stack 表结构一致。
 */
class UndoStack(private val sessionId: String) {
    private val ops = mutableListOf<UndoOp>()
    private var nextSeq = 1L

    val size: Int get() = ops.count { !it.reverted }

    val pending: List<UndoOp> get() = ops.filter { !it.reverted }

    fun push(opType: String, before: String, after: String, ts: Long): UndoOp {
        val op = UndoOp(sessionId, nextSeq++, opType, before, after, ts)
        ops += op
        return op
    }

    fun undo(): UndoOp? {
        val idx = ops.indexOfLast { !it.reverted }
        if (idx < 0) return null
        val op = ops[idx]
        ops[idx] = op.copy(reverted = true)
        return op
    }

    fun clear() {
        ops.clear()
    }
}
