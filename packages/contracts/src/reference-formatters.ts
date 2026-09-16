// @ts-nocheck
// Pure formatters from the captured reference; no executable tool or host dependencies.
function formatBytes2(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}
function describeUploadFileOutcome(outcome, request3) {
  switch (outcome.kind) {
    case "uploaded": {
      const lines2 = [
        `Uploaded ${request3.sourcePath} to ${request3.connection} as "${outcome.name}" (${formatBytes2(outcome.sizeBytes)}, ${outcome.mimeType}).`,
        `id: ${outcome.id}`
      ];
      if (outcome.webUrl !== void 0) lines2.push(`link: ${outcome.webUrl}`);
      lines2.push(
        "Share the link with the user if they need it; the file's bytes were sent directly and are not in this conversation."
      );
      return lines2.join("\n");
    }
    case "needs_auth":
      return `The ${request3.connection} connection is installed but not signed in, so nothing was uploaded. Ask the user to connect ${request3.connection} again (AuthenticateMcpServer can start that), then retry.`;
    case "unknown_connection":
      return outcome.available.length === 0 ? "No connected service can receive files this turn, so nothing was uploaded. Tell the user which service you need connected." : `${JSON.stringify(request3.connection)} is not a connection that can receive files. Use one of: ${outcome.available.join(", ")}.`;
    case "source_missing":
      return `Nothing was uploaded: ${request3.sourcePath} does not exist on your computer or is not a regular file. Check the path with Shell (ls -l) and retry.`;
    case "source_refused":
      return `Nothing was uploaded: upload_file only sends files under ${outcome.allowedRoots.join(" or ")}. Copy or save the file under one of those directories first, then retry with that path.`;
    case "too_large":
      return `Nothing was uploaded: ${request3.sourcePath} is over the ${formatBytes2(outcome.maxBytes)} limit for upload_file. Compress or split it, or tell the user it is too large to send this way.`;
    case "invalid_destination":
      return `Nothing was uploaded: ${outcome.message}`;
    case "rejected":
      return `${request3.connection} refused the upload: ${outcome.message} Nothing was uploaded.`;
    case "unavailable":
      return `${outcome.message} Nothing was uploaded; try again in a moment or tell the user.`;
  }
}
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}
function describeDownloadFileOutcome(outcome, request3) {
  const source = request3.source.fileId !== void 0 ? `file ${request3.source.fileId}` : JSON.stringify(request3.source.path ?? "");
  switch (outcome.kind) {
    case "downloaded": {
      const lines2 = [
        `Downloaded ${source} from ${request3.connection} to ${outcome.boxPath} (${formatBytes(outcome.sizeBytes)}, ${outcome.mimeType}).`,
        `name: ${outcome.name}`,
        `id: ${outcome.id}`
      ];
      if (outcome.webUrl !== void 0) lines2.push(`link: ${outcome.webUrl}`);
      lines2.push(
        "The file is on your computer now; open it with Shell or the file tools. Its bytes are not in this conversation."
      );
      return lines2.join("\n");
    }
    case "needs_auth":
      return `The ${request3.connection} connection is installed but not signed in, so nothing was downloaded. Ask the user to connect ${request3.connection} again (AuthenticateMcpServer can start that), then retry.`;
    case "unknown_connection":
      return outcome.available.length === 0 ? "No connected service can serve files this turn, so nothing was downloaded. Tell the user which service you need connected." : `${JSON.stringify(request3.connection)} is not a connection that can serve files. Use one of: ${outcome.available.join(", ")}.`;
    case "destination_refused":
      return `Nothing was downloaded: download_file only writes under ${outcome.allowedRoots.join(" or ")}. Pass a destination.path under one of those directories, or omit it to use your downloads folder.`;
    case "not_found":
      return `Nothing was downloaded: ${outcome.message}`;
    case "too_large":
      return `Nothing was downloaded: ${source} on ${request3.connection} is over the ${formatBytes(outcome.maxBytes)} limit for download_file. Tell the user it is too large to fetch this way.`;
    case "rejected":
      return `${request3.connection} refused the download: ${outcome.message} Nothing was downloaded.`;
    case "unavailable":
      return `${outcome.message} Nothing was downloaded; try again in a moment or tell the user.`;
  }
}
function renderCredentialProviderStatus(status) {
  switch (status.kind) {
    case "not-connected":
      return "Credential provider status: not connected. Saved item count: 0.";
    case "connected":
      return `Credential provider status: connected. Connections: ${status.connectionCount}. Saved item count: ${status.itemCount}. Connections needing renewal or attention: ${status.connectionsNeedingAttention}. This is metadata only; credential values are never returned.`;
  }
}
function credentialSiteHost(raw) {
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    return raw;
  }
}
function describeCredential(view) {
  const siteHosts = [...new Set(view.sites.map(credentialSiteHost))];
  const sites = siteHosts.length > 0 ? ` \xB7 ${siteHosts.slice(0, 2).join(", ")}` : "";
  const browser = ` \xB7 browser login${view.siteMatch != null ? ` ${view.siteMatch} match` : ""}`;
  return `- "${view.title}" (${view.category}${sites}${browser} \xB7 Auto fill ${view.autoFill ? "on" : "off"}) \u2014 credential_id: ${view.credentialId} \xB7 connection_id: ${view.connectionId} \xB7 catalog_revision: ${view.catalogRevision}`;
}
const AUTO_FILL_ON_GUIDANCE = "Auto fill is on for this login, so no approval card is needed: OpenTeam fills it on its own as soon as that sign-in page is the focused page in the box browser. Do not send a credential-request for it. Have the subagent bring the page to the front, wait a moment, and re-check, then continue from whatever the page shows; send a credential-request only if the login fields are still empty after that.";
const AUTO_FILL_RULE = "Auto fill on means OpenTeam fills that login on its own, with no approval card, once its sign-in page is the focused page in the box browser and it is the only saved login matching that page. Auto fill off means the user approves each fill through a credential-request.";
const CREDENTIAL_REQUEST_GUIDANCE = 'For a website Login/Password item with Auto fill off (or one that did not fill on its own), send {"type":"credential-request","credential":{"kind":"browser-login","credential_id":"\u2026","connection_id":"\u2026","catalog_revision":"\u2026","site":"https://current.example/login","purpose":"sign in to continue the requested task"}}. Use the URL computerUse reports, never one of the saved item URLs above. OpenTeam treats `site` as a hint, selects an actual open page allowed by the item\'s target rules, binds approval to that live origin, then re-checks and fills that same host. You never receive either value, and you never ask the user to type or paste a password. Continue with computerUse to submit; use request_box_help only for a remaining SSO, passkey, 2FA, captcha, or payment step.';
const COOKIE_ORIGIN_APPROVAL_FAILURE_BY_STAGE = {
  enumerate: "the desktop failed while listing Chrome cookies, so nothing could be selected",
  collect: "the desktop failed while collecting the granted cookies",
  inject: "the box failed while injecting them into its browser"
};
function describeCookieOriginRequestEntry(entry) {
  return entry.profileId === null ? entry.origin : `${entry.origin} (${entry.profileId})`;
}
function describeGrants(grants) {
  if (grants.length === 0) return "no origins";
  return grants.map((grant) => `${grant.origin} on ${grant.profileId}`).join(", ");
}
function formatCookieOriginApprovalOutcome(outcome) {
  if (outcome.kind === "listed") {
    if (outcome.items.length === 0) {
      return "No Chrome cookie origins are available to request.";
    }
    return [
      "Available Chrome cookie origins:",
      ...outcome.items.map(
        (item) => `- ${item.origin} \u2014 profileId: ${JSON.stringify(item.profileId)} (display name: ${JSON.stringify(item.profileDisplayName)})`
      )
    ].join("\n");
  }
  if (outcome.kind === "refused") {
    if (outcome.reason === "denied") {
      return `${outcome.message} Do not retry unless they ask.`;
    }
    return outcome.message;
  }
  if (outcome.kind === "failed") {
    if (outcome.injected > 0) return `The user chose ${outcome.decision} for ${describeGrants(outcome.grants)}. Injected ${outcome.injected} cookie(s), but injection stopped before ${outcome.failed} remaining cookie(s). Some logins may already be active. Do not retry unless the user asks.`;
    if (outcome.errorClass === "ChromeCookieImportPermissionError" || outcome.errorClass === "ChromeSafeStoragePermissionError") {
      return `The user chose ${outcome.decision} for ${describeGrants(outcome.grants)}, but ${COOKIE_ORIGIN_APPROVAL_FAILURE_BY_STAGE[outcome.stage]} (${outcome.errorClass}). No cookies were injected. Ask the user to turn on OpenTeam in System Settings \u2192 Privacy & Security \u2192 Full Disk Access and Automation (Finder), click Always Allow on Chrome Safe Storage, then retry.`;
    }
    return `The user chose ${outcome.decision} for ${describeGrants(outcome.grants)}, but ${COOKIE_ORIGIN_APPROVAL_FAILURE_BY_STAGE[outcome.stage]} (${outcome.errorClass}). No cookies were injected. Tell the user Chrome cookie import failed; do not retry unless they ask.`;
  }
  if (outcome.decision === "deny") {
    return "The user denied Chrome cookie access. Do not retry unless they ask.";
  }
  return `The user chose ${outcome.decision} for ${describeGrants(outcome.grants)}. Injected ${outcome.injected} cookie(s).`;
}
function truncationNotice(result, spansWholeHistory) {
  if (result.truncated === void 0) return void 0;
  if (result.kind === "find-chats") {
    return result.truncated === "bytes" ? "More chats matched than fit the size budget; a bigger limit will not help. Narrow with displayName or handle." : "More chats matched than were returned. Raise limit, or narrow with displayName or handle.";
  }
  if (spansWholeHistory) {
    return "This read spanned the user's whole Messages history. Narrow with chatGuid, IMessageActivity, or SearchIMessages rather than paging through everything.";
  }
  return result.truncated === "bytes" ? "Older items were withheld to fit the size budget; a bigger limit will not help. Pass nextBefore as before for the next-older page." : "Older items were withheld. Pass nextBefore as before for the next-older page.";
}
function renderContactsResult(result) {
  return JSON.stringify(
    result.truncated === void 0 ? result : { ...result, notice: "More people matched than were returned. Use a fuller name." }
  );
}
const MCP_LABEL_HOSTILE_CHARS = /[\u0000-\u001f\u007f"'`\\[\]{}()<>\u2028\u2029]/g;
function encodeMcpAccountLabelForListing(label) {
  const escaped = label.replace(
    MCP_LABEL_HOSTILE_CHARS,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
  return `"${escaped}"`;
}
const DEFAULT_MCP_CONNECTOR_INSTRUCTIONS = /* @__PURE__ */ new Map([
  [
    "hex",
    "When using Hex, get the underlying numbers as data: download/export the results as CSV or use the data the connector returns, and analyze those raw values directly. Don't read rendered charts or graphs from screenshots (computer-use chart reading is unreliable) \u2014 work from the actual data."
  ]
]);
function getDefaultMcpCustomInstruction(serverName) {
  return DEFAULT_MCP_CONNECTOR_INSTRUCTIONS.get(serverName.trim().toLowerCase()) ?? "";
}
function truncateOneLine(value, max) {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}\u2026` : oneLine;
}
function describeInstalled(server) {
  const parts = [
    `- ${server.serverIdentifier}: ${server.name} [${server.status}]`,
    `account=${encodeMcpAccountLabelForListing(server.accountKey)}`,
    `transport=${server.transport}`,
    server.disabledToolCount != null && server.disabledToolCount > 0 ? `tools=${server.toolCount}/${server.toolCount + server.disabledToolCount} enabled` : `tools=${server.toolCount}`
  ];
  if (server.pluginId != null) {
    parts.push(`plugin=${server.pluginId} (remove via UninstallPlugin \u2014 removes the whole plugin)`);
  }
  if (server.statusDetail != null && server.statusDetail.length > 0) {
    parts.push(`detail="${server.statusDetail}"`);
  }
  if (server.customInstructions.length > 0 && server.customInstructions !== getDefaultMcpCustomInstruction(server.name)) {
    parts.push(`instructions="${truncateOneLine(server.customInstructions, 120)}"`);
  }
  return parts.join(" \xB7 ");
}
function describeInstalledList(servers) {
  if (servers.length === 0) {
    return "No MCP servers are installed.";
  }
  return [`${servers.length} installed MCP server(s):`, ...servers.map(describeInstalled)].join(
    "\n"
  );
}
function describePluginInstallState(plugin) {
  if (!plugin.isInstalled) return "installed=no";
  return plugin.installMode != null ? `installed=yes (${plugin.installMode})` : "installed=yes";
}
function describePluginIncludes(plugin) {
  const parts = [];
  if (plugin.connectorCount > 0) {
    parts.push(`${plugin.connectorCount} connector${plugin.connectorCount === 1 ? "" : "s"}`);
  }
  if (plugin.skills.length > 0) {
    parts.push(`${plugin.skills.length} skill${plugin.skills.length === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(", ") : "no primitives";
}
function describePluginSummary(plugin) {
  const parts = [
    `- ${plugin.pluginId}: ${plugin.displayName} \u2014 ${plugin.description}`,
    `  (${[
      describePluginInstallState(plugin),
      `includes: ${describePluginIncludes(plugin)}`,
      `category=${plugin.category}`
    ].join("; ")})`
  ];
  const guidance = getDefaultMcpCustomInstruction(plugin.displayName);
  if (guidance.length > 0) {
    parts.push(`  usage guidance: ${guidance}`);
  }
  return parts.join("\n");
}
function describePluginFields(detail) {
  if (detail.fields.length === 0) return null;
  const lines2 = detail.fields.map((field) => {
    const flags = [
      field.isRequired ? "required" : "optional",
      ...field.isSecret ? ["secret \u2014 ask the user, never guess"] : []
    ].join(", ");
    return `  - ${field.key} (${field.label}; ${flags})`;
  });
  return ["Setup fields (pass in InstallPlugin values):", ...lines2].join("\n");
}
function describePluginDetail(detail) {
  const sections = [
    `${detail.pluginId}: ${detail.displayName} \u2014 ${detail.description}`,
    `${describePluginInstallState(detail)} \xB7 includes: ${describePluginIncludes(detail)} \xB7 category=${detail.category}`
  ];
  if (detail.skills.length > 0) {
    sections.push(
      [
        "Skills:",
        ...detail.skills.map(
          (skill) => `  - ${skill.name}${skill.description.length > 0 ? ` \u2014 ${truncateOneLine(skill.description, 140)}` : ""}`
        )
      ].join("\n")
    );
  }
  const fields2 = describePluginFields(detail);
  if (fields2 != null) sections.push(fields2);
  if (detail.servers.length > 0) {
    sections.push(
      [
        "Its installed MCP server(s) \u2014 statuses live in GetMcpServerStatus:",
        ...detail.servers.map(describeInstalled)
      ].join("\n")
    );
  }
  if (detail.isInstalled && detail.installMode === "team-required") {
    sections.push("Required by the user's team \u2014 it cannot be uninstalled.");
  }
  return sections.join("\n");
}
const PLUGIN_QUERY_MIN_TOKEN_LENGTH = 3;
function tokenizePluginQuery(query) {
  return [
    ...new Set(
      query.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= PLUGIN_QUERY_MIN_TOKEN_LENGTH)
    )
  ];
}
function scorePluginForToken(plugin, token) {
  const name17 = plugin.name.toLowerCase();
  const displayName2 = plugin.displayName.toLowerCase();
  if (name17 === token || displayName2 === token) return 8;
  if (name17.includes(token) || displayName2.includes(token)) return 5;
  if (plugin.skills.some((skill) => skill.name.toLowerCase().includes(token))) {
    return 3;
  }
  if (plugin.category.toLowerCase().includes(token)) return 2;
  if (plugin.description.toLowerCase().includes(token)) return 1;
  return 0;
}
function rankPluginsLexically(plugins, query) {
  const tokens = tokenizePluginQuery(query);
  const byName = (a, b2) => a.displayName.localeCompare(b2.displayName);
  if (tokens.length === 0) return [...plugins].sort(byName);
  return plugins.map((plugin) => ({
    plugin,
    score: tokens.reduce((sum, token) => sum + scorePluginForToken(plugin, token), 0)
  })).filter((entry) => entry.score > 0).sort((a, b2) => b2.score - a.score || byName(a.plugin, b2.plugin)).map((entry) => entry.plugin);
}
function formatOutputLocationSize(sizeBytes) {
  const total = Number(sizeBytes);
  return total >= 1024 ? `${(total / 1024).toFixed(1)} KB` : `${total} bytes`;
}
function describeOutputLocation(loc, opts) {
  var _a19;
  const lead = (_a19 = opts === null || opts === void 0 ? void 0 : opts.leadText) !== null && _a19 !== void 0 ? _a19 : "Content";
  return `${lead} written to file: ${loc.filePath}
Size: ${formatOutputLocationSize(loc.sizeBytes)}, ${loc.lineCount} lines`;
}
const SAND_REMAP_USER_FORM_TARGETS_TOOL_NAME = "remap_user_form_targets";
const SAND_REMAP_USER_FORM_TARGETS_CALL_HINT = `CallDynamicTool with namespace "cursor", toolName "${SAND_REMAP_USER_FORM_TARGETS_TOOL_NAME}", and arguments { "targets": [{ "fieldId": "<held id>", "target": { "kind": "ref" | "selector" | "label", "value": "<ref, selector, or label>" } }] } (GetDynamicTools on that namespace shows the schema)`;
const REMAP_FAILED_STATUS_BY_KIND = {
  driver_unavailable: "NOT FILLED: the host could not reach the box browser, so nothing was written",
  target_gone: "NOT FILLED: the new ref no longer resolves \u2014 the page re-rendered since that snapshot",
  target_missing: "NOT FILLED: nothing on the live page matched the new target",
  in_unreachable_frame: "NOT FILLED: the new target sits in a frame the host cannot enter (cross-origin iframe)",
  in_closed_shadow: "NOT FILLED: the new target sits behind a closed shadow root the host cannot reach",
  fill_op_failed: "NOT FILLED: the new target resolved to a live element but the write errored",
  hidden_target: "REFUSED: the new target resolved, but it is a control the user cannot see (display:none, zero-size, or aria-hidden) \u2014 a hidden twin, honeypot, or not-yet-revealed step. The host never writes into a hidden control",
  page_moved: "NOT FILLED: the live tab moved to a different page or step before this write, so the host stopped"
};
function buildUserFormRemapReceipt(outcome) {
  if (outcome.kind === "no_hold") {
    return `Nothing to remap: the host holds no submitted values for this agent. A remap is offered on a fill receipt and is spent by the first ${SAND_REMAP_USER_FORM_TARGETS_TOOL_NAME} call or by the end of that turn. If a field still needs filling, re-ask with a new request_user_form or hand the user the screen with request_box_help.`;
  }
  if (outcome.kind === "unknown_fields") {
    return `Nothing was written: ${outcome.unknownFieldIds.map((id) => `"${id}"`).join(", ")} ${outcome.unknownFieldIds.length === 1 ? "is not a field" : "are not fields"} the host holds a value for. The held field ids are ${outcome.heldFieldIds.map((id) => `"${id}"`).join(", ")} \u2014 call again via ${SAND_REMAP_USER_FORM_TARGETS_CALL_HINT} with only those (the hold stands until this turn ends).`;
  }
  const lines2 = outcome.outcomes.map((fieldOutcome) => {
    const kind = outcome.fillFailureKinds?.[fieldOutcome.id];
    let status = "NOT FILLED (the write was refused)";
    if (fieldOutcome.filled) {
      status = "filled into the page with the value the user submitted";
    } else if (kind !== void 0) {
      status = REMAP_FAILED_STATUS_BY_KIND[kind];
    }
    return `- ${fieldOutcome.id}: ${status}`;
  });
  const notRemapped = outcome.notRemappedFieldIds.map(
    (id) => `- ${id}: not remapped \u2014 its held value was discarded`
  );
  const mismatch = outcome.domainMismatch != null ? [
    `The host REFUSED to write: the live page (${outcome.domainMismatch.liveHost != null ? `host ${outcome.domainMismatch.liveHost}` : "host unknown"}) is not the host the user consented to. Nothing was written.`
  ] : [];
  const anyFailed = outcome.outcomes.some((fieldOutcome) => !fieldOutcome.filled) || notRemapped.length > 0;
  return [
    "[Remap result \u2014 the host wrote the values the user already submitted; no value is returned to you:",
    ...mismatch,
    ...lines2,
    ...notRemapped,
    `The held values for this form are now discarded (one remap per form).${anyFailed ? " For a field that did not land, do NOT immediately re-issue a form for it: the user already typed it once. Continue the task if the page moved on, or hand the user the screen with request_box_help; re-ask with a new request_user_form only if the step cannot proceed any other way." : ""} Take a fresh page SNAPSHOT (not a screenshot) before the next action, and click the site's submit control yourself.]`
  ].join("\n");
}
export { formatBytes2, describeUploadFileOutcome, formatBytes, describeDownloadFileOutcome, renderCredentialProviderStatus, credentialSiteHost, describeCredential, describeCookieOriginRequestEntry, describeGrants, formatCookieOriginApprovalOutcome, truncationNotice, renderContactsResult, MCP_LABEL_HOSTILE_CHARS, encodeMcpAccountLabelForListing, DEFAULT_MCP_CONNECTOR_INSTRUCTIONS, getDefaultMcpCustomInstruction, truncateOneLine, describeInstalled, describeInstalledList, describePluginInstallState, describePluginIncludes, describePluginSummary, describePluginFields, describePluginDetail, PLUGIN_QUERY_MIN_TOKEN_LENGTH, tokenizePluginQuery, scorePluginForToken, rankPluginsLexically, formatOutputLocationSize, describeOutputLocation, SAND_REMAP_USER_FORM_TARGETS_TOOL_NAME, SAND_REMAP_USER_FORM_TARGETS_CALL_HINT, REMAP_FAILED_STATUS_BY_KIND, buildUserFormRemapReceipt, AUTO_FILL_ON_GUIDANCE, AUTO_FILL_RULE, CREDENTIAL_REQUEST_GUIDANCE };
