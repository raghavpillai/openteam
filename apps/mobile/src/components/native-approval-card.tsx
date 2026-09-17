import { PermissionIcon } from "./permission-icon";
import { nativeApprovalOutcome } from "@openteam/product-core/activity";
import type { ApprovalView } from "@openteam/contracts";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { usePermissionTheme as useTheme } from "./permission-theme";

type CookieItem = { origin: string; profileId: string; profileDisplayName: string };
export type NativeApprovalPresentation =
  | { kind: "saved-login"; title: string; site: string; category: string; purpose: string }
  | { kind: "cookie-import"; items: CookieItem[] };
type Decision = "accept" | "decline" | "always_allow" | "never";
const itemKey = (item: CookieItem) => JSON.stringify([item.profileId, item.origin]);

/** These cards contain reviewed public metadata; private bytes stay on the host. */
export function NativeApprovalCard({
  approval,
  presentation,
  busy,
  error,
  onResolve,
}: {
  approval: ApprovalView;
  presentation: NativeApprovalPresentation;
  busy: boolean;
  error: string;
  onResolve: (decision: Decision, selectedItems?: readonly string[]) => Promise<void>;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [excluded, setExcluded] = useState(new Set<string>());
  const details = approval.details as Record<string, unknown>;
  const { pending, accepted, filling, failed, status } = nativeApprovalOutcome(approval);
  const text = { color: theme.text, fontSize: 14, lineHeight: 22 };
  const secondary = { color: theme.textMuted, fontSize: 13, lineHeight: 18, letterSpacing: -0.08 };
  const button = (label: string, decision: Decision, selectedItems?: string[], primary = false) => (
    <Pressable
      accessibilityRole="button"
      disabled={busy || selectedItems?.length === 0}
      onPress={() => void onResolve(decision, selectedItems)}
      style={{
        height: 32,
        paddingHorizontal: 10,
        justifyContent: "center",
        borderRadius: 8,
        borderWidth: 1,
        borderColor: "transparent",
        backgroundColor: primary
          ? presentation.kind === "saved-login" && !theme.dark
            ? "#070707"
            : theme.text
          : theme.surfacePressed,
        opacity: busy || selectedItems?.length === 0 ? 0.56 : 1,
      }}
    >
      <Text style={{ ...text, color: primary ? theme.field : theme.text }}>{label}</Text>
    </Pressable>
  );
  const failure =
    error && pending ? (
      <Text accessibilityRole="alert" style={{ fontSize: 13, color: theme.danger }}>
        {error}
      </Text>
    ) : null;
  if (presentation.kind === "saved-login") {
    let site = presentation.site;
    try {
      site = new URL(site).host;
    } catch {
      /* Preserve the reviewed host. */
    }
    const color = failed
      ? theme.danger
      : accepted
        ? theme.success
        : theme.dark
          ? "#fcfcfc8f"
          : "#1414149c";
    return (
      <View
        accessibilityLabel="Saved login permission"
        style={{
          marginHorizontal: 18,
          marginVertical: 10,
          borderRadius: 16,
          padding: 12,
          gap: pending || filling ? 10 : 8,
          backgroundColor: theme.dark ? "#7777772c" : "#77777717",
          flexDirection: pending || filling ? "column" : "row",
          alignItems: pending || filling ? "stretch" : "center",
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            minWidth: 0,
            ...(pending || filling ? {} : { flex: 1 }),
          }}
        >
          <View style={{ transform: [{ translateY: 1.78125 }] }}>
            <PermissionIcon name="key" size={14} tintColor={theme.textMuted} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ ...text, fontWeight: "500", letterSpacing: -0.15 }}>
              {presentation.title}
            </Text>
            <Text style={secondary}>
              {presentation.category} · {site}
            </Text>
          </View>
        </View>
        {filling ? (
          <Text
            accessibilityRole="summary"
            accessibilityLiveRegion="polite"
            style={{ ...text, color: theme.textMuted, letterSpacing: -0.15 }}
          >
            Filling 1Password login for {site}
          </Text>
        ) : pending ? (
          <>
            <Text style={{ ...text, color: theme.textMuted, letterSpacing: -0.15 }}>
              {presentation.purpose}
            </Text>
            {failure}
            <View style={{ flexDirection: "row", gap: 8 }}>
              {button("Allow Once", "accept", undefined, true)}
              {button("Deny", "decline")}
            </View>
          </>
        ) : (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: 999,
              backgroundColor: failed
                ? theme.dangerBackground
                : accepted
                  ? theme.successBackground
                  : theme.mutedBackground,
            }}
          >
            {accepted && !failed && <PermissionIcon name="check" size={12} tintColor={color} />}
            <Text style={{ ...text, fontWeight: "500", letterSpacing: -0.15, color }}>
              {status}
            </Text>
          </View>
        )}
      </View>
    );
  }
  const approved = Array.isArray(details.selectedItems) ? new Set(details.selectedItems) : null;
  const items =
    accepted && approved
      ? presentation.items.filter((item) => approved.has(itemKey(item)))
      : presentation.items;
  const selected = items.filter((item) => !excluded.has(itemKey(item))).map(itemKey);
  const profiles = [...new Set(items.map((item) => item.profileId))];
  const toggle = (keys: string[], checked: boolean) =>
    setExcluded((current) => {
      const next = new Set(current);
      for (const key of keys) checked ? next.delete(key) : next.add(key);
      return next;
    });
  const badgeColor =
    pending || filling
      ? theme.dark
        ? "#ffaf38"
        : "#c27400"
      : accepted && !failed
        ? theme.dark
          ? "#38d591"
          : "#009957"
        : theme.danger;
  return (
    <View
      accessibilityLabel="Chrome login permission"
      style={{
        marginHorizontal: 18,
        marginVertical: 10,
        borderRadius: 16,
        padding: 12,
        gap: 12,
        backgroundColor: theme.assistantBubble,
      }}
    >
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
          <Text
            style={{ ...text, lineHeight: 20, flex: 1, fontWeight: "500", letterSpacing: -0.15 }}
          >
            The Bot wants to use your existing logins
          </Text>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              paddingHorizontal: 8,
              paddingVertical: 2,
              borderRadius: 999,
              backgroundColor:
                pending || filling
                  ? theme.dark
                    ? "#ff98002c"
                    : "#ff980017"
                  : accepted && !failed
                    ? theme.successBackground
                    : theme.dangerBackground,
            }}
          >
            {pending || filling ? (
              <ActivityIndicator size={14} color={badgeColor} />
            ) : (
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: badgeColor }} />
            )}
            <Text style={{ ...secondary, color: badgeColor, fontWeight: "500" }}>
              {pending ? "Approval needed" : filling ? "Importing logins" : status}
            </Text>
          </View>
        </View>
        {pending && (
          <Text style={secondary}>
            Copies cookies from Chrome on your computer so the bot can use sites you're already
            signed into.
          </Text>
        )}
        <View style={{ gap: 4, paddingBottom: open ? 0 : 4 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            onPress={() => setOpen(!open)}
            style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
          >
            <View style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center" }}>
              <PermissionIcon
                name={open ? "down" : "right"}
                size={10}
                tintColor={theme.textMuted}
              />
            </View>
            <Text style={secondary}>{open ? "Hide" : "Show"} the sites</Text>
          </Pressable>
          {open && (
            <View style={{ gap: 12 }}>
              {profiles.map((profile) => {
                const group = items.filter((item) => item.profileId === profile);
                const all = group.every((item) => !excluded.has(itemKey(item)));
                const name = group[0]?.profileDisplayName ?? profile;
                return (
                  <View
                    key={profile}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                      gap: 8,
                      borderRadius: 8,
                      backgroundColor: theme.field,
                    }}
                  >
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                      }}
                    >
                      <Text style={{ ...secondary, color: theme.text, fontWeight: "500" }}>
                        {name}
                      </Text>
                      {pending && (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`${all ? "Deselect" : "Select"} all in ${name}`}
                          disabled={busy}
                          onPress={() => toggle(group.map(itemKey), !all)}
                          style={{ paddingHorizontal: 6, paddingVertical: 4 }}
                        >
                          <Text style={secondary}>{all ? "Deselect all" : "Select all"}</Text>
                        </Pressable>
                      )}
                    </View>
                    <View>
                      {group.map((item) => {
                        const checked = pending ? !excluded.has(itemKey(item)) : accepted;
                        return (
                          <Pressable
                            key={itemKey(item)}
                            accessibilityRole="checkbox"
                            aria-checked={checked}
                            accessibilityLabel={`${item.origin} in ${item.profileDisplayName}`}
                            accessibilityState={{ checked, disabled: busy || !pending }}
                            disabled={busy || !pending}
                            onPress={() => toggle([itemKey(item)], !checked)}
                            style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
                          >
                            <View
                              style={{
                                width: 16,
                                height: 16,
                                borderRadius: 4,
                                backgroundColor: checked
                                  ? pending
                                    ? "#00c972"
                                    : "#00c9722b"
                                  : "transparent",
                                borderWidth: 1,
                                borderColor: theme.border,
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              {checked && (
                                <PermissionIcon
                                  name="check"
                                  size={12}
                                  tintColor={pending ? "#fff" : "#00c972"}
                                />
                              )}
                            </View>
                            <Text style={{ ...secondary, color: theme.text, letterSpacing: 0 }}>
                              {item.origin}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                );
              })}
            </View>
          )}
        </View>
        {failure}
      </View>
      {pending && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {button("Allow once", "accept", selected, true)}
          {details.supportsAlwaysAllow === true && button("Always allow", "always_allow", selected)}
          {button("Deny", "decline")}
        </View>
      )}
    </View>
  );
}
