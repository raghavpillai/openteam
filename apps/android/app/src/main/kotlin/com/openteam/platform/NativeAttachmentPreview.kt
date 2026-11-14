package com.openteam.platform

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import com.openteam.features.Attachment
import java.io.File

object NativeAttachmentPreview {
    fun contentUri(context: Context, value: String): Uri {
        val parsed = Uri.parse(value)
        if (parsed.scheme == "content" || parsed.scheme == "file") return parsed
        return FileProvider.getUriForFile(context, "${context.packageName}.files", File(value))
    }

    fun open(context: Context, attachment: Attachment): Result<Unit> = runCatching {
        val local = attachment.localUri?.takeIf(String::isNotBlank)
            ?: error("Download the attachment before opening it.")
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(contentUri(context, local), attachment.mimeType.ifBlank { "application/octet-stream" })
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        check(intent.resolveActivity(context.packageManager) != null) {
            "No Android app can preview ${attachment.name}."
        }
        context.startActivity(intent)
    }
}
