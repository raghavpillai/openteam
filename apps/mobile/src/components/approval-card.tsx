import { PermissionIcon } from "./permission-icon";
import { NativeApprovalCard, type NativeApprovalPresentation } from "./native-approval-card";
import type { ApprovalView } from "@openteam/contracts";
import { approvalPresentation } from "@openteam/product-core/activity";
import * as Haptics from "../haptics";
import { SymbolView } from "expo-symbols";
import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { usePermissionTheme as useTheme } from "./permission-theme";

type Decision = "accept" | "decline" | "always_allow" | "never";
export function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: ApprovalView;
  onResolve: (decision: Decision, selectedItems?: readonly string[]) => Promise<void>;
}) {
  const theme = useTheme();
  const inFlight = useRef(false);
  const latest = useRef(approval);
  latest.current = approval;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const view = approvalPresentation(approval);
  const pending = approval.status === "pending";
  const local = view.kind === "local-tool";
  const auto = view.kind === "auto-review";
  const resolve = async (decision: Decision, selectedItems?: readonly string[]) => {
    if (inFlight.current || latest.current.status !== "pending") return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await onResolve(decision, selectedItems);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      if (latest.current.status === "pending")
        setError("We couldn't confirm your decision. Check this card before trying again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const text = { color: theme.text, fontSize: 14, lineHeight: 20 };
  const secondary = { color: theme.textMuted, fontSize: 13, lineHeight: 18, letterSpacing: -0.08 };
  const button = (label: string, decision: Decision, primary = false) => (
    <Pressable
      key={decision}
      accessibilityRole="button"
      disabled={busy}
      onPress={() => void resolve(decision)}
      style={{
        height: 32,
        paddingHorizontal: 10,
        justifyContent: "center",
        borderRadius: 8,
        borderWidth: 1,
        borderColor: "transparent",
        backgroundColor: primary ? theme.text : theme.surfacePressed,
        opacity: busy ? 0.56 : 1,
      }}
    >
      <Text style={{ ...text, lineHeight: 22, color: primary ? theme.field : theme.text }}>
        {label}
      </Text>
    </Pressable>
  );
  const nativePresentation = view.details.presentation as NativeApprovalPresentation | undefined;
  if (
    view.details.type === "nativeCapability" &&
    (nativePresentation?.kind === "saved-login" || nativePresentation?.kind === "cookie-import")
  )
    return (
      <NativeApprovalCard
        approval={approval}
        presentation={nativePresentation}
        busy={busy}
        error={error}
        onResolve={resolve}
      />
    );
  if (local && !pending)
    return (
      <View
        accessibilityLabel="Permission result"
        style={{ minHeight: 24, marginHorizontal: 18, marginVertical: 10 }}
      >
        <Text
          accessibilityRole="summary"
          style={{ color: theme.textMuted, fontSize: 12, lineHeight: 16, textAlign: "center" }}
        >
          {view.statusLabel}
        </Text>
      </View>
    );
  const allowed = approval.status === "accepted";
  const badgeColor = pending
    ? theme.dark
      ? "#ffaf38"
      : "#c27400"
    : allowed
      ? theme.success
      : approval.status === "declined"
        ? theme.danger
        : theme.textMuted;
  return (
    <View
      accessibilityLabel={pending ? `${view.title}. ${view.description}` : "Permission result"}
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
          {local && (
            <View style={{ height: 22, justifyContent: "center" }}>
              <View style={{ width: 16, height: 16 }}>
                <PermissionIcon
                  name="warning"
                  size={14}
                  tintColor={theme.dark ? "#ff8838" : "#c24e00"}
                />
              </View>
            </View>
          )}
          <Text style={{ ...text, flex: 1, fontWeight: "500", letterSpacing: -0.15 }}>
            {view.title}
          </Text>
          {local && pending ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Deny once"
              disabled={busy}
              onPress={() => void resolve("decline")}
              style={{ width: 20, height: 20, alignItems: "center", justifyContent: "center" }}
            >
              <PermissionIcon name="close" size={10} tintColor={theme.textMuted} />
            </Pressable>
          ) : (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                paddingHorizontal: 8,
                paddingVertical: 2,
                borderRadius: 999,
                backgroundColor: pending
                  ? theme.dark
                    ? "#ff98002c"
                    : "#ff980017"
                  : allowed
                    ? theme.successBackground
                    : approval.status === "declined"
                      ? theme.dangerBackground
                      : theme.surfacePressed,
              }}
            >
              {pending ? (
                <ActivityIndicator size={14} color={badgeColor} />
              ) : (
                <View
                  style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: badgeColor }}
                />
              )}
              <Text
                style={{
                  fontSize: 13,
                  lineHeight: 18,
                  fontWeight: "500",
                  letterSpacing: -0.08,
                  color: badgeColor,
                }}
              >
                {view.statusLabel}
              </Text>
            </View>
          )}
        </View>
        {local ? (
          <>
            <Text
              style={{ color: theme.textMuted, fontSize: 12, lineHeight: 16, fontWeight: "500" }}
            >
              {view.machineLabel}
            </Text>
            <Text style={secondary}>
              This applies to OpenTeam and every Bot. It can always be changed in Settings.
            </Text>
          </>
        ) : auto ? (
          <>
            {!view.taskReview && (
              <>
                <Text
                  style={{
                    color: theme.textMuted,
                    fontSize: 12,
                    lineHeight: 16,
                    fontWeight: "500",
                  }}
                >
                  Runs on your local computer
                </Text>
                <Text style={{ color: theme.text, fontSize: 13, lineHeight: 18.85 }}>
                  {view.reviewSummary}
                </Text>
              </>
            )}
            {pending && view.reason && <Text style={secondary}>{view.reason}</Text>}
          </>
        ) : (
          <Text style={secondary}>{view.description}</Text>
        )}
        {!pending && view.resolution === "always_allow" && auto && (
          <Text style={secondary}>
            A rule always allowing this was added to your Auto-review settings
            {view.proposedRule ? `: “${view.proposedRule}”` : ""}
          </Text>
        )}
        {view.rawDetails && (
          <View style={{ gap: 4, paddingBottom: 4 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              onPress={() => setOpen(!open)}
              style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
            >
              <View
                style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center" }}
              >
                <PermissionIcon
                  name={open ? "down" : "right"}
                  size={10}
                  tintColor={theme.textMuted}
                />
              </View>
              <Text style={{ ...secondary, letterSpacing: 0 }}>
                {open ? "Hide" : "Show"} the {view.detailsLabel}
              </Text>
            </Pressable>
            {open && (
              <Text
                selectable
                style={{
                  ...secondary,
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  borderRadius: 8,
                  backgroundColor: theme.surfacePressed,
                  fontFamily: "Menlo",
                }}
              >
                {view.rawDetails}
              </Text>
            )}
          </View>
        )}
        {pending && error ? (
          <Text accessibilityRole="alert" style={{ fontSize: 13, color: theme.danger }}>
            {error}
          </Text>
        ) : null}
      </View>
      {pending && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {local && view.supportsAlwaysAllow && button("Always allow", "always_allow", true)}
          {button("Allow once", "accept", !local || !view.supportsAlwaysAllow)}
          {!local && view.supportsAlwaysAllow && button("Always allow", "always_allow")}
          {!local && button("Deny", "decline")}
          {view.supportsNever && button("Never", "never")}
        </View>
      )}
    </View>
  );
}
