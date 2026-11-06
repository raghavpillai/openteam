package com.openteam.features

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import kotlin.math.max
import kotlin.math.min

/**
 * Renders the Markdown commonly emitted by bots without requiring a WebView or a third-party
 * parser. The look follows the desktop client's `markdown.css`: blue links without underline,
 * red inline code and paths, borderless tables, rounded code blocks with syntax colors, and a
 * hidden horizontal rule.
 *
 * [containerColor] is the bubble the text sits on. It picks the light or dark palette and lets
 * links fall back to [contentColor] when the link blue would not be readable on the bubble.
 */
@Composable
fun MarkdownMessage(
    markdown: String,
    modifier: Modifier = Modifier,
    contentColor: Color = MaterialTheme.colorScheme.onSurface,
    containerColor: Color = MaterialTheme.colorScheme.surface,
) {
    val blocks = remember(markdown) { parseMarkdownBlocks(markdown) }
    val style = rememberInlineStyle(contentColor, containerColor)
    SelectionContainer {
        Column(modifier = modifier) {
            blocks.forEachIndexed { index, block ->
                Box(Modifier.padding(bottom = if (index == blocks.lastIndex) 0.dp else block.gapAfter)) {
                    MarkdownBlockView(block, style)
                }
            }
        }
    }
}

@Composable
private fun MarkdownBlockView(block: MarkdownBlock, style: InlineStyle) {
    val contentColor = style.contentColor
    val palette = style.palette
    when (block) {
        is MarkdownBlock.Heading -> {
            val (size, lineHeight) = when (block.level) {
                1 -> 24 to 28
                2 -> 18 to 24
                3 -> 16 to 22
                else -> 15 to 21
            }
            Text(
                text = remember(block.text, style) { inlineMarkdown(block.text, style) },
                color = contentColor,
                style = MaterialTheme.typography.bodyLarge.copy(
                    fontSize = size.sp,
                    lineHeight = lineHeight.sp,
                    fontWeight = FontWeight(650),
                    letterSpacing = (-0.012).em,
                ),
            )
        }
        is MarkdownBlock.Paragraph -> Text(
            text = remember(block.text, style) { inlineMarkdown(block.text, style) },
            color = contentColor,
            style = MaterialTheme.typography.bodyLarge.copy(lineHeight = 25.sp),
        )
        is MarkdownBlock.ListBlock -> MarkdownList(block.items, style)
        is MarkdownBlock.Table -> MarkdownTable(block, style)
        is MarkdownBlock.Quote -> Row(
            modifier = Modifier.fillMaxWidth().height(IntrinsicSize.Min),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Box(
                Modifier
                    .width(2.dp)
                    .fillMaxHeight()
                    .background(palette.quoteBar),
            )
            Text(
                text = remember(block.text, style) { inlineMarkdown(block.text, style) },
                modifier = Modifier.weight(1f),
                color = palette.quoteText,
                style = MaterialTheme.typography.bodyLarge.copy(lineHeight = 24.sp),
            )
        }
        is MarkdownBlock.Code -> MarkdownCodeBlock(block, palette)
    }
}

@Composable
private fun MarkdownCodeBlock(block: MarkdownBlock.Code, palette: MarkdownPalette) {
    // A fenced block with a language is highlighted; a bare fence is a muted plain block.
    val highlighted = block.language != null
    val shape = RoundedCornerShape(13.dp)
    val text = remember(block, palette) {
        if (highlighted) highlightCode(block.code, block.language, palette) else AnnotatedString(block.code)
    }
    Box(
        Modifier
            .fillMaxWidth()
            .background(if (highlighted) palette.codeBackground else palette.plainCodeBackground, shape)
            .then(if (highlighted) Modifier.border(1.dp, palette.codeBorder, shape) else Modifier)
            .clip(shape),
    ) {
        Text(
            text = text,
            color = if (highlighted) palette.codeText else palette.plainCodeText,
            fontFamily = FontFamily.Monospace,
            softWrap = false,
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, lineHeight = 18.sp),
            modifier = Modifier
                .heightIn(max = 400.dp)
                .verticalScroll(rememberScrollState())
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 11.dp, vertical = if (highlighted) 6.dp else 8.dp),
        )
    }
}

@Composable
private fun MarkdownTable(table: MarkdownBlock.Table, style: InlineStyle) {
    // Columns size to their widest cell and the table scrolls sideways, like the desktop's
    // nowrap cells. Only a thin rule separates rows.
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
        Row(Modifier.widthIn(min = 220.dp)) {
            repeat(table.columns) { column ->
                val alignment = table.alignments.getOrNull(column) ?: TableAlignment.Start
                Column(Modifier.width(IntrinsicSize.Max)) {
                    TableCell(table.headers[column], header = true, last = table.rows.isEmpty(), alignment, style)
                    table.rows.forEachIndexed { index, row ->
                        TableCell(
                            row.getOrElse(column) { "" },
                            header = false,
                            last = index == table.rows.lastIndex,
                            alignment = alignment,
                            style = style,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun TableCell(
    text: String,
    header: Boolean,
    last: Boolean,
    alignment: TableAlignment,
    style: InlineStyle,
) {
    val rule = style.palette.tableRule
    Text(
        text = remember(text, style) { inlineMarkdown(text, style) },
        modifier = Modifier
            .fillMaxWidth()
            .drawBehind {
                if (!last) {
                    val y = size.height - 0.5.dp.toPx()
                    drawLine(rule, Offset(0f, y), Offset(size.width, y), strokeWidth = 1.dp.toPx())
                }
            }
            .padding(horizontal = 8.dp, vertical = 6.dp),
        color = style.contentColor,
        fontWeight = if (header) FontWeight.SemiBold else FontWeight.Normal,
        textAlign = alignment.textAlign,
        softWrap = false,
        style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.sp, lineHeight = 18.sp),
    )
}

@Composable
private fun MarkdownList(items: List<MarkdownListItem>, style: InlineStyle) {
    Column(verticalArrangement = Arrangement.spacedBy(4.5.dp)) {
        items.forEach { item ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = (20 * item.depth).dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                val markerWidth = if (item.ordered) 24.dp else 16.dp
                if (item.checked != null) {
                    Box(Modifier.width(markerWidth).padding(top = 5.dp)) {
                        TaskCheckbox(item.checked, style.palette)
                    }
                } else {
                    Text(
                        text = item.marker,
                        modifier = Modifier.width(markerWidth),
                        color = style.palette.marker,
                        textAlign = TextAlign.End,
                        style = MaterialTheme.typography.bodyLarge.copy(lineHeight = 24.sp),
                    )
                }
                Text(
                    text = remember(item.text, style) { inlineMarkdown(item.text, style) },
                    color = style.contentColor,
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.bodyLarge.copy(lineHeight = 24.sp),
                )
            }
        }
    }
}

@Composable
private fun TaskCheckbox(checked: Boolean, palette: MarkdownPalette) {
    val shape = RoundedCornerShape(4.dp)
    Box(
        Modifier
            .size(15.dp)
            .background(if (checked) palette.checkboxCheckedFill else palette.checkboxFill, shape)
            .border(1.dp, if (checked) palette.checkboxCheckedBorder else palette.checkboxBorder, shape),
    ) {
        if (checked) {
            Canvas(Modifier.matchParentSize()) {
                val path = Path().apply {
                    moveTo(size.width * .21f, size.height * .52f)
                    lineTo(size.width * .38f, size.height * .69f)
                    lineTo(size.width * .79f, size.height * .27f)
                }
                drawPath(
                    path,
                    Color.White,
                    style = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round),
                )
            }
        }
    }
}

/** Colors from the desktop's `markdown.css` and `code-theme.ts`, in light and dark variants. */
internal class MarkdownPalette(val dark: Boolean) {
    val link = if (dark) Color(0xFF7AA2FF) else Color(0xFF3062BF)
    val chipText = if (dark) Color(0xFF9AB7FF) else Color(0xFF3062BF)
    val chipBackground = link.copy(alpha = if (dark) .12f else .08f)
    val inlineCodeText = if (dark) Color(0xFFFF5B63) else Color(0xFFC21D2F)
    val inlineCodeBackground = if (dark) Color(0xFF343434) else Color(0xFFE3E3E3)
    val quoteBar = if (dark) Color(0xFF555555) else Color(0xFFA8A8A8)
    val quoteText = if (dark) Color(0xFFB6B6B6) else Color(0xFF6B6B6B)
    val marker = if (dark) Color(0xFFA8A8A8) else Color(0xFF696969)
    val tableRule = if (dark) Color(0xFF484848) else Color(0xFFD4D4D4)
    val codeBackground = if (dark) Color(0xFF000000) else Color(0xFFFCFCFC)
    val codeBorder = if (dark) Color(0xFF000000) else Color(0xFFD9D9D9)
    val codeText = if (dark) Color(0xFFD6D6DD) else Color(0xFF333333)
    val plainCodeBackground = if (dark) Color(0xFF181818) else Color(0xFFE7E7E7)
    val plainCodeText = if (dark) Color(0xFFB6B6B6) else Color(0xFF666666)
    val checkboxFill = if (dark) Color(0xFF181818) else Color(0xFFFBFBFB)
    val checkboxBorder = if (dark) Color(0xFF555555) else Color(0xFFBCBCBC)
    val checkboxCheckedFill = Color(0xFF111111)
    val checkboxCheckedBorder = if (dark) Color(0xFF555555) else Color(0xFF111111)
    val syntaxComment = if (dark) Color(0xFF8B949E) else Color(0xFF686868)
    val syntaxKeyword = if (dark) Color(0xFFFF7B72) else Color(0xFFAE1D42)
    val syntaxFunction = if (dark) Color(0xFFD2A8FF) else Color(0xFFD67551)
    val syntaxType = if (dark) Color(0xFF79C0FF) else Color(0xFF306493)
    val syntaxString = if (dark) Color(0xFFA5D6FF) else Color(0xFFA194D4)
}

/** Everything inline rendering needs, resolved once per bubble. */
internal class InlineStyle(
    val palette: MarkdownPalette,
    val contentColor: Color,
    val linkColor: Color,
    val linkUnderline: Boolean,
    val chipColor: Color,
    val openLink: (String) -> Unit,
)

@Composable
private fun rememberInlineStyle(contentColor: Color, containerColor: Color): InlineStyle {
    val context = LocalContext.current
    val dark = containerColor.luminance() < .5f
    val palette = remember(dark) { MarkdownPalette(dark) }
    return remember(palette, contentColor, containerColor, context) {
        // The link blue can vanish on an accent-colored bubble; use the text color then.
        val linkReadable = contrastRatio(palette.link, containerColor) >= 3f
        val chipReadable = contrastRatio(palette.chipText, containerColor) >= 3f
        InlineStyle(
            palette = palette,
            contentColor = contentColor,
            linkColor = if (linkReadable) palette.link else contentColor,
            linkUnderline = !linkReadable,
            chipColor = if (chipReadable) palette.chipText else contentColor,
            openLink = { url -> openMarkdownLink(context, url) },
        )
    }
}

private fun contrastRatio(a: Color, b: Color): Float {
    val first = a.luminance()
    val second = b.luminance()
    return (max(first, second) + .05f) / (min(first, second) + .05f)
}

private val linkSchemes = setOf("http", "https", "mailto", "tel")

private fun openMarkdownLink(context: Context, url: String) {
    runCatching {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        if (context !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }
}

internal sealed interface MarkdownBlock {
    data class Heading(val level: Int, val text: String) : MarkdownBlock
    data class Paragraph(val text: String) : MarkdownBlock
    data class ListBlock(val items: List<MarkdownListItem>) : MarkdownBlock
    data class Quote(val text: String) : MarkdownBlock
    data class Code(val language: String?, val code: String) : MarkdownBlock
    data class Table(
        val headers: List<String>,
        val rows: List<List<String>>,
        val alignments: List<TableAlignment>,
    ) : MarkdownBlock {
        val columns: Int get() = headers.size
    }
}

internal data class MarkdownListItem(
    val depth: Int,
    val ordered: Boolean,
    /** The bullet, or the running number with a trailing dot. */
    val marker: String,
    val text: String,
    /** Null for a normal item; set for a `- [ ]` / `- [x]` task item. */
    val checked: Boolean?,
)

/** Space below each block, taken from the margins in the desktop's `markdown.css`. */
private val MarkdownBlock.gapAfter: Dp
    get() = when (this) {
        is MarkdownBlock.Heading -> when (level) {
            1 -> 15.dp
            2, 3 -> 14.dp
            else -> 10.dp
        }
        is MarkdownBlock.Quote -> 13.dp
        is MarkdownBlock.Table -> 11.dp
        is MarkdownBlock.Code -> 8.dp
        else -> 10.dp
    }

internal enum class TableAlignment(val textAlign: TextAlign) {
    Start(TextAlign.Start),
    Center(TextAlign.Center),
    End(TextAlign.End),
}

internal fun parseMarkdownBlocks(markdown: String): List<MarkdownBlock> {
    val lines = markdown.replace("\r\n", "\n").split('\n')
    val blocks = mutableListOf<MarkdownBlock>()
    val paragraph = mutableListOf<String>()
    var index = 0

    fun flushParagraph() {
        if (paragraph.isNotEmpty()) {
            blocks += MarkdownBlock.Paragraph(paragraph.joinToString("\n"))
            paragraph.clear()
        }
    }

    while (index < lines.size) {
        val line = lines[index]
        val trimmed = line.trim()
        when {
            trimmed.isBlank() -> {
                flushParagraph()
                index++
            }
            line.trimStart().startsWith("```") -> {
                flushParagraph()
                val language = line.trim().removePrefix("```").trim().takeIf(String::isNotBlank)
                index++
                val code = buildList {
                    while (index < lines.size && !lines[index].trimStart().startsWith("```")) {
                        add(lines[index])
                        index++
                    }
                }.joinToString("\n")
                if (index < lines.size) index++
                blocks += MarkdownBlock.Code(language, code)
            }
            headingRegex.matches(line) -> {
                flushParagraph()
                val match = headingRegex.matchEntire(line)!!
                blocks += MarkdownBlock.Heading(
                    level = match.groupValues[1].length.coerceIn(1, 4),
                    text = match.groupValues[2].trim(),
                )
                index++
            }
            // The desktop client hides horizontal rules, so they only end the paragraph.
            dividerRegex.matches(line) -> {
                flushParagraph()
                index++
            }
            index + 1 < lines.size && isTableHeader(line) && isTableSeparator(lines[index + 1]) -> {
                flushParagraph()
                val headers = splitTableRow(line)
                val separators = splitTableRow(lines[index + 1])
                val alignments = separators.map(::tableAlignment)
                index += 2
                val rows = mutableListOf<List<String>>()
                while (index < lines.size && isTableDataRow(lines[index], headers.size)) {
                    rows += splitTableRow(lines[index]).padTo(headers.size)
                    index++
                }
                blocks += MarkdownBlock.Table(headers, rows, alignments)
            }
            isListStart(line) -> {
                flushParagraph()
                val (items, next) = parseListItems(lines, index)
                blocks += MarkdownBlock.ListBlock(items)
                index = next
            }
            quoteRegex.matches(line) -> {
                flushParagraph()
                val quoteLines = mutableListOf<String>()
                while (index < lines.size) {
                    val match = quoteRegex.matchEntire(lines[index]) ?: break
                    quoteLines += match.groupValues[1]
                    index++
                }
                blocks += MarkdownBlock.Quote(quoteLines.joinToString("\n").trim())
            }
            else -> {
                paragraph += line.trimEnd()
                index++
            }
        }
    }
    flushParagraph()
    return blocks
}

private fun indentWidth(indent: String): Int = indent.replace("\t", "    ").length

/** A list may only start at an indent of 0-3 spaces; deeper lines are continuation text. */
private fun isListStart(line: String): Boolean =
    listItemRegex.matchEntire(line)?.let { indentWidth(it.groupValues[1]) <= 3 } == true

/** Reads consecutive list lines, including nested items, and returns the index after the list. */
private fun parseListItems(lines: List<String>, start: Int): Pair<List<MarkdownListItem>, Int> {
    val items = mutableListOf<MarkdownListItem>()
    val indents = ArrayDeque<Int>()
    val counters = mutableMapOf<Int, Int>()
    var index = start
    while (index < lines.size) {
        val line = lines[index]
        if (line.isBlank()) {
            // One blank line between items is still the same list.
            val next = lines.getOrNull(index + 1)
            if (next != null && listItemRegex.matches(next) && !dividerRegex.matches(next)) {
                index++
                continue
            }
            break
        }
        if (dividerRegex.matches(line)) break
        val match = listItemRegex.matchEntire(line) ?: break
        val indent = indentWidth(match.groupValues[1])
        val markerText = match.groupValues[2]
        while (indents.isNotEmpty() && indent < indents.last()) indents.removeLast()
        if (indents.isEmpty() || indent > indents.last()) indents.addLast(indent)
        val depth = indents.size - 1
        counters.keys.removeAll { it > depth }

        val ordered = markerText.first().isDigit()
        val marker = if (ordered) {
            val number = counters[depth]?.plus(1) ?: markerText.takeWhile(Char::isDigit).toIntOrNull() ?: 1
            counters[depth] = number
            "$number."
        } else {
            counters.remove(depth)
            when (depth) {
                0 -> "•"
                1 -> "◦"
                else -> "▪"
            }
        }
        var text = match.groupValues[3].trim()
        var checked: Boolean? = null
        taskRegex.matchEntire(text)?.let { task ->
            checked = task.groupValues[1] != " "
            text = task.groupValues[2]
        }
        items += MarkdownListItem(depth, ordered, marker, text, checked)
        index++
    }
    return items to index
}

internal fun inlineMarkdown(text: String, style: InlineStyle): AnnotatedString =
    buildAnnotatedString { appendInline(text, style) }

private fun AnnotatedString.Builder.appendInline(text: String, style: InlineStyle) {
    var cursor = 0
    for (match in inlineRegex.findAll(text)) {
        if (match.range.first < cursor) continue
        append(text, cursor, match.range.first)
        cursor = appendToken(match, style)
    }
    append(text, cursor, text.length)
}

/** Appends one inline token and returns the index in the source where plain text resumes. */
private fun AnnotatedString.Builder.appendToken(match: MatchResult, style: InlineStyle): Int {
    val groups = match.groups
    val end = match.range.last + 1
    val token = match.value
    when {
        groups[1] != null -> appendLink(groups[2]!!.value, groups[1]!!.value, style)
        groups[3] != null -> appendLink(groups[3]!!.value, groups[3]!!.value, style)
        groups[4] != null -> {
            // Trailing punctuation belongs to the sentence, not the address.
            val url = token.trimEnd('.', ',', ';', ':', '!', '?')
            appendLink(url, url, style)
            return match.range.first + url.length
        }
        groups[5] != null -> withStyle(
            SpanStyle(
                fontFamily = FontFamily.Monospace,
                fontSize = .93.em,
                color = style.palette.inlineCodeText,
                background = style.palette.inlineCodeBackground,
            ),
        ) {
            append(" ${token.substring(1, token.length - 1)} ")
        }
        groups[6] != null -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) {
            appendInline(token.substring(2, token.length - 2), style)
        }
        groups[7] != null -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) {
            appendInline(token.substring(2, token.length - 2), style)
        }
        else -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) {
            appendInline(token.substring(1, token.length - 1), style)
        }
    }
    return end
}

private fun AnnotatedString.Builder.appendLink(href: String, label: String, style: InlineStyle) {
    val scheme = href.substringBefore(':', "").lowercase()
    val chip = SpanStyle(
        color = style.chipColor,
        background = style.palette.chipBackground,
        fontWeight = FontWeight.Medium,
    )
    when {
        // A reference to an earlier message: shown as the desktop's jump chip.
        scheme == "sand-msg" -> withStyle(chip) { append("↪ $label") }
        scheme == "openteam" -> withLink(
            LinkAnnotation.Clickable(
                tag = href,
                styles = TextLinkStyles(style = chip),
                linkInteractionListener = { style.openLink(href) },
            ),
        ) { append(label) }
        scheme in linkSchemes -> withLink(
            LinkAnnotation.Clickable(
                tag = href,
                styles = TextLinkStyles(
                    style = SpanStyle(
                        color = style.linkColor,
                        textDecoration = if (style.linkUnderline) TextDecoration.Underline else null,
                    ),
                ),
                linkInteractionListener = { style.openLink(href) },
            ),
        ) { append(label) }
        // Unknown schemes (javascript:, file:, relative paths) are not made tappable.
        else -> append(label)
    }
}

private val hashCommentLanguages = setOf(
    "python", "py", "bash", "sh", "shell", "zsh", "yaml", "yml", "toml", "ruby", "rb",
    "dockerfile", "makefile", "ini", "conf", "r", "perl", "powershell", "ps1", "properties",
)
private val dashCommentLanguages = setOf("sql", "lua", "haskell", "hs")

/** A small language-agnostic highlighter; it colors comments, strings, numbers, keywords and calls. */
internal fun highlightCode(code: String, language: String?, palette: MarkdownPalette): AnnotatedString {
    val name = language?.trim()?.substringBefore(' ')?.lowercase().orEmpty()
    val json = name == "json" || name == "jsonc"
    val commentRegex = when (name) {
        in hashCommentLanguages -> hashCommentRegex
        in dashCommentLanguages -> dashCommentRegex
        else -> slashCommentRegex
    }
    return buildAnnotatedString {
        var cursor = 0
        val tokens = if (json) jsonTokenRegex else codeTokenRegex(commentRegex)
        for (match in tokens.findAll(code)) {
            if (match.range.first < cursor) continue
            append(code, cursor, match.range.first)
            val color = when {
                match.groups[1] != null -> palette.syntaxComment
                match.groups[2] != null -> if (json) null else palette.syntaxString
                match.groups[3] != null -> palette.syntaxType
                match.groups[4] != null -> palette.syntaxKeyword
                else -> palette.syntaxFunction
            }
            val text = if (match.groups[5] != null) match.groups[5]!!.value else match.value
            if (color == null) append(text) else withStyle(SpanStyle(color = color)) { append(text) }
            cursor = match.range.first + text.length
        }
        append(code, cursor, code.length)
    }
}

private const val stringPattern = """"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`"""
private const val numberPattern = """\b\d+(?:\.\d+)?\b"""
private const val keywordPattern =
    """\b(?:if|else|elif|for|while|do|return|break|continue|switch|case|default|function|fun|val|var|let|""" +
        """const|class|interface|object|import|from|export|package|fn|def|lambda|async|await|try|catch|""" +
        """finally|throw|throws|new|in|is|as|when|enum|struct|impl|trait|pub|use|mod|type|static|public|""" +
        """private|protected|void|int|string|bool|true|false|null|nil|None|True|False|self|this|super|""" +
        """extends|implements|with|yield|not|and|or|echo|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|""" +
        """TABLE|JOIN|ON|AND|OR|NOT|NULL)\b"""
private const val callPattern = """\b[A-Za-z_]\w*(?=\()"""

private val slashCommentRegex = """//[^\n]*|/\*[\s\S]*?\*/"""
private val hashCommentRegex = """(?<![^\s])#[^\n]*"""
private val dashCommentRegex = """--[^\n]*|/\*[\s\S]*?\*/"""

private val codeTokenCache = HashMap<String, Regex>()

/** Groups: 1 comment, 2 string, 3 number, 4 keyword, 5 function name (call). */
private fun codeTokenRegex(comment: String): Regex = synchronized(codeTokenCache) {
    codeTokenCache.getOrPut(comment) {
        Regex("($comment)|($stringPattern)|($numberPattern)|($keywordPattern)|($callPattern)")
    }
}

/** JSON keeps strings in the text color; only numbers and literals are tinted. */
private val jsonTokenRegex = Regex("($slashCommentRegex)|($stringPattern)|($numberPattern)|(\\b(?:true|false|null)\\b)|($callPattern)")

private fun isTableHeader(line: String): Boolean =
    line.contains('|') && splitTableRow(line).size >= 2

private fun isTableSeparator(line: String): Boolean =
    line.contains('|') && splitTableRow(line).size >= 2 &&
        splitTableRow(line).all { tableSeparatorRegex.matches(it) }

private fun isTableDataRow(line: String, columnCount: Int): Boolean =
    line.contains('|') && splitTableRow(line).size >= columnCount

private fun splitTableRow(line: String): List<String> {
    val normalized = line.trim().removePrefix("|").removeSuffix("|")
    val cells = mutableListOf<String>()
    val cell = StringBuilder()
    var escaped = false
    var codeSpan = false
    normalized.forEach { character ->
        when {
            character == '`' -> {
                codeSpan = !codeSpan
                cell.append(character)
                escaped = false
            }
            character == '\\' && !escaped -> {
                escaped = true
                cell.append(character)
            }
            character == '|' && !escaped && !codeSpan -> {
                cells += cell.toString().trim()
                cell.clear()
            }
            else -> {
                cell.append(character)
                escaped = false
            }
        }
    }
    cells += cell.toString().trim().replace("\\|", "|")
    return cells
}

private fun tableAlignment(separator: String): TableAlignment = when {
    separator.trim().startsWith(":") && separator.trim().endsWith(":") -> TableAlignment.Center
    separator.trim().endsWith(":") -> TableAlignment.End
    else -> TableAlignment.Start
}

private fun List<String>.padTo(size: Int): List<String> =
    take(size).let { values -> values + List(max(0, size - values.size)) { "" } }

private val headingRegex = Regex("""^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$""")
private val listItemRegex = Regex("""^([ \t]*)([-+*]|\d{1,9}[.)])\s+(.+)$""")
private val taskRegex = Regex("""^\[([ xX])]\s+(.*)$""")
private val quoteRegex = Regex("""^\s{0,3}>\s?(.*)$""")
private val dividerRegex = Regex("""^\s{0,3}([-*_])(?:\s*\1){2,}\s*$""")
private val tableSeparatorRegex = Regex("""^:?-{3,}:?$""")

/**
 * Inline tokens, one capture group each so [appendToken] can tell them apart:
 * 1/2 `[label](href)`, 3 `<autolink>`, 4 bare URL, 5 `code`, 6 bold, 7 strike, 8 italic.
 * Underscore emphasis needs a word boundary so `file_name_v2` and CJK text are left alone.
 */
private val inlineRegex = Regex(
    listOf(
        """\[([^\]\n]+)]\(\s*([^)\s]+)(?:\s+"[^"\n]*")?\s*\)""",
        """<([a-zA-Z][a-zA-Z0-9+.\-]*:[^>\s]+)>""",
        """(https?://[^\s<>"'()\[\]⺀-鿿＀-￯]+)""",
        """(`[^`\n]+?`)""",
        """(\*\*(?!\s)[^*\n]+?(?<!\s)\*\*|(?<![\p{L}\p{N}])__[^_\n]+?__(?![\p{L}\p{N}]))""",
        """(~~[^~\n]+?~~)""",
        """(\*(?![\s*])[^*\n]+?(?<!\s)\*|(?<![\p{L}\p{N}_])_[^_\n]+?_(?![\p{L}\p{N}_]))""",
    ).joinToString("|"),
)
