package com.openteam.android.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openteam.features.AppSettings

private val BackgroundLight = Color(0xFFFCFCFC)
private val SurfaceLight = Color(0xFFF2F2F2)
private val SidebarLight = Color(0xFFF5F5F6)
private val TextLight = Color(0xFF000000)
private val MutedLight = Color(0xFF5F6368)
private val SeparatorLight = Color(0xFFE4E4E4)
private val UserBubbleLight = Color(0xFF0E0E0E)
private val LinkBlue = Color(0xFF016CEC)
private val SuccessLight = Color(0xFF16845B)
private val SuccessDark = Color(0xFF83D6A5)

@Composable
fun OpenTeamTheme(
    appearance: AppSettings.Appearance = AppSettings.Appearance.System,
    accent: AppSettings.Accent = AppSettings.Accent.Black,
    content: @Composable () -> Unit,
) {
    val systemDark = isSystemInDarkTheme()
    val darkTheme = when (appearance) {
        AppSettings.Appearance.System -> systemDark
        AppSettings.Appearance.Light -> false
        AppSettings.Appearance.Dark -> true
    }
    val accentColor = when (accent) {
        AppSettings.Accent.Black -> if (darkTheme) Color.White else TextLight
        AppSettings.Accent.Blue -> Color(0xFF1769E0)
        AppSettings.Accent.Purple -> Color(0xFF7B4FD1)
        AppSettings.Accent.Green -> if (darkTheme) SuccessDark else Color(0xFF277A45)
    }
    val light = lightColorScheme(
        primary = accentColor,
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
        tertiary = SuccessLight,
        onTertiary = Color.White,
        error = Color(0xFFC83A3A),
    )
    val dark = darkColorScheme(
        primary = accentColor,
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
        tertiary = SuccessDark,
        onTertiary = Color(0xFF00391F),
        error = Color(0xFFF48182),
    )
    MaterialTheme(
        colorScheme = if (darkTheme) dark else light,
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
        content = {
            Surface(
                modifier = Modifier.fillMaxSize(),
                color = MaterialTheme.colorScheme.background,
                contentColor = MaterialTheme.colorScheme.onBackground,
                content = content,
            )
        },
    )
}
