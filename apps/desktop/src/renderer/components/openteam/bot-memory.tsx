import type { BotMemoryEntry, BotView } from "@openteam/contracts";
import { Brain, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../client/openteam-api";
import { subscribeMemoryRefresh } from "../../lib/memory-events";
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
  const controller = useRef<ReturnType<typeof createMemoryView> | null>(null);
  useEffect(() => {
    const view = createMemoryView({
      load: () => api.botMemories(bot.id),
      remove: (id) => (id ? api.deleteBotMemory(bot.id, id) : api.clearBotMemories(bot.id)),
      change: setState,
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
  return (
    <div className="flex min-h-64 flex-col gap-3">
      <div className="flex gap-2">
        <Input
          aria-label="Search memories"
          placeholder="Search saved memories"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          aria-label="Refresh memories"
          variant="outline"
          size="icon"
          disabled={Boolean(state.pending)}
          onClick={() => void controller.current?.refresh()}
        >
          <RefreshCw className="size-4" />
        </Button>
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      {state.loading ? (
        <div role="status" className="grid flex-1 place-items-center py-12">
          <LoaderCircle aria-label="Loading memories" className="size-5 animate-spin" />
        </div>
      ) : (
        <div className="max-h-[50vh] overflow-y-auto rounded-lg border">
          {filtered.length ? (
            <ul className="divide-y">
              {filtered.map((memory) => (
                <li key={memory.id} className="flex gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-wrap break-words text-sm leading-6">
                      {memory.content}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {memory.kind === "profile" ? "Profile" : "Journal"} ·{" "}
                      {new Date(memory.createdAt).toISOString().slice(0, 10)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete memory: ${memory.content}`}
                    disabled={Boolean(state.pending)}
                    onClick={() => setTarget(memory)}
                  >
                    <Trash2 className="size-4 text-muted-foreground" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              {state.data?.total
                ? "No matching memories."
                : state.error
                  ? "Memories are unavailable."
                  : "No saved memories yet."}
            </p>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {state.data
            ? `${state.data.total} saved ${state.data.total === 1 ? "memory" : "memories"}`
            : ""}
        </p>
        <Button
          variant="outline"
          disabled={!state.data?.total || Boolean(state.pending)}
          onClick={() => setTarget("all")}
        >
          Clear memories
        </Button>
      </div>
      {state.data && state.data.total > state.data.limit && (
        <p className="text-xs text-muted-foreground">
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
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  return (
    <>
      <Button
        className="mt-4 w-full justify-start gap-2"
        variant="outline"
        disabled={bot.status !== "active"}
        onClick={() => setOpen(true)}
      >
        <Brain className="size-4" />
        Memories
      </Button>
      <Dialog open={open && active} onOpenChange={setOpen}>
        <DialogContent className="max-w-[620px]">
          <DialogHeader>
            <DialogTitle>{bot.name}’s memories</DialogTitle>
            <DialogDescription>
              Saved facts used across this bot’s chats. New memories appear here as the bot learns.
            </DialogDescription>
          </DialogHeader>
          {open && active && <BotMemoryPanel key={bot.id} bot={bot} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
