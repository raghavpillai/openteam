import { ChevronDown, Pause, Play } from "lucide-react";
import { type CSSProperties, useRef, useState } from "react";

const time = (value: number) =>
  `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;

export function VideoFilePreview({
  source,
  fileName,
}: {
  source: string | null;
  fileName: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [failed, setFailed] = useState(false);
  const [aspect, setAspect] = useState(16 / 9);
  const toggle = () => {
    if (!video.current) return;
    if (playing) video.current.pause();
    else void video.current.play().catch(() => setFailed(true));
  };
  return (
    <div
      className="video-file-preview media-stage-viewer"
      style={{ "--video-aspect": aspect } as CSSProperties}
    >
      <div className="media-stage-cell">
        <div className="video-file-frame">
          {/* biome-ignore lint/a11y/useMediaCaption: User attachments do not include a captions track. */}
          <video
            aria-label={fileName}
            className="video-file-content"
            onClick={toggle}
            onDurationChange={() => {
              const value = video.current?.duration;
              if (value && Number.isFinite(value)) setDuration(value);
            }}
            onEnded={() => setPlaying(false)}
            onLoadedMetadata={() => {
              if (video.current?.videoHeight)
                setAspect(video.current.videoWidth / video.current.videoHeight);
            }}
            onError={() => setFailed(true)}
            onPause={() => setPlaying(false)}
            onPlay={() => setPlaying(true)}
            onTimeUpdate={() => setCurrent(video.current?.currentTime ?? 0)}
            playsInline
            preload="metadata"
            ref={video}
            src={source ?? undefined}
            tabIndex={0}
          />
          <div className="video-file-controls">
            <button
              aria-label={playing ? "Pause video" : "Play video"}
              className="preview-icon-button"
              disabled={!source || failed}
              onClick={toggle}
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
                if (video.current) video.current.currentTime = value;
                setCurrent(value);
              }}
              step={0.01}
              type="range"
              value={current}
            />
            <span className="video-file-time">{time(Math.max(0, duration - current))}</span>
            <details className="video-file-speed">
              <summary aria-label={`Playback speed ${speed}x`}>
                {speed}×<ChevronDown size={10} />
              </summary>
              <div>
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                  <button
                    aria-pressed={speed === rate}
                    key={rate}
                    onClick={(event) => {
                      setSpeed(rate);
                      if (video.current) video.current.playbackRate = rate;
                      event.currentTarget.closest("details")?.removeAttribute("open");
                    }}
                    type="button"
                  >
                    {rate}×
                  </button>
                ))}
              </div>
            </details>
          </div>
          <span className="media-stage-caption">{fileName}</span>
        </div>
      </div>
      {failed && (
        <span className="preview-meta">
          This video couldn’t be loaded. Download it to play on your computer.
        </span>
      )}
    </div>
  );
}
