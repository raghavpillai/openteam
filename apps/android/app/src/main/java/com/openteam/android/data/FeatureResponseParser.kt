package com.openteam.android.data

import com.openteam.mobile.core.mobileJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Keeps the feature API object-shaped while accepting endpoints that return
 * either an object or a top-level JSON array.
 */
internal fun parseFeatureResponse(body: String): JsonObject {
    if (body.isBlank()) return JsonObject(emptyMap())
    val value = mobileJson.parseToJsonElement(body)
    return when (value) {
        is JsonObject -> value
        else -> buildJsonObject { put("value", value) }
    }
}
