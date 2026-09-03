import type { BotView, ChannelView } from "@openteam/contracts";
import { Pencil, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { ChannelAvatar } from "./avatar";

type AvatarSource = "generate" | "upload";

const PNG_SIZE = 512;

const canvasPngBase64 = (canvas: HTMLCanvasElement): string =>
  canvas.toDataURL("image/png").slice("data:image/png;base64,".length);

const fileAvatarPng = async (file: File): Promise<string> => {
  if (!file.type.startsWith("image/") || file.size > 10 * 1024 * 1024) {
    throw new Error("Choose an image no larger than 10 MB.");
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const sx = Math.round((image.naturalWidth - side) / 2);
    const sy = Math.round((image.naturalHeight - side) / 2);
    const canvas = document.createElement("canvas");
    canvas.width = PNG_SIZE;
    canvas.height = PNG_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("That image could not be loaded.");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, sx, sy, side, side, 0, 0, PNG_SIZE, PNG_SIZE);
    return canvasPngBase64(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
};

const generatedAvatarPng = (description: string): string => {
  let hash = 2166136261;
  for (const character of description) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const hue = (hash >>> 0) % 360;
  const canvas = document.createElement("canvas");
  canvas.width = PNG_SIZE;
  canvas.height = PNG_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not generate the avatar.");
  const gradient = context.createLinearGradient(0, 0, PNG_SIZE, PNG_SIZE);
  gradient.addColorStop(0, `hsl(${hue} 82% 58%)`);
  gradient.addColorStop(1, `hsl(${(hue + 72) % 360} 76% 38%)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, PNG_SIZE, PNG_SIZE);
  context.globalAlpha = 0.25;
  context.fillStyle = "white";
  context.beginPath();
  context.arc(PNG_SIZE * 0.72, PNG_SIZE * 0.25, PNG_SIZE * 0.3, 0, Math.PI * 2);
  context.fill();
  context.globalAlpha = 1;
  context.fillStyle = "white";
  context.font = "600 210px -apple-system, BlinkMacSystemFont, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(description.trim().charAt(0).toUpperCase() || "G", 256, 270);
  return canvasPngBase64(canvas);
};

export function GroupAvatarEditor({
  botById,
  channel,
  onSave,
}: {
  botById: ReadonlyMap<string, BotView>;
  channel: ChannelView;
  onSave: (pngBase64: string | null) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<AvatarSource>("upload");
  const [description, setDescription] = useState("");
  const [candidate, setCandidate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape, { capture: true });
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape, { capture: true });
    };
  }, [open]);

  const chooseFile = async (file: File | null) => {
    if (!file) return;
    setError(null);
    try {
      setCandidate(await fileAvatarPng(file));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That image could not be loaded.");
    }
  };

  const save = async (pngBase64: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(pngBase64);
      setCandidate(null);
      setOpen(false);
    } catch {
      setError("Could not save the avatar.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative flex flex-col items-center" ref={root}>
      <button
        aria-expanded={open}
        aria-label="Edit Bot avatar"
        className="group relative grid size-16 place-items-center outline-none"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <ChannelAvatar botById={botById} channel={channel} size="lg" />
        <span className="pointer-events-none absolute inset-0 grid place-items-center rounded-full bg-black/30 opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-visible:opacity-100">
          <Pencil className="size-5 text-white" />
        </span>
      </button>
      {open && (
        <div
          aria-label="Avatar editor"
          className="mt-2 w-full rounded-xl bg-[#f0f0f0] p-3 dark:bg-[#181818]"
          onPaste={(event) => {
            const file = [...event.clipboardData.files].find((candidate) =>
              candidate.type.startsWith("image/")
            );
            if (file) {
              event.preventDefault();
              void chooseFile(file);
            }
          }}
          role="dialog"
        >
          <div aria-label="Avatar source" className="flex gap-1" role="tablist">
            {(["generate", "upload"] as const).map((tab) => (
              <button
                aria-selected={source === tab}
                className={cn(
                  "rounded-md px-2 py-1 text-xs capitalize text-muted-foreground",
                  source === tab && "bg-background text-foreground shadow-sm"
                )}
                key={tab}
                onClick={() => {
                  setSource(tab);
                  setCandidate(null);
                  setError(null);
                }}
                role="tab"
                type="button"
              >
                {tab}
              </button>
            ))}
          </div>
          {candidate ? (
            <div className="mt-3 grid gap-3">
              <img
                alt="Avatar preview"
                className="mx-auto size-24 rounded-full object-cover"
                src={`data:image/png;base64,${candidate}`}
              />
              <div className="flex gap-2">
                <Button
                  className="h-8 flex-1 text-xs"
                  onClick={() => setCandidate(null)}
                  variant="secondary"
                >
                  Restart
                </Button>
                <Button
                  className="h-8 flex-1 text-xs"
                  disabled={saving}
                  onClick={() => void save(candidate)}
                >
                  {saving ? "Saving…" : "Set avatar"}
                </Button>
              </div>
            </div>
          ) : source === "upload" ? (
            <div
              className="mt-3 flex min-h-44 flex-col items-center justify-center rounded-lg border border-dashed text-center"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                void chooseFile(event.dataTransfer.files.item(0));
              }}
            >
              <Upload className="mb-2 size-5 text-muted-foreground" />
              <div className="text-sm text-muted-foreground">Drag, drop, or paste an image</div>
              <div className="my-2 text-xs text-foreground-tertiary">or</div>
              <Button
                className="h-8 text-xs"
                onClick={() => fileInput.current?.click()}
                variant="secondary"
              >
                Browse files
              </Button>
              <input
                accept="image/*"
                className="hidden"
                onChange={(event) => void chooseFile(event.currentTarget.files?.[0] ?? null)}
                ref={fileInput}
                type="file"
              />
            </div>
          ) : (
            <div className="mt-3 grid gap-2">
              <textarea
                aria-label="Describe your avatar"
                className="min-h-28 resize-none rounded-lg border bg-background p-2 text-sm outline-none"
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Describe your avatar…"
                value={description}
              />
              <Button
                className="h-8 text-xs"
                disabled={!description.trim()}
                onClick={() => setCandidate(generatedAvatarPng(description))}
              >
                Generate
              </Button>
            </div>
          )}
          {channel.hasAvatar && !candidate && (
            <button
              className="mt-2 w-full text-center text-xs text-muted-foreground hover:text-foreground"
              disabled={saving}
              onClick={() => void save(null)}
              type="button"
            >
              Remove photo
            </button>
          )}
          {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
        </div>
      )}
    </div>
  );
}
