import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Button } from "../../src/renderer/components/ui/button";
import { ButtonPrimitive } from "../../src/renderer/components/ui/button-primitive";
import { preloadLoadingOrb } from "../../src/renderer/components/ui/loading-orb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../src/renderer/components/ui/dropdown-menu";
import { PluginButton } from "../../src/renderer/components/openteam/plugins/plugin-ui";
import "../../src/renderer/styles.css";
import "../../src/renderer/components/openteam/external-draft-card.css";

await preloadLoadingOrb();

function Fixture() {
  const [loading, setLoading] = useState(false);
  const [label, setLabel] = useState("Copy");
  const [mounted, setMounted] = useState(true);
  const [tick, setTick] = useState(0);
  const [submissions, setSubmissions] = useState(0);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    Object.assign(window, {
      buttonMotionQA: {
        loading: (value: boolean) => flushSync(() => setLoading(value)),
        label: (value: string) => flushSync(() => setLabel(value)),
        mounted: (value: boolean) => flushSync(() => setMounted(value)),
        tick: () => flushSync(() => setTick((value) => value + 1)),
        ref: () => ref.current instanceof HTMLButtonElement,
      },
    });
  }, []);
  return (
    <main className="grid gap-6 p-8" data-tick={tick}>
      <div className="draft-card">
        <div className="draft-actions">
          {mounted && (
            <ButtonPrimitive
              data-testid="send"
              className="draft-button draft-button-primary"
              data-sending={loading ? "" : undefined}
              loading={loading}
              loadingLabel="Sending…"
              ref={ref}
            >
              Send
            </ButtonPrimitive>
          )}
          <ButtonPrimitive data-testid="sibling" className="draft-button draft-button-secondary">
            Discard
          </ButtonPrimitive>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button data-testid="shared" loading={loading} loadingLabel="Saving…" variant="secondary">
          Save
        </Button>
        <section aria-label="Plugin action">
          <PluginButton loading={loading} onClick={() => undefined} primary>
            Add
          </PluginButton>
        </section>
        <ButtonPrimitive data-testid="label" className="rounded-lg border px-3 py-2">
          {label}
        </ButtonPrimitive>
      </div>
      <Button data-testid="full" className="w-full" loading={loading}>
        Full width
      </Button>
      <Button data-testid="fixed" style={{ width: 140 }} loading={loading}>
        Fixed width
      </Button>
      <Button
        data-testid="icon"
        aria-label="Icon action"
        size="icon"
        loading={loading}
        loadingSize={16}
      >
        {!loading && "+"}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <ButtonPrimitive className="justify-self-start rounded-lg border px-3 py-2">
            Actions
          </ButtonPrimitive>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            data-testid="menu"
            loading={loading}
            onSelect={(event) => event.preventDefault()}
          >
            Connect
          </DropdownMenuItem>
          <DropdownMenuItem>Settings</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setSubmissions((value) => value + 1);
        }}
      >
        <ButtonPrimitive className="rounded-lg border px-3 py-2" type="submit">
          Submit
        </ButtonPrimitive>
        <output aria-label="Submissions">{submissions}</output>
      </form>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>
);
