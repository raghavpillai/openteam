import { CircleHelp, Info, LogOut, Megaphone, Settings, Smartphone } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { signOut } from "../../../client/auth";
import { useAuthSession } from "../../../hooks/use-auth-session";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { Textarea } from "../../ui/textarea";

export function AccountMenu({
  children,
  compact = false,
  onOpenAbout,
  onOpenSettings,
}: {
  children: ReactNode;
  compact?: boolean;
  onOpenAbout: () => void;
  onOpenSettings: () => void;
}) {
  const auth = useAuthSession();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [includeConversationId, setIncludeConversationId] = useState(false);
  const [wantsFeedbackResponse, setWantsFeedbackResponse] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [update, setUpdate] = useState<OpenTeamUpdateStatus | null>(null);
  useEffect(() => window.openteam?.updates.onClientProgress(setUpdate), []);
  const openExternal = (url: string) => window.open(url, "_blank", "noopener,noreferrer");
  const submitFeedback = () => {
    const body = feedback.trim();
    if (!body) return;
    const selectedConversationId = includeConversationId
      ? document.querySelector<HTMLElement>('[data-channel-id][data-selected="true"]')?.dataset
          .channelId
      : undefined;
    const url = new URL("https://github.com/raghavpillai/openteam/issues/new");
    url.searchParams.set("title", "OpenTeam feedback");
    url.searchParams.set(
      "body",
      [
        body,
        selectedConversationId ? `Conversation ID: ${selectedConversationId}` : null,
        wantsFeedbackResponse ? "Response requested: yes" : null,
      ]
        .filter(Boolean)
        .join("\n\n")
    );
    openExternal(url.toString());
    setFeedback("");
    setIncludeConversationId(false);
    setWantsFeedbackResponse(false);
    setFeedbackOpen(false);
  };
  const updateBusy = ["downloading", "installing"].includes(update?.status ?? "");
  const updateLabel =
    update?.status === "downloaded"
      ? "Restart to update"
      : update?.status === "downloading"
        ? `${Math.round(update.progress ?? 0)}%`
        : update?.status === "installing"
          ? "Restarting…"
          : "Install";

  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) return;
          void window.openteam?.updates.status().then((value) => {
            setUpdate(value);
            if (value.status === "idle") void window.openteam?.updates.check().then(setUpdate);
          });
        }}
      >
        <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
        <DropdownMenuContent
          align={compact ? "end" : "start"}
          aria-label="Account"
          className="w-[236px]"
          side={compact ? "right" : "top"}
          sideOffset={8}
        >
          {["available", "downloading", "downloaded", "installing"].includes(
            update?.status ?? ""
          ) ? (
            <div className="mb-1 flex items-center gap-2 rounded-md bg-accent-soft px-2 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
                Update available
              </span>
              <Button
                disabled={updateBusy}
                onClick={() =>
                  void (update?.status === "downloaded"
                    ? window.openteam?.updates.installClient()
                    : window.openteam?.updates.openDownload())
                }
                size="xs"
                variant="accent"
              >
                {updateLabel}
              </Button>
            </div>
          ) : null}
          <DropdownMenuItem
            onSelect={() =>
              openExternal("https://github.com/raghavpillai/openteam/tree/main/apps/mobile")
            }
          >
            <Smartphone /> Get the iPhone app
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpenSettings}>
            <Settings /> Settings
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpenAbout}>
            <Info /> About OpenTeam
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => openExternal("https://github.com/raghavpillai/openteam#readme")}
          >
            <CircleHelp /> Help and docs
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setFeedbackOpen(true)}>
            <Megaphone /> Send feedback
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setSignOutOpen(true)}>
            <LogOut /> Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog onOpenChange={setFeedbackOpen} open={feedbackOpen}>
        <DialogContent className="w-[460px] gap-0 p-0" showCloseButton={false}>
          <div className="px-5 pb-3 pt-5">
            <DialogTitle>Send feedback</DialogTitle>
            <DialogDescription className="mt-1.5">
              Tell us what happened or what you'd change. This opens a GitHub issue with your notes,
              so you can review it before posting.
            </DialogDescription>
          </div>
          <div className="px-5 pb-4">
            <Textarea
              autoFocus
              className="h-[132px] resize-none"
              maxLength={8_000}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder="What happened? What did you expect instead?"
              value={feedback}
            />
            <div className="mt-3 flex flex-col gap-2.5">
              <label className="flex items-center gap-2 text-[13px] text-ink">
                <Checkbox
                  checked={includeConversationId}
                  onCheckedChange={(value) => setIncludeConversationId(value === true)}
                />
                Include the current conversation ID
              </label>
              <label className="flex items-center gap-2 text-[13px] text-ink">
                <Checkbox
                  checked={wantsFeedbackResponse}
                  onCheckedChange={(value) => setWantsFeedbackResponse(value === true)}
                />
                I'd like a reply
              </label>
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
            <Button onClick={() => setFeedbackOpen(false)} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button disabled={!feedback.trim()} onClick={submitFeedback} size="sm">
              Open GitHub issue
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog onOpenChange={setSignOutOpen} open={signOutOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {auth.mode === "required" ? "Sign out?" : "Sign-in is turned off"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {auth.mode === "required"
                ? "You can sign back in with your username and password. Your bots and chats stay on the server."
                : "This server runs without accounts, so there is nothing to sign out of."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setSignOutOpen(false);
                if (auth.mode === "required") void signOut();
              }}
            >
              {auth.mode === "required" ? "Sign out" : "OK"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
