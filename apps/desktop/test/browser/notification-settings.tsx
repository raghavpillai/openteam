import { useState } from "react";
import { createRoot } from "react-dom/client";
import { NotificationSettings } from "../../src/renderer/components/openteam/settings/notifications";
import { SettingsHeading } from "../../src/renderer/components/openteam/settings/ui";
import "../../src/renderer/styles.css";

const fixture = { enableCalls: 0, setPermission: (_permission: "allowed" | "blocked") => {} };
Object.assign(window, { notificationSettingsFixture: fixture });

function Preview({ initialPermission }: { initialPermission: "allowed" | "blocked" }) {
  const [permission, setPermission] = useState(initialPermission);
  if (initialPermission === "blocked") fixture.setPermission = setPermission;

  return (
    <section
      aria-label={`${initialPermission} preview`}
      className="rounded-[16px] border border-black/[0.07] bg-background px-8 py-7 shadow-[0_4px_20px_rgba(0,0,0,0.04)] dark:border-white/[0.08]"
    >
      <SettingsHeading>General</SettingsHeading>
      <NotificationSettings
        permission={permission}
        onEnable={() => { fixture.enableCalls += 1; }}
      />
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto grid max-w-[700px] gap-5 p-6">
    <Preview initialPermission="blocked" />
    <Preview initialPermission="allowed" />
  </main>
);
