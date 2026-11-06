package com.openteam.features

import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf

val LocalAppLanguage = staticCompositionLocalOf { AppSettings.Language.English }

@Composable
fun localizedText(english: String, chinese: String): String =
    if (LocalAppLanguage.current == AppSettings.Language.Chinese) chinese else english
