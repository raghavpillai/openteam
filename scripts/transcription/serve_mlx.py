"""A single-model, authenticated voice-note endpoint for Apple silicon.

Install requirements.txt into a venv and install ffmpeg. See docs/transcription.md.
No microphone access, streaming, model-management API, or transcript logging.
"""

import argparse
import asyncio
import hmac
import shutil
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from starlette.responses import JSONResponse

MAX_AUDIO_BYTES = 25 * 1024 * 1024
MAX_REQUEST_BYTES = MAX_AUDIO_BYTES + 64 * 1024


def create_app(model_id: str, api_key: str):
    if len(api_key) < 32:
        raise ValueError("Use a generated API key of at least 32 characters.")
    if not shutil.which("ffmpeg"):
        raise RuntimeError("Install ffmpeg before starting the transcription server.")
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx-transcription")
    loaded = None

    def load_model():
        from mlx_audio.stt.utils import load

        return load(model_id)

    @asynccontextmanager
    async def lifespan(_app):
        nonlocal loaded
        loaded = await asyncio.get_running_loop().run_in_executor(executor, load_model)
        yield
        executor.shutdown(wait=True)

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/health")
    async def health():
        return {"status": "ready" if loaded is not None else "loading"}

    @app.get("/v1/models")
    async def models():
        return {"object": "list", "data": [{"id": model_id, "object": "model", "owned_by": "local"}]}

    def transcribe(audio: bytes):
        # ffmpeg handles desktop WebM/Opus and native iPhone WAV consistently.
        # Restrict protocols so an uploaded playlist cannot fetch remote resources.
        with tempfile.TemporaryDirectory(prefix="openteam-voice-") as directory:
            source = Path(directory) / "input"
            target = Path(directory) / "audio.wav"
            source.write_bytes(audio)
            result = subprocess.run(
                ["ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe",
                 "-i", str(source), "-t", "301", "-vn", "-ar", "16000", "-ac", "1",
                 "-c:a", "pcm_s16le", str(target)],
                capture_output=True, timeout=30, check=False,
            )
            if result.returncode:
                raise HTTPException(415, "Could not decode this recording.")
            import wave

            with wave.open(str(target)) as recording:
                duration = recording.getnframes() / recording.getframerate()
            if duration > 300:
                raise HTTPException(413, "Voice notes must be five minutes or shorter.")
            if duration < 0.5:
                raise HTTPException(422, "The recording is too short.")
            return {"text": loaded.generate(str(target)).text.strip()}

    @app.post("/v1/audio/transcriptions")
    async def audio_transcriptions(request: Request):
        async with request.form(max_files=1, max_fields=8) as form:
            if form.get("model") != model_id:
                raise HTTPException(404, "This server only serves its configured model.")
            if form.get("response_format", "json") != "json":
                raise HTTPException(400, "Use response_format=json.")
            upload = form.get("file")
            if not hasattr(upload, "read"):
                raise HTTPException(400, "A recording file is required.")
            audio = await upload.read(MAX_AUDIO_BYTES + 1)
            if len(audio) > MAX_AUDIO_BYTES:
                raise HTTPException(413, "Voice notes must be 25 MB or smaller.")
            # One worker owns MLX. Cancellation discards the HTTP result, but an
            # in-progress GPU operation must finish before another note can start.
            future = asyncio.get_running_loop().run_in_executor(executor, transcribe, audio)
            try:
                return await asyncio.shield(future)
            except asyncio.CancelledError:
                try:
                    await asyncio.shield(future)
                finally:
                    raise

    class Guard:
        def __init__(self):
            self.busy = False

        async def __call__(self, scope, receive, send):
            if scope["type"] != "http":
                return await app(scope, receive, send)
            headers = dict(scope["headers"])
            if not hmac.compare_digest(headers.get(b"authorization", b""), f"Bearer {api_key}".encode()):
                return await JSONResponse({"error": "Unauthorized"}, status_code=401)(scope, receive, send)
            if scope["method"] != "POST":
                return await app(scope, receive, send)
            if self.busy:
                return await JSONResponse({"error": "A voice note is already processing."}, status_code=429)(scope, receive, send)
            self.busy = True
            try:
                chunks, size = [], 0
                async with asyncio.timeout(30):
                    while True:
                        event = await receive()
                        if event["type"] == "http.disconnect":
                            return
                        chunk = event.get("body", b"")
                        size += len(chunk)
                        if size > MAX_REQUEST_BYTES:
                            return await JSONResponse({"error": "Recording too large."}, status_code=413)(scope, receive, send)
                        chunks.append(chunk)
                        if not event.get("more_body"):
                            break
                body = b"".join(chunks)
                delivered = False

                async def replay():
                    nonlocal delivered
                    if delivered:
                        return await receive()
                    delivered = True
                    return {"type": "http.request", "body": body, "more_body": False}

                await app(scope, replay, send)
            except TimeoutError:
                await JSONResponse({"error": "Recording upload timed out."}, status_code=408)(scope, receive, send)
            finally:
                self.busy = False

    return Guard()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--model", default="mlx-community/parakeet-tdt-0.6b-v3")
    parser.add_argument("--api-key-file", required=True, type=Path)
    args = parser.parse_args()
    uvicorn.run(create_app(args.model, args.api_key_file.read_text().strip()), host=args.host,
                port=args.port, access_log=False)
