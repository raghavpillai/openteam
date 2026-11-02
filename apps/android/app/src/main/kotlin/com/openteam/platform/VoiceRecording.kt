package com.openteam.platform

import android.content.Context
import android.media.MediaRecorder
import android.net.Uri
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** A recording is kept until transcription succeeds or the user explicitly discards it. */
sealed interface VoiceRecordingState {
    data object Idle : VoiceRecordingState
    data object Starting : VoiceRecordingState
    data class Recording(val startedAtMs: Long) : VoiceRecordingState
    data class Interrupted(val recording: Uri) : VoiceRecordingState
    data class Transcribing(val recording: Uri) : VoiceRecordingState
    data class Review(val recording: Uri, val error: String? = null) : VoiceRecordingState
    data class Failed(val message: String) : VoiceRecordingState
}

interface VoiceCapture {
    fun start(): Uri
    fun currentUri(): Uri?
    fun pause()
    fun resume()
    fun stop(): Uri
    fun cancel()
}

fun interface VoiceTranscriber {
    suspend fun transcribe(recording: Uri): String
}

/** Coordinates permission-safe recording, interruptions, retry, and draft preservation. */
class VoiceRecordingController(
    private val capture: VoiceCapture,
    private val transcriber: VoiceTranscriber,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
) {
    private val _state = MutableStateFlow<VoiceRecordingState>(VoiceRecordingState.Idle)
    val state: StateFlow<VoiceRecordingState> = _state.asStateFlow()
    private var transcriptionJob: Job? = null

    fun start(): Boolean {
        if (_state.value !is VoiceRecordingState.Idle) return false
        _state.value = VoiceRecordingState.Starting
        return try {
            capture.start()
            _state.value = VoiceRecordingState.Recording(System.currentTimeMillis())
            true
        } catch (error: Throwable) {
            _state.value = VoiceRecordingState.Failed(error.message ?: "Unable to start recording")
            false
        }
    }

    /** Pause instead of deleting audio when a call, route change, or permission UI interrupts. */
    fun onInterruption() {
        val current = _state.value
        if (current is VoiceRecordingState.Recording) {
            try {
                capture.pause()
                _state.value = VoiceRecordingState.Interrupted(capture.currentUri() ?: Uri.EMPTY)
            } catch (error: Throwable) {
                _state.value = VoiceRecordingState.Failed(error.message ?: "Recording was interrupted")
            }
        }
    }

    fun resumeAfterInterruption(): Boolean {
        if (_state.value !is VoiceRecordingState.Interrupted) return false
        return try {
            capture.resume()
            _state.value = VoiceRecordingState.Recording(System.currentTimeMillis())
            true
        } catch (error: Throwable) {
            _state.value = VoiceRecordingState.Failed(error.message ?: "Unable to resume recording")
            false
        }
    }

    fun stopAndTranscribe(draft: String, onTranscript: (String) -> Unit = {}) {
        if (_state.value !is VoiceRecordingState.Recording && _state.value !is VoiceRecordingState.Interrupted) return
        val recording = try {
            capture.stop()
        } catch (error: Throwable) {
            _state.value = VoiceRecordingState.Failed(error.message ?: "Unable to save recording")
            return
        }
        _state.value = VoiceRecordingState.Transcribing(recording)
        transcriptionJob?.cancel()
        transcriptionJob = scope.launch {
            try {
                val transcript = transcriber.transcribe(recording).trim()
                onTranscript(VoiceDraftComposer.merge(draft, transcript))
                _state.value = VoiceRecordingState.Idle
            } catch (error: Throwable) {
                _state.value = VoiceRecordingState.Review(recording, error.message ?: "Transcription failed")
            }
        }
    }

    fun retry(draft: String, onTranscript: (String) -> Unit = {}) {
        val review = _state.value as? VoiceRecordingState.Review ?: return
        _state.value = VoiceRecordingState.Transcribing(review.recording)
        transcriptionJob?.cancel()
        transcriptionJob = scope.launch {
            try {
                val transcript = transcriber.transcribe(review.recording).trim()
                onTranscript(VoiceDraftComposer.merge(draft, transcript))
                _state.value = VoiceRecordingState.Idle
            } catch (error: Throwable) {
                _state.value = VoiceRecordingState.Review(review.recording, error.message ?: "Transcription failed")
            }
        }
    }

    fun cancel() {
        transcriptionJob?.cancel()
        if (_state.value !is VoiceRecordingState.Idle) runCatching { capture.cancel() }
        _state.value = VoiceRecordingState.Idle
    }

    fun close() {
        cancel()
        transcriptionJob = null
    }
}

object VoiceDraftComposer {
    fun merge(draft: String, transcript: String): String {
        val left = draft.trimEnd()
        val right = transcript.trim()
        return when {
            left.isEmpty() -> right
            right.isEmpty() -> left
            else -> "$left $right"
        }
    }
}

/** Android microphone implementation. The controller owns all lifecycle transitions. */
class AndroidVoiceCapture(context: Context) : VoiceCapture {
    private val outputDirectory = File(context.cacheDir, "voice-notes").also { it.mkdirs() }
    private var recorder: MediaRecorder? = null
    private var output: File? = null

    override fun start(): Uri {
        check(recorder == null) { "A voice recording is already active" }
        val file = File(outputDirectory, "${UUID.randomUUID()}.m4a")
        val next = MediaRecorder().apply {
            setAudioSource(MediaRecorder.AudioSource.MIC)
            setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            setAudioEncodingBitRate(128_000)
            setAudioSamplingRate(44_100)
            setOutputFile(file.absolutePath)
            prepare()
            start()
        }
        output = file
        recorder = next
        return Uri.fromFile(file)
    }

    override fun currentUri(): Uri? = output?.let(Uri::fromFile)

    override fun pause() { recorder?.pause() ?: error("No voice recording") }
    override fun resume() { recorder?.resume() ?: error("No voice recording") }

    override fun stop(): Uri {
        val active = recorder ?: error("No voice recording")
        val file = output ?: error("No voice recording output")
        try { active.stop() } finally {
            active.release()
            recorder = null
            output = null
        }
        return Uri.fromFile(file)
    }

    override fun cancel() {
        recorder?.runCatching { stop() }
        recorder?.release()
        recorder = null
        output?.delete()
        output = null
    }
}
