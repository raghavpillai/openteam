import type { BotView, CreateBotInput } from "@openteam/contracts";
import { clientErrorMessage } from "@openteam/product-core/redaction";
import { GROUP_MEMBER_LIMIT, toggleBoundedSelection } from "@openteam/product-core/selection";
import { ChevronDown, LoaderCircle, Search } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualWindow } from "../../hooks/use-virtual-window";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { BotAvatar } from "./avatar";

const COLORS = ["#ff7a1a", "#2f8cff", "#8b5cf6", "#14b8a6", "#ec4899", "#22c55e"];

export function NewBotForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (value: CreateBotInput) => Promise<void>;
}) {
  const [clientRequestId] = useState(() => crypto.randomUUID());
  const [name, setName] = useState("New Bot");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [customize, setCustomize] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const color =
    COLORS[Number.parseInt(clientRequestId.replaceAll("-", "").slice(0, 8), 16) % COLORS.length]!;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        clientRequestId,
        name: name.trim() || "New Bot",
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        color,
      });
    } catch (cause) {
      setError(clientErrorMessage(cause, "OpenTeam could not create this Bot"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="grid gap-5" onSubmit={submit}>
      <DialogHeader className="items-center text-center">
        <BotAvatar bot={{ color, icon: "●" }} size="lg" />
        <DialogTitle className="pt-1">Create a new Bot</DialogTitle>
        <DialogDescription className="max-w-sm text-center">
          It gets one durable Pi session with the selected inference provider, persistent chat, and
          its own Linux screen on the shared computer.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor="new-bot-name">Name</Label>
        <Input
          id="new-bot-name"
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
      </div>
      <Button
        aria-expanded={customize}
        className="justify-between"
        onClick={() => setCustomize((value) => !value)}
        type="button"
        variant="ghost"
      >
        Customize first
        <ChevronDown className={`size-4 transition-transform ${customize ? "rotate-180" : ""}`} />
      </Button>
      {customize && (
        <div className="grid gap-4 rounded-xl border bg-muted/20 p-4">
          <div className="grid gap-2">
            <Label htmlFor="new-bot-title">Title</Label>
            <Input
              id="new-bot-title"
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Describe what your Bot does"
              value={title}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-bot-description">Description</Label>
            <Textarea
              id="new-bot-description"
              maxLength={2_000}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What this Bot is for"
              value={description}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-bot-instructions">Durable instructions</Label>
            <Textarea
              id="new-bot-instructions"
              maxLength={20_000}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="Optional standing instructions"
              value={instructions}
            />
          </div>
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button onClick={onCancel} type="button" variant="ghost">
          Cancel
        </Button>
        <Button disabled={busy} type="submit">
          {busy && <LoaderCircle className="size-4 animate-spin" />}
          Create New Bot
        </Button>
      </DialogFooter>
    </form>
  );
}

export function BotForm({
  initial,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  initial?: BotView;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (value: {
    name: string;
    instructions: string;
    icon: string;
    color: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [icon, setIcon] = useState(initial?.icon ?? "●");
  const [color, setColor] = useState(initial?.color ?? "#4f7cff");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit({ name: name.trim(), instructions, icon, color });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="grid gap-5" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>{initial ? "Bot settings" : "New bot"}</DialogTitle>
        <DialogDescription>
          {initial
            ? "Update this bot's identity and durable instructions."
            : "Create a durable Pi agent with its own session and Linux screen."}
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor="bot-name">Name</Label>
        <Input
          id="bot-name"
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
      </div>
      <div className="grid grid-cols-[1fr_112px] gap-3">
        <div className="grid gap-2">
          <Label htmlFor="bot-icon">Icon</Label>
          <Input
            id="bot-icon"
            maxLength={16}
            onChange={(event) => setIcon(event.target.value)}
            value={icon}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="bot-color">Color</Label>
          <Input
            className="p-1"
            id="bot-color"
            onChange={(event) => setColor(event.target.value)}
            type="color"
            value={color}
          />
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="bot-instructions">Instructions</Label>
        <Textarea
          id="bot-instructions"
          className="min-h-32 resize-y"
          maxLength={20_000}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder="What should this bot own?"
          value={instructions}
        />
      </div>
      <DialogFooter>
        <Button onClick={onCancel} type="button" variant="ghost">
          Cancel
        </Button>
        <Button disabled={!name.trim() || busy} type="submit">
          {busy && <LoaderCircle className="size-4 animate-spin" />}
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function GroupForm({
  bots,
  onSubmit,
}: {
  bots: BotView[];
  onSubmit: (name: string, botIds: string[]) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const botListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => nameRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const filteredBots = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? bots.filter((bot) => bot.name.toLowerCase().includes(normalized)) : bots;
  }, [bots, query]);
  const toggle = useCallback((id: string) => {
    setSelected((current) => [...toggleBoundedSelection(current, id, { max: GROUP_MEMBER_LIMIT })]);
  }, []);
  const estimateBotSize = useCallback(() => 40, []);
  const botKey = useCallback(
    (index: number) => filteredBots[index]?.id ?? `missing:${index}`,
    [filteredBots]
  );
  const { measureElement, totalSize, virtualItems } = useVirtualWindow({
    count: filteredBots.length,
    estimateSize: estimateBotSize,
    getKey: botKey,
    initialViewportSize: 280,
    maxItems: 24,
    overscan: 160,
    scrollRef: botListRef,
  });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || selected.length < 1 || selected.length > GROUP_MEMBER_LIMIT || busy) return;
    setBusy(true);
    try {
      await onSubmit(name.trim(), selected);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit}>
      <DialogHeader className="border-b px-5 py-4">
        <DialogTitle className="text-[15px] font-semibold">New channel</DialogTitle>
        <DialogDescription className="sr-only">
          Name a shared project room and choose one to six bots.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-3 px-5 py-5">
        <div className="grid gap-2">
          <Label className="text-[12px] font-normal text-muted-foreground" htmlFor="group-name">
            Name
          </Label>
          <Input
            className="h-9 rounded-[7px]"
            id="group-name"
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ex: Project Falcon"
            ref={nameRef}
            value={name}
          />
        </div>
        <div className="grid gap-2">
          <Label className="text-[12px] font-normal text-muted-foreground">Add Bots</Label>
          <div className="overflow-hidden rounded-[9px] border border-input">
            <div className="relative border-b">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Search bots"
                className="h-10 rounded-none border-0 bg-transparent pl-9 shadow-none focus-visible:border-0 focus-visible:ring-0"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search"
                value={query}
              />
            </div>
            <div
              className="bot-scrollbar max-h-[280px] min-h-44 overflow-y-auto py-1.5"
              ref={botListRef}
              role="list"
            >
              <div className="relative w-full" style={{ height: totalSize }}>
                {virtualItems.map((virtualItem) => {
                  const bot = filteredBots[virtualItem.index];
                  if (!bot) return null;
                  const checked = selected.includes(bot.id);
                  const checkboxId = `group-bot-${bot.id}`;
                  return (
                    <div
                      aria-posinset={virtualItem.index + 1}
                      aria-setsize={filteredBots.length}
                      className="absolute inset-x-0 top-0 flex h-10 w-full items-center gap-2.5 px-3 transition-colors hover:bg-accent"
                      key={bot.id}
                      ref={(node) => measureElement(virtualItem.index, virtualItem.key, node)}
                      role="listitem"
                      style={{ transform: `translateY(${virtualItem.start}px)` }}
                    >
                      <Checkbox
                        checked={checked}
                        disabled={!checked && selected.length >= GROUP_MEMBER_LIMIT}
                        id={checkboxId}
                        onCheckedChange={() => toggle(bot.id)}
                      />
                      <Label
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5"
                        htmlFor={checkboxId}
                      >
                        <BotAvatar bot={bot} size="sm" />
                        <span className="truncate text-[13px] font-medium">{bot.name}</span>
                      </Label>
                    </div>
                  );
                })}
              </div>
              {filteredBots.length === 0 && (
                <div className="grid min-h-32 place-items-center px-4 text-[12px] text-muted-foreground">
                  No bots found
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <DialogFooter className="border-t px-4 py-3">
        <Button
          className="min-w-[78px]"
          disabled={
            !name.trim() || selected.length < 1 || selected.length > GROUP_MEMBER_LIMIT || busy
          }
          type="submit"
        >
          {busy && <LoaderCircle className="size-4 animate-spin" />}
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}
