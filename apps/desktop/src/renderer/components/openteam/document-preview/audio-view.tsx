import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useRef, useState } from "react";

const time = (value: number) =>
  `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;

export function AudioFilePreview({
  source,
  fileName,
}: {
  source: string | null;
  fileName: string;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [muted, setMuted] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className="audio-file-preview">
      <div className="audio-file-player">
        <audio
          onDurationChange={() => {
            const value = audio.current?.duration;
            if (value && Number.isFinite(value)) setDuration(value);
          }}
          onEnded={() => setPlaying(false)}
          onError={() => setFailed(true)}
          onPause={() => setPlaying(false)}
          onPlay={() => setPlaying(true)}
          onTimeUpdate={() => setCurrent(audio.current?.currentTime ?? 0)}
          preload="metadata"
          ref={audio}
          src={source ?? undefined}
        />
        <button
          aria-label={`${playing ? "Pause" : "Play"} ${fileName}`}
          className="preview-icon-button"
          disabled={!source || failed}
          onClick={() => {
            if (!audio.current) return;
            if (playing) audio.current.pause();
            else void audio.current.play().catch(() => setFailed(true));
          }}
          type="button"
        >
          {playing ? (
            <Pause size={15} fill="currentColor" />
          ) : (
            <Play size={15} fill="currentColor" />
          )}
        </button>
        <input
          aria-label={`Seek in ${fileName}`}
          className="audio-file-seek"
          disabled={!duration}
          max={duration || 1}
          min={0}
          onChange={(event) => {
            const value = Number(event.currentTarget.value);
            if (audio.current) audio.current.currentTime = value;
            setCurrent(value);
          }}
          step={0.01}
          type="range"
          value={current}
        />
        <span className="audio-file-time">
          {time(current)} / {time(duration)}
        </span>
        <button
          aria-label={`Playback speed ${speed}x`}
          className="audio-file-speed"
          onClick={() => {
            const options = [1, 1.25, 1.5, 2, 0.75];
            const next = options[(options.indexOf(speed) + 1) % options.length]!;
            if (audio.current) audio.current.playbackRate = next;
            setSpeed(next);
          }}
          type="button"
        >
          {speed}x
        </button>
        <button
          aria-label={muted ? "Unmute" : "Mute"}
          className="preview-icon-button"
          onClick={() => {
            if (audio.current) audio.current.muted = !muted;
            setMuted(!muted);
          }}
          type="button"
        >
          {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
        </button>
      </div>
      {failed && (
        <p className="preview-meta">
          This audio couldn’t be loaded. Download it to listen on your computer.
        </p>
      )}
    </div>
  );
}
