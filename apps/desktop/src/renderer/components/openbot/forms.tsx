import type { BotView, CreateBotInput } from "@openbot/contracts";
import { ChevronDown, LoaderCircle } from "lucide-react";
import { type FormEvent, useCallback, useState } from "react";
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
      setError(cause instanceof Error ? cause.message : String(cause));
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
          It gets one durable Pi session backed by OpenAI Codex, persistent chat, and its own Linux
          screen on the shared computer.
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
  onCancel,
  onSubmit,
}: {
  bots: BotView[];
  onCancel: () => void;
  onSubmit: (name: string, botIds: string[]) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const toggle = useCallback((id: string) => {
    setSelected((current) =>
      current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id]
    );
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || selected.length < 2 || busy) return;
    setBusy(true);
    try {
      await onSubmit(name.trim(), selected);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="grid gap-5" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>New channel</DialogTitle>
        <DialogDescription>
          Create a shared project room and choose at least two bots.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor="group-name">Name</Label>
        <Input
          id="group-name"
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          placeholder="Ex: Project Falcon"
          value={name}
        />
      </div>
      <div className="grid gap-2">
        <Label>Add bots</Label>
        <div className="max-h-72 space-y-1 overflow-auto rounded-xl border p-2">
          {bots.map((bot) => {
            const checked = selected.includes(bot.id);
            const checkboxId = `group-bot-${bot.id}`;
            return (
              <div
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent"
                key={bot.id}
              >
                <Checkbox
                  checked={checked}
                  id={checkboxId}
                  onCheckedChange={() => toggle(bot.id)}
                />
                <Label
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-3"
                  htmlFor={checkboxId}
                >
                  <BotAvatar bot={bot} size="sm" />
                  <span className="truncate text-sm font-medium">{bot.name}</span>
                </Label>
              </div>
            );
          })}
        </div>
      </div>
      <DialogFooter>
        <Button onClick={onCancel} type="button" variant="ghost">
          Cancel
        </Button>
        <Button disabled={!name.trim() || selected.length < 2 || busy} type="submit">
          {busy && <LoaderCircle className="size-4 animate-spin" />}
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}
