import { ButtonPrimitive } from "../ui/button-primitive";
import type { AssetRef, ChannelLibraryItem } from "@openteam/contracts";
import { parseAssetRef } from "@openteam/product-core/messages";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { ImageIcon, MoreHorizontal } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../client/openteam-api";
import { useAuthenticatedResource } from "../../hooks/use-authenticated-resource";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { LoadingOrb } from "../ui/loading-orb";
import { FileGlyph, fileGlyphVariant } from "./attachment-visuals";

const Preview = lazy(() =>
  import("./file-attachment").then((m) => ({ default: m.FileAttachmentPreview }))
);
const pinKey = (id: string) => `openteam:library-pins:${id}`;
const readPins = (id: string): ChannelLibraryItem[] => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(pinKey(id)) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.slice(0, 100).flatMap((item) => {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.messageId !== "string" ||
        typeof item.createdAt !== "string" ||
        !Number.isFinite(Date.parse(item.createdAt))
      )
        return [];
      const attachment = parseAssetRef(item.attachment);
      return attachment && item.id === attachment.assetId
        ? [
            {
              id: attachment.assetId,
              messageId: item.messageId,
              createdAt: item.createdAt,
              attachment,
            },
          ]
        : [];
    });
  } catch {
    return [];
  }
};
const groupFor = (date: string, now: Date) => {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const age = today - new Date(date).getTime();
  return age <= 0
    ? "Today"
    : age <= 86_400_000
      ? "Yesterday"
      : age <= 7 * 86_400_000
        ? "Last 7 days"
        : "Older";
};
const ageLabel = (date: string) => {
  const age = Math.max(0, Date.now() - new Date(date).getTime());
  return age >= 86_400_000
    ? `${Math.floor(age / 86_400_000)}d`
    : age >= 3_600_000
      ? `${Math.floor(age / 3_600_000)}h`
      : "now";
};

function LibraryFileIcon({ attachment }: { attachment: AssetRef }) {
  const image = attachment.kind === "image";
  const source = useAuthenticatedResource(image ? api.assetUrl(attachment) : null);
  const [failed, setFailed] = useState<string | null>(null);
  if (image)
    return (
      <span aria-hidden className="bot-library-thumbnail">
        {source && failed !== source ? (
          <img alt="" src={source} onError={() => setFailed(source)} />
        ) : (
          <ImageIcon className="size-4 text-foreground-secondary" />
        )}
      </span>
    );
  return (
    <span className="bot-library-file-icon">
      <FileGlyph variant={fileGlyphVariant(attachment.fileName)} />
    </span>
  );
}

export function ChannelLibrary({
  channelId,
  revision,
  active,
}: {
  channelId: string;
  revision?: string;
  active: boolean;
}) {
  const [items, setItems] = useState<ChannelLibraryItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ChannelLibraryItem | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [pins, setPins] = useState(() => readPins(channelId));
  const request = useRef<AbortController | null>(null);
  const attemptedCursor = useRef<string | null>(null);
  const load = useCallback(
    async (before: string | null = null) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      attemptedCursor.current = before;
      setLoading(true);
      setError(null);
      try {
        const page = await api.channelLibrary(channelId, before, controller.signal);
        if (controller.signal.aborted) return;
        setItems((previous) => {
          const combined = new Map((before ? previous : []).map((item) => [item.id, item]));
          for (const item of page.items) if (!combined.has(item.id)) combined.set(item.id, item);
          return [...combined.values()];
        });
        setNext(page.nextCursor);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(clientErrorMessage(cause, "Couldn’t load Library"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [channelId]
  );
  useEffect(() => {
    if (active) void load();
    return () => request.current?.abort();
  }, [active, load, revision]);
  const pin = (item: ChannelLibraryItem) =>
    setPins((previous) => {
      const next = previous.some((pin) => pin.id === item.id)
        ? previous.filter((pin) => pin.id !== item.id)
        : [item, ...previous].slice(0, 100);
      try {
        localStorage.setItem(pinKey(channelId), JSON.stringify(next));
      } catch {
        /* Pinning remains available for this session. */
      }
      return next;
    });
  const pinIds = new Set(pins.map((item) => item.id));
  const visible = new Map(items.map((item) => [item.id, item]));
  for (const item of pins) if (!visible.has(item.id)) visible.set(item.id, item);
  const groups = new Map<string, ChannelLibraryItem[]>();
  const now = new Date();
  for (const item of visible.values()) {
    const group = pinIds.has(item.id) ? "Pinned" : groupFor(item.createdAt, now);
    const bucket = groups.get(group) ?? [];
    bucket.push(item);
    groups.set(group, bucket);
  }
  return (
    <div className="bot-library">
      {!visible.size && loading && (
        <div className="bot-library-empty" role="status">
          <LoadingOrb className="size-5" />
          <span>Loading Library…</span>
        </div>
      )}
      {!visible.size && !loading && !error && (
        <p className="bot-library-empty">Pages, files, and apps this Bot makes show up here</p>
      )}
      {error && (
        <div className="bot-library-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => void load(attemptedCursor.current)} size="sm" variant="ghost">
            Try again
          </Button>
        </div>
      )}
      {["Pinned", "Today", "Yesterday", "Last 7 days", "Older"].map(
        (group) =>
          groups.has(group) && (
            <section className="bot-library-group" key={group}>
              <h3 className="bot-details-heading">{group}</h3>
              <ul aria-label={group}>
                {groups.get(group)!.map((item) => (
                  <li className="bot-library-row" key={item.id}>
                    <ButtonPrimitive
                      aria-label={item.attachment.fileName}
                      className="bot-library-open"
                      onClick={() => {
                        setSelected(item);
                        setPreviewOpen(true);
                      }}
                      type="button"
                    >
                      <LibraryFileIcon attachment={item.attachment} />
                      <span className="min-w-0 flex-1 truncate" dir="auto">
                        {item.attachment.fileName}
                      </span>
                      <time
                        className="shrink-0 text-foreground-secondary"
                        dateTime={item.createdAt}
                      >
                        {ageLabel(item.createdAt)}
                      </time>
                    </ButtonPrimitive>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <ButtonPrimitive
                          aria-label={`More actions for ${item.attachment.fileName}`}
                          className="bot-library-more"
                          type="button"
                        >
                          <MoreHorizontal className="size-4" />
                        </ButtonPrimitive>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        alignOffset={16}
                        sideOffset={4}
                        className="bot-library-menu"
                      >
                        <DropdownMenuItem onSelect={() => pin(item)}>
                          {pinIds.has(item.id) ? "Unpin" : "Pin"}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                ))}
              </ul>
            </section>
          )
      )}
      {next && !error && (
        <Button
          className="my-3 w-full"
          disabled={loading}
          onClick={() => void load(next)}
          size="sm"
          variant="ghost"
          loading={loading}
          loadingLabel="Loading…"
        >
          Load more
        </Button>
      )}
      {selected && (
        <Suspense
          fallback={
            <span className="sr-only" role="status">
              Loading preview…
            </span>
          }
        >
          <Preview
            attachment={selected.attachment}
            onOpenChange={setPreviewOpen}
            open={previewOpen}
          />
        </Suspense>
      )}
    </div>
  );
}
