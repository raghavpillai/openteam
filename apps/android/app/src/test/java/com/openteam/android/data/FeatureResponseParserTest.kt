package com.openteam.android.data

import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FeatureResponseParserTest {
    @Test
    fun keepsObjectRootUnchanged() {
        val response = parseFeatureResponse("""{"routines":[{"id":"routine-1"}]}""")

        assertEquals("routine-1", response["routines"]?.jsonArray?.single()?.jsonObject?.get("id")?.jsonPrimitive?.content)
    }

    @Test
    fun wrapsArrayRootForExistingFeatureMappers() {
        val response = parseFeatureResponse("""[{"id":"routine-1"},{"id":"routine-2"}]""")

        assertEquals(2, response["value"]?.jsonArray?.size)
        assertEquals("routine-2", response["value"]?.jsonArray?.get(1)?.jsonObject?.get("id")?.jsonPrimitive?.content)
    }

    @Test
    fun mapsEmptyBodyToEmptyObject() {
        assertTrue(parseFeatureResponse(" ").keys.isEmpty())
    }
}
