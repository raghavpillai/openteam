import type { BotMemoryEntry, BotView } from "@openteam/contracts";
import {
  Brain,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../../client/openteam-api";
import {
  acknowledgeMemoryChanges,
  hasUnseenMemoryChange,
  subscribeMemoryChanges,
  subscribeMemoryRefresh,
} from "../../lib/memory-events";
import { createMemoryView, type MemoryViewState } from "../../lib/memory-view";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";

export function BotMemoryPanel({ bot }: { bot: Pick<BotView, "id" | "name"> }) {
  const [state, setState] = useState<MemoryViewState>({
    data: null,
    loading: true,
    error: null,
    pending: null,
  });
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<BotMemoryEntry | "all" | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const controller = useRef<ReturnType<typeof createMemoryView> | null>(null);
  useEffect(() => {
    let previousIds: Set<string> | null = null;
    setSelected(null);
    setNewIds(new Set());
    const view = createMemoryView({
      load: () => api.botMemories(bot.id),
      remove: (id) => (id ? api.deleteBotMemory(bot.id, id) : api.clearBotMemories(bot.id)),
      change: (next) => {
        setState(next);
        if (!next.data || next.loading) return;
        const ids = new Set(next.data.memories.map((memory) => memory.id));
        if (previousIds) {
          const added = [...ids].filter((id) => !previousIds!.has(id));
          setNewIds((current) => new Set([...current, ...added].filter((id) => ids.has(id))));
        }
        previousIds = ids;
        setSelected((id) => (id && ids.has(id) ? id : null));
      },
    });
    controller.current = view;
    void view.refresh();
    // The main event stream reconnects with a fresh read. Only this open view subscribes.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeMemoryRefresh((id) => {
      if (id !== null && id !== bot.id) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void view.refresh(), 50);
    });
    const focus = () => void view.refresh();
    window.addEventListener("focus", focus);
    return () => {
      view.stop();
      controller.current = null;
      if (timer) clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("focus", focus);
    };
  }, [bot.id]);
  const filtered =
    state.data?.memories.filter((memory) =>
      memory.content.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim())
    ) ?? [];
  const confirm = async () => {
    if (!target) return;
    if (await controller.current?.remove(target === "all" ? undefined : target.id)) setTarget(null);
  };
  const entry = state.data?.memories.find((memory) => memory.id === selected);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {entry ? (
        <>
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="flex min-h-8 items-center gap-1.5 self-start rounded-lg pr-2 text-[13px] text-foreground-secondary hover:bg-subtle"
          >
            <ChevronLeft className="size-4" />
            All memories
          </button>
          <div className="bot-scrollbar min-h-0 flex-1 overflow-y-auto">
            <div className="mb-1.5 px-2 text-[12px] text-foreground-secondary">Content</div>
            <p className="whitespace-pre-wrap break-words rounded-xl bg-subtle p-3 text-[14px] leading-5">
              {entry.content}
            </p>
            <p className="mt-2 px-2 text-[12px] text-foreground-secondary">
              {entry.kind === "profile" ? "Profile" : "Journal"} ·{" "}
              {new Date(entry.createdAt).toISOString().slice(0, 10)}
            </p>
            <button
              type="button"
              disabled={Boolean(state.pending)}
              onClick={() => setTarget(entry)}
              className="mt-4 flex items-center gap-2 rounded-lg px-2 py-2 text-[13px] text-destructive hover:bg-subtle"
            >
              <Trash2 className="size-3.5" />
              Delete memory
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-foreground-secondary" />
              <Input
                aria-label="Search memories"
                placeholder="Search saved memories"
                value={query}
                className="h-[30px] rounded-[8px] border-0 bg-field pl-8 text-[13px] shadow-none focus-visible:ring-1"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Button
              aria-label="Refresh memories"
              variant="ghost"
              size="icon"
              className="size-7 rounded-lg text-foreground-secondary"
              disabled={Boolean(state.pending)}
              onClick={() => void controller.current?.refresh()}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </div>
          {state.loading ? (
            <div role="status" className="grid flex-1 place-items-center py-12">
              <LoaderCircle
                aria-label="Loading memories"
                className="size-4 animate-spin text-foreground-secondary"
              />
            </div>
          ) : (
            <div className="bot-scrollbar min-h-0 flex-1 overflow-y-auto">
              {filtered.length ? (
                <ul className="divide-y divide-foreground/10 rounded-xl bg-subtle px-3">
                  {filtered.map((memory) => (
                    <li key={memory.id} className="group flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          setSelected(memory.id);
                          setNewIds((current) => {
                            const next = new Set(current);
                            next.delete(memory.id);
                            return next;
                          });
                        }}
                        className="flex min-h-[54px] min-w-0 flex-1 items-center gap-2 py-2 text-left outline-none hover:text-foreground-secondary focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] leading-[18px]">
                            {memory.content}
                          </span>
                          <span className="mt-0.5 block text-[11px] leading-4 text-foreground-secondary">
                            {memory.kind === "profile" ? "Profile" : "Journal"} ·{" "}
                            {new Date(memory.createdAt).toISOString().slice(0, 10)}
                          </span>
                        </span>
                        {newIds.has(memory.id) && (
                          <span className="rounded-full bg-[#e5f0ff] px-1.5 py-0.5 text-[10px] text-[#3062bf] dark:bg-[#1a2e55] dark:text-[#88b5ff]">
                            New
                          </span>
                        )}
                        <ChevronRight className="size-3.5 shrink-0 text-foreground-tertiary" />
                      </button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0 text-foreground-secondary opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100"
                        aria-label={`Delete memory: ${memory.content}`}
                        disabled={Boolean(state.pending)}
                        onClick={() => setTarget(memory)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-2 py-10 text-center text-[13px] text-foreground-secondary">
                  {state.data?.total
                    ? "No matching memories."
                    : state.error
                      ? "Memories are unavailable."
                      : "No saved memories yet."}
                </p>
              )}
            </div>
          )}
        </>
      )}
      {state.error && (
        <p role="alert" className="text-[12px] text-destructive">
          {state.error}
        </p>
      )}
      <div className="flex shrink-0 items-center justify-between gap-3 border-t pt-3">
        <p aria-live="polite" className="text-[12px] text-foreground-secondary">
          {state.data
            ? `${state.data.total} saved ${state.data.total === 1 ? "memory" : "memories"}`
            : ""}
          {newIds.size > 0 && <span className="ml-1">· {newIds.size} new</span>}
        </p>
        <Button
          variant="ghost"
          className="h-7 rounded-lg px-2 text-[12px] font-normal text-foreground-secondary"
          disabled={!state.data?.total || Boolean(state.pending)}
          onClick={() => setTarget("all")}
        >
          Clear memories
        </Button>
      </div>
      {state.data && state.data.total > state.data.limit && (
        <p className="text-[12px] text-foreground-secondary">
          Showing the first {state.data.limit} memories. Search filters these entries; clear removes
          all {state.data.total} saved memories.
        </p>
      )}
      <AlertDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open && !state.pending) setTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {target === "all" ? `Clear ${bot.name}’s memories?` : "Delete this memory?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {target === "all"
                ? "This removes this bot’s saved facts across its chats. Earlier messages and pending learning remain, so facts may be learned again. Shared user and project memories stay. This cannot be undone."
                : "This removes the saved fact. Earlier messages and other memories may still mention it. This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {target && target !== "all" && (
            <p className="max-h-48 overflow-y-auto break-words rounded-md bg-muted p-3 text-sm">
              {target.content}
            </p>
          )}
          {state.error && (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(state.pending)}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={Boolean(state.pending)}
              onClick={() => void confirm()}
            >
              {state.pending
                ? "Deleting…"
                : target === "all"
                  ? "Clear all memories"
                  : "Delete memory"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function BotMemoryButton({ bot, active }: { bot: BotView; active: boolean }) {
  const [open, setOpen] = useState(false);
  const updated = useSyncExternalStore(
    subscribeMemoryChanges,
    () => hasUnseenMemoryChange(bot.id),
    () => false
  );
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  useEffect(() => {
    if (open) acknowledgeMemoryChanges(bot.id);
  }, [bot.id, open, updated]);
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (next) acknowledgeMemoryChanges(bot.id);
  };
  return (
    <>
      <Button
        className="mt-3 h-9 w-full shrink-0 justify-start gap-2 rounded-[9px] px-2 text-[13px] font-normal text-foreground-secondary hover:text-foreground"
        variant="ghost"
        disabled={bot.status !== "active"}
        onClick={() => changeOpen(true)}
      >
        <Brain className="size-4" strokeWidth={1.7} />
        <span className="flex-1 text-left">Memories</span>
        {updated && (
          <span
            role="status"
            aria-label="Memories updated"
            className="size-1.5 rounded-full bg-[#3062bf] dark:bg-[#88b5ff]"
          />
        )}
        <ChevronRight className="size-3.5" />
      </Button>
      <Dialog open={open && active} onOpenChange={changeOpen}>
        <DialogContent className="flex h-[min(540px,calc(100dvh-40px))] w-[min(400px,calc(100vw-32px))] max-w-none flex-col gap-4 rounded-[14px] p-4 pt-0">
          <DialogHeader className="-mx-4 shrink-0 border-b px-5 py-4 pr-12">
            <DialogTitle className="truncate text-[14px] font-medium leading-5">
              {bot.name}’s memories
            </DialogTitle>
            <DialogDescription className="sr-only">
              Saved facts used across this bot’s chats. New memories appear here as the bot learns.
            </DialogDescription>
          </DialogHeader>
          {open && active && <BotMemoryPanel key={bot.id} bot={bot} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
