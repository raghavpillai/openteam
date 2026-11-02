package com.openteam.android.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val BackgroundLight = Color(0xFFFCFCFC)
private val SurfaceLight = Color(0xFFF2F2F2)
private val SidebarLight = Color(0xFFF5F5F6)
private val TextLight = Color(0xFF000000)
private val MutedLight = Color(0xFF5F6368)
private val SeparatorLight = Color(0xFFE4E4E4)
private val UserBubbleLight = Color(0xFF0E0E0E)
private val LinkBlue = Color(0xFF016CEC)

@Composable
fun OpenTeamTheme(content: @Composable () -> Unit) {
    val light = lightColorScheme(
        primary = TextLight,
        onPrimary = Color.White,
        primaryContainer = UserBubbleLight,
        onPrimaryContainer = Color.White,
        secondary = LinkBlue,
        secondaryContainer = SeparatorLight,
        onSecondaryContainer = TextLight,
        background = BackgroundLight,
        surface = SurfaceLight,
        surfaceVariant = SidebarLight,
        onSurface = TextLight,
        onSurfaceVariant = MutedLight,
        outline = SeparatorLight,
        error = Color(0xFFC83A3A),
    )
    val dark = darkColorScheme(
        primary = Color.White,
        onPrimary = Color.Black,
        primaryContainer = Color(0xFF545454),
        onPrimaryContainer = Color.White,
        secondary = Color(0xFF4D8DFF),
        secondaryContainer = Color(0xFF303033),
        onSecondaryContainer = Color.White,
        background = Color(0xFF141414),
        surface = Color(0xFF202020),
        surfaceVariant = Color(0xFF181819),
        onSurface = Color.White,
        // Keep secondary and Chinese text legible on the dark canvas. The iOS
        // reference uses white text for readable hierarchy rather than gray.
        onSurfaceVariant = Color.White,
        outline = Color(0xFF343434),
        error = Color(0xFFF48182),
    )
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) dark else light,
        typography = Typography().copy(
            displayLarge = Typography().displayLarge.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold),
            headlineLarge = Typography().headlineLarge.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold),
            titleLarge = Typography().titleLarge.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold),
            bodyLarge = Typography().bodyLarge.copy(lineHeight = 24.sp),
        ),
        shapes = Shapes(
            extraSmall = RoundedCornerShape(10.dp),
            small = RoundedCornerShape(14.dp),
            medium = RoundedCornerShape(20.dp),
            large = RoundedCornerShape(28.dp),
            extraLarge = RoundedCornerShape(34.dp),
        ),
        content = content,
    )
}
