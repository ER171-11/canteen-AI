package com.pandawufu.shared.pos

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class UndoStackTest {

    @Test
    fun pushAppendsAndIncrementsSeq() {
        val stack = UndoStack("T1")
        val a = stack.push("merge", "[]", "[A+B]", 1L)
        val b = stack.push("split", "[A+B]", "[A][B]", 2L)
        assertEquals(1L, a.seq)
        assertEquals(2L, b.seq)
        assertEquals(2, stack.size)
    }

    @Test
    fun undoPopsMostRecentAndMarksReverted() {
        val stack = UndoStack("T1")
        stack.push("add", "qty=0", "qty=2", 1L)
        val second = stack.push("merge", "[]", "[A+B]", 2L)
        val undone = stack.undo()
        assertEquals(second.seq, undone?.seq)
        assertEquals(1, stack.size)
        // 已撤销条目保留审计（pending 只剩第一条）
        assertEquals("add", stack.pending.single().opType)
    }

    @Test
    fun undoOnEmptyReturnsNull() {
        val stack = UndoStack("T1")
        assertNull(stack.undo())
        stack.push("split", "[A+B]", "[A][B]", 1L)
        stack.undo()
        assertNull(stack.undo())
        assertEquals(0, stack.size)
    }

    @Test
    fun undoOrderIsLifo() {
        val stack = UndoStack("T2")
        stack.push("op1", "b1", "a1", 1L)
        stack.push("op2", "b2", "a2", 2L)
        stack.push("op3", "b3", "a3", 3L)
        assertEquals("op3", stack.undo()?.opType)
        assertEquals("op2", stack.undo()?.opType)
        assertEquals("op1", stack.undo()?.opType)
        assertTrue(stack.pending.isEmpty())
    }
}
