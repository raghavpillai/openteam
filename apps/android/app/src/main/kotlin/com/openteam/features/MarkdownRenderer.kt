package com.openteam.features

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.max

/**
 * Renders the Markdown commonly emitted by bots without requiring a WebView or a third-party
 * parser. Block parsing keeps code and lists readable, while inline parsing handles emphasis,
 * links, and inline code.
 */
@Composable
fun MarkdownMessage(
    markdown: String,
    modifier: Modifier = Modifier,
    contentColor: Color = MaterialTheme.colorScheme.onSurface,
) {
    val blocks = remember(markdown) { parseMarkdownBlocks(markdown) }
    SelectionContainer {
        Column(
            modifier = modifier,
            verticalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            blocks.forEach { block ->
                when (block) {
                    is MarkdownBlock.Heading -> Text(
                        text = inlineMarkdown(block.text, contentColor),
                        color = contentColor,
                        fontWeight = FontWeight.SemiBold,
                        style = when (block.level) {
                            1 -> MaterialTheme.typography.headlineSmall
                            2 -> MaterialTheme.typography.titleLarge
                            3 -> MaterialTheme.typography.titleMedium
                            else -> MaterialTheme.typography.titleSmall
                        },
                    )
                    is MarkdownBlock.Paragraph -> Text(
                        text = inlineMarkdown(block.text, contentColor),
                        color = contentColor,
                        style = MaterialTheme.typography.bodyLarge.copy(lineHeight = 25.sp),
                    )
                    is MarkdownBlock.UnorderedList -> MarkdownList(
                        items = block.items,
                        ordered = false,
                        contentColor = contentColor,
                    )
                    is MarkdownBlock.OrderedList -> MarkdownList(
                        items = block.items,
                        ordered = true,
                        contentColor = contentColor,
                    )
                    is MarkdownBlock.Table -> MarkdownTable(block, contentColor)
                    is MarkdownBlock.Quote -> Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        VerticalDivider(
                            thickness = 3.dp,
                            color = MaterialTheme.colorScheme.secondary,
                        )
                        Text(
                            text = inlineMarkdown(block.text, contentColor),
                            modifier = Modifier.weight(1f),
                            color = contentColor.copy(alpha = .82f),
                            style = MaterialTheme.typography.bodyLarge.copy(
                                fontStyle = FontStyle.Italic,
                                lineHeight = 24.sp,
                            ),
                        )
                    }
                    is MarkdownBlock.Code -> Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(
                                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = .82f),
                                MaterialTheme.shapes.small,
                            )
                            .padding(horizontal = 14.dp, vertical = 11.dp),
                        verticalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        block.language?.let {
                            Text(
                                text = it,
                                color = MaterialTheme.colorScheme.secondary,
                                style = MaterialTheme.typography.labelSmall,
                                fontWeight = FontWeight.Medium,
                            )
                        }
                        Text(
                            text = block.code,
                            color = MaterialTheme.colorScheme.onSurface,
                            fontFamily = FontFamily.Monospace,
                            style = MaterialTheme.typography.bodySmall.copy(lineHeight = 19.sp),
                        )
                    }
                    MarkdownBlock.Divider -> HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                }
            }
        }
    }
}

@Composable
private fun MarkdownTable(table: MarkdownBlock.Table, contentColor: Color) {
    val horizontalScroll = rememberScrollState()
    val borderColor = MaterialTheme.colorScheme.outline.copy(alpha = .55f)
    val columnWidths = remember(table) {
        List(table.columns) { index ->
            val longestCell = table.rows
                .mapNotNull { it.getOrNull(index) }
                .plus(table.headers.getOrNull(index).orEmpty())
                .maxOfOrNull { it.trim().length }
                ?: 0
            (longestCell * 8 + 32).coerceIn(104, 240).dp
        }
    }
    val tableWidth = columnWidths.sumOf { it.value.toDouble() }.toFloat().dp

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(horizontalScroll),
    ) {
        Column(Modifier.width(maxOf(tableWidth, 320.dp))) {
            TableRow(
                cells = table.headers,
                widths = columnWidths,
                header = true,
                alignments = table.alignments,
                contentColor = contentColor,
                borderColor = borderColor,
            )
            table.rows.forEachIndexed { index, row ->
                TableRow(
                    cells = row,
                    widths = columnWidths,
                    header = false,
                    alternate = index % 2 == 1,
                    alignments = table.alignments,
                    contentColor = contentColor,
                    borderColor = borderColor,
                )
            }
        }
    }
}

@Composable
private fun TableRow(
    cells: List<String>,
    widths: List<androidx.compose.ui.unit.Dp>,
    header: Boolean,
    alternate: Boolean = false,
    alignments: List<TableAlignment>,
    contentColor: Color,
    borderColor: Color,
) {
    Row(Modifier.fillMaxWidth()) {
        widths.forEachIndexed { index, width ->
            val cell = cells.getOrNull(index).orEmpty()
            val alignment = alignments.getOrNull(index) ?: TableAlignment.Start
            Text(
                text = inlineMarkdown(cell, contentColor),
                modifier = Modifier
                    .width(width)
                    .background(
                        when {
                            header -> MaterialTheme.colorScheme.secondaryContainer
                            alternate -> MaterialTheme.colorScheme.surfaceVariant.copy(alpha = .42f)
                            else -> Color.Transparent
                        },
                    )
                    .border(1.dp, borderColor)
                    .padding(horizontal = 10.dp, vertical = 9.dp),
                color = contentColor,
                fontWeight = if (header) FontWeight.SemiBold else FontWeight.Normal,
                textAlign = alignment.textAlign,
                style = MaterialTheme.typography.bodyMedium.copy(lineHeight = 21.sp),
            )
        }
    }
}

@Composable
private fun MarkdownList(
    items: List<String>,
    ordered: Boolean,
    contentColor: Color,
) {
    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        items.forEachIndexed { index, item ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = if (ordered) "${index + 1}." else "•",
                    color = MaterialTheme.colorScheme.secondary,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(top = 1.dp),
                )
                Text(
                    text = inlineMarkdown(item, contentColor),
                    color = contentColor,
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.bodyLarge.copy(lineHeight = 24.sp),
                )
            }
        }
    }
}

private sealed interface MarkdownBlock {
    data class Heading(val level: Int, val text: String) : MarkdownBlock
    data class Paragraph(val text: String) : MarkdownBlock
    data class UnorderedList(val items: List<String>) : MarkdownBlock
    data class OrderedList(val items: List<String>) : MarkdownBlock
    data class Quote(val text: String) : MarkdownBlock
    data class Code(val language: String?, val code: String) : MarkdownBlock
    data class Table(
        val headers: List<String>,
        val rows: List<List<String>>,
        val alignments: List<TableAlignment>,
    ) : MarkdownBlock {
        val columns: Int get() = headers.size
    }
    data object Divider : MarkdownBlock
}

private enum class TableAlignment(val textAlign: androidx.compose.ui.text.style.TextAlign) {
    Start(androidx.compose.ui.text.style.TextAlign.Start),
    Center(androidx.compose.ui.text.style.TextAlign.Center),
    End(androidx.compose.ui.text.style.TextAlign.End),
}

private fun parseMarkdownBlocks(markdown: String): List<MarkdownBlock> {
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
            dividerRegex.matches(line) -> {
                flushParagraph()
                blocks += MarkdownBlock.Divider
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
            unorderedRegex.matches(line) -> {
                flushParagraph()
                val items = mutableListOf<String>()
                while (index < lines.size) {
                    val match = unorderedRegex.matchEntire(lines[index]) ?: break
                    items += match.groupValues[1].trim()
                    index++
                }
                blocks += MarkdownBlock.UnorderedList(items)
            }
            orderedRegex.matches(line) -> {
                flushParagraph()
                val items = mutableListOf<String>()
                while (index < lines.size) {
                    val match = orderedRegex.matchEntire(lines[index]) ?: break
                    items += match.groupValues[2].trim()
                    index++
                }
                blocks += MarkdownBlock.OrderedList(items)
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

@Composable
private fun inlineMarkdown(text: String, contentColor: Color): AnnotatedString {
    val inlineCodeBackground = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = .8f)
    return buildAnnotatedString {
        var cursor = 0
        inlineRegex.findAll(text).forEach { match ->
            append(text.substring(cursor, match.range.first))
            val token = match.value
            when {
                token.startsWith("**") || token.startsWith("__") -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) {
                    append(token.substring(2, token.length - 2))
                }
                token.startsWith("~~") -> withStyle(
                    SpanStyle(textDecoration = TextDecoration.LineThrough),
                ) {
                    append(token.substring(2, token.length - 2))
                }
                token.startsWith("*") || token.startsWith("_") -> withStyle(
                    SpanStyle(fontStyle = FontStyle.Italic),
                ) {
                    append(token.substring(1, token.length - 1))
                }
                token.startsWith("`") -> withStyle(
                    SpanStyle(
                        fontFamily = FontFamily.Monospace,
                        background = inlineCodeBackground,
                    ),
                ) {
                    append(" ${token.substring(1, token.length - 1)} ")
                }
                token.startsWith("[") -> {
                    val label = token.substringAfter('[').substringBefore(']')
                    withStyle(
                        SpanStyle(
                            color = contentColor.copy(alpha = .9f),
                            textDecoration = TextDecoration.Underline,
                        ),
                    ) {
                        append(label)
                    }
                }
                else -> append(token)
            }
            cursor = match.range.last + 1
        }
        append(text.substring(cursor))
    }
}

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
private val unorderedRegex = Regex("""^\s{0,3}[-+*]\s+(.+)$""")
private val orderedRegex = Regex("""^\s{0,3}(\d+)[.)]\s+(.+)$""")
private val quoteRegex = Regex("""^\s{0,3}>\s?(.*)$""")
private val dividerRegex = Regex("""^\s{0,3}([-*_])(?:\s*\1){2,}\s*$""")
private val tableSeparatorRegex = Regex("""^:?-{3,}:?$""")
private val inlineRegex = Regex(
    """(\*\*[^*\n]+?\*\*|__[^_\n]+?__|~~[^~\n]+?~~|\*[^*\n]+?\*|_[^_\n]+?_|`[^`\n]+?`|\[[^\]\n]+]\([^)\n]+\))""",
)
