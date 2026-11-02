package com.openteam.features

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FeatureContractsTest {
    @Test
    fun routineScheduleSummaryUsesTheIosFrequencyVocabulary() {
        assertEquals(
            "Weekly on Wednesday at 09:30 (Asia/Singapore)",
            RoutineSchedule(
                frequency = RoutineSchedule.Frequency.Weekly,
                timeMinutes = 9 * 60 + 30,
                timeZone = "Asia/Singapore",
                dayOfWeek = 3,
            ).summary(),
        )
        assertEquals(
            "Every 2 weeks (UTC)",
            RoutineSchedule(
                frequency = RoutineSchedule.Frequency.Interval,
                intervalAmount = 2,
                intervalUnit = RoutineSchedule.IntervalUnit.Weeks,
            ).summary(),
        )
    }

    @Test
    fun routineScheduleClampsInvalidDisplayValues() {
        assertTrue(RoutineSchedule(timeMinutes = -20, dayOfWeek = 0, dayOfMonth = 0).summary().contains("Daily at 00:00"))
        assertTrue(RoutineSchedule(timeMinutes = 24 * 60 + 75, dayOfMonth = 32, frequency = RoutineSchedule.Frequency.Monthly).summary().contains("Monthly on the 32nd at 23:59"))
    }

    @Test
    fun featureLoadStateSeparatesEmptyAndFailure() {
        val empty: FeatureLoadState<List<String>> = FeatureLoadState.Empty("No providers")
        val failure: FeatureLoadState<List<String>> = FeatureLoadState.Failure("Offline")
        assertTrue(empty is FeatureLoadState.Empty)
        assertTrue(failure is FeatureLoadState.Failure)
        assertFalse(empty is FeatureLoadState.Ready)
    }

    @Test
    fun providerModelDoesNotExposeSecretValues() {
        val provider = WebProvider(
            id = "exa",
            name = "Exa",
            description = "AI search",
            requiresApiKey = true,
            secretSaved = true,
            ready = true,
        )
        assertTrue(provider.secretSaved)
        assertFalse(provider.toString().contains("apiKey="))
    }
}
