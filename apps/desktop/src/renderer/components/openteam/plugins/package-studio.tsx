import { createPluginTemplate, type PluginTemplateMode } from "@openteam/plugin-sdk/templates";
import type { PluginDraftView, PluginManagementView } from "@openteam/contracts/plugin-management";
import { pluginIconUrl } from "@openteam/plugin-sdk";
import { PluginMark } from "./plugin-mark";
import { useRef, useState } from "react";
import { api } from "../../../client/openteam-api";
import {
  downloadPlugin,
  inputClass,
  PluginButton,
  PluginField,
  usePluginOperation,
} from "./plugin-ui";

export function PackageStudio({
  data,
  refresh,
}: {
  data: PluginManagementView;
  refresh: () => Promise<unknown>;
}) {
  const [mode, setMode] = useState<PluginTemplateMode>("skills");
  const [selected, setSelected] = useState<PluginDraftView | null>(null);
  const [source, setSource] = useState("");
  const [text, setText] = useState("");
  const [removeArmed, setRemoveArmed] = useState(false);
  const archive = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const operation = usePluginOperation(refresh);
  const select = (draft: PluginDraftView) => {
    setSelected(draft);
    setText(JSON.stringify(draft.definition, null, 2));
    setRemoveArmed(false);
  };
  const upload = async (files: FileList | null, directory: boolean) => {
    if (!files?.length) return;
    await operation.run(async () => {
      if (!directory && files[0]!.name.endsWith(".zip"))
        select(await api.importPluginArchive(new Uint8Array(await files[0]!.arrayBuffer())));
      else {
        const entries: Record<string, Uint8Array> = {};
        for (const file of Array.from(files)) {
          const path = directory
            ? file.webkitRelativePath.split("/").slice(1).join("/")
            : file.name;
          if (path.split("/").some((part) => ["node_modules", ".git", ".DS_Store"].includes(part)))
            continue;
          entries[path] = new Uint8Array(await file.arrayBuffer());
        }
        const { archivePackageFiles } = await import("@openteam/plugin-sdk/archive");
        select(await api.importPluginArchive(archivePackageFiles(entries)));
      }
    }, "Package loaded and validated.");
  };
  return (
    <div className="grid gap-5">
      {operation.feedback}
      <div>
        <h3 className="text-lg font-medium">Develop plugins</h3>
        <p className="mt-1 text-sm text-foreground-secondary">
          Load a package, preview its setup, test an installation, and export a bundle for others.
          Drafts and installed packages are separate.
        </p>
      </div>
      <PluginField label="Plugin type">
        <select
          aria-label="Plugin type"
          className={inputClass}
          value={mode}
          onChange={(event) => setMode(event.target.value as PluginTemplateMode)}
        >
          <option value="skills">Skills</option>
          <option value="remote-mcp">Remote MCP</option>
          <option value="packaged-mcp">Packaged MCP</option>
          <option value="hybrid">Hybrid skills + packaged MCP</option>
        </select>
      </PluginField>
      <div className="flex flex-wrap gap-2">
        <PluginButton
          disabled={operation.busy}
          onClick={() =>
            void operation.run(async () =>
              select(
                await api.importPluginFiles({
                  "plugin.json": JSON.stringify(
                    createPluginTemplate(mode, `my-plugin-${Date.now().toString(36)}`)
                  ),
                })
              )
            )
          }
        >
          Create plugin
        </PluginButton>
        <PluginButton disabled={operation.busy} onClick={() => folder.current?.click()}>
          Load / reload folder
        </PluginButton>
        <PluginButton disabled={operation.busy} onClick={() => archive.current?.click()}>
          Import ZIP or manifest
        </PluginButton>
      </div>
      <input
        hidden
        ref={archive}
        type="file"
        accept=".zip,.json"
        onChange={(event) => {
          void upload(event.target.files, false);
          event.target.value = "";
        }}
      />
      <input
        hidden
        ref={folder}
        type="file"
        multiple
        {...{ webkitdirectory: "" }}
        onChange={(event) => {
          void upload(event.target.files, true);
          event.target.value = "";
        }}
      />
      <PluginField label="Repository, release ZIP, or manifest URL">
        <div className="flex gap-2">
          <input
            className={inputClass}
            placeholder="https://github.com/owner/plugin"
            value={source}
            onChange={(event) => setSource(event.target.value)}
          />
          <PluginButton
            disabled={operation.busy || !source}
            onClick={() =>
              void operation.run(
                async () => select(await api.importPluginUrl(source)),
                "Package fetched and validated."
              )
            }
          >
            Load URL
          </PluginButton>
        </div>
      </PluginField>
      <div className="flex flex-wrap gap-2">
        {data.drafts.map((draft) => (
          <PluginButton
            key={draft.id}
            primary={selected?.id === draft.id}
            onClick={() => select(draft)}
          >
            <span className="flex items-center gap-2">
              <PluginMark name={draft.name} logoUrl={pluginIconUrl(draft.definition)} size="xs" />
              {draft.name}
            </span>
          </PluginButton>
        ))}
      </div>
      {selected && (
        <>
          <div className="rounded-xl bg-black/5 p-4 dark:bg-white/5">
            <div className="flex items-center gap-3">
              <PluginMark
                name={selected.definition.name}
                logoUrl={pluginIconUrl(selected.definition)}
              />
              <p className="font-medium">
                {selected.definition.name} · {selected.definition.version}
              </p>
            </div>
            <p className="mt-1 text-sm">
              {selected.definition.connections.length} connectors ·{" "}
              {selected.definition.skills.length} skills
            </p>
            {selected.warnings.map((warning) => (
              <p className="mt-2 text-sm text-amber-700 dark:text-amber-300" key={warning}>
                {warning}
              </p>
            ))}
            {selected.definition.connections.map((connection) => (
              <div key={connection.key} className="mt-3 text-sm">
                <strong>{connection.name}</strong> · {connection.transport} · {connection.auth}
                <p className="text-foreground-secondary">
                  {connection.setup?.description ??
                    "Users configure and connect this connector from Installed plugins."}
                </p>
              </div>
            ))}
          </div>
          <PluginField
            label="Package definition"
            help="Edit metadata, connectors, setup fields, skills, and supporting files. Save validates the package without changing an installed version."
          >
            <textarea
              aria-label="Package definition"
              spellCheck={false}
              className={`${inputClass} min-h-80 font-mono text-xs`}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </PluginField>
          <div className="flex flex-wrap gap-2">
            <PluginButton
              disabled={operation.busy}
              primary
              onClick={() =>
                void operation.run(
                  async () => select(await api.savePluginDraft(selected.id, JSON.parse(text))),
                  "Valid package. Changes saved."
                )
              }
            >
              Validate and save
            </PluginButton>
            <PluginButton
              disabled={operation.busy}
              onClick={() =>
                void operation.run(
                  () => api.installPluginDraft(selected.id),
                  "Installed. Open Installed to configure its accounts and test its connections."
                )
              }
            >
              Install for testing
            </PluginButton>
            <PluginButton
              disabled={operation.busy}
              onClick={() =>
                void operation.run(() => downloadPlugin(selected.id, true), "Package exported.")
              }
            >
              Export ZIP
            </PluginButton>
            <PluginButton
              disabled={operation.busy}
              onClick={() =>
                removeArmed
                  ? void operation.run(async () => {
                      await api.deletePluginDraft(selected.id);
                      setSelected(null);
                    })
                  : setRemoveArmed(true)
              }
            >
              {removeArmed ? "Confirm delete draft" : "Delete draft"}
            </PluginButton>
          </div>
        </>
      )}
      <aside className="border-t border-black/10 pt-4 text-sm text-foreground-secondary dark:border-white/10">
        <p>
          Contributions belong in <code>packages/plugins/&lt;plugin-name&gt;/</code>. Most plugins
          need only a manifest and skill files. A connector implementation can keep its dependencies
          inside its own package.
        </p>
        <p className="mt-2">
          Export the validated bundle, add its files using GitHub’s web editor, and open a pull
          request. Include setup instructions and the connection tests you ran. Saved account
          credentials are never added to an exported installation.
        </p>
      </aside>
    </div>
  );
}
