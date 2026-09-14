import { normalizeRobotAvatarShape } from "@openteam/contracts/robot-avatar";
import type { NotificationSender } from "@openteam/contracts/notification-content";
import {
  ROBOT_AVATAR_ARTWORK,
  ROBOT_AVATAR_VIEW_BOX,
  robotAvatarFaceColor,
  type RobotAvatarNode,
} from "@openteam/design-tokens/robot-avatar-artwork";

const cache = new Map<string, Promise<string | undefined>>();
const escape = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
export function notificationAvatarSvg(sender: NotificationSender): string {
  const color = /^#[0-9a-f]{6}$/i.test(sender.color) ? sender.color : "#4f7cff";
  const render = (node: RobotAvatarNode): string => {
    const attributes = Object.entries(node.attributes)
      .flatMap(([key, value]) => {
        if (key.startsWith("data-")) return [];
        if (key === "style")
          return typeof value === "object" && value.transform?.includes("perspective")
            ? ['transform="translate(52 0) scale(0.9703 1) translate(-50 0)"']
            : [];
        const name = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
        const resolved =
          value === "currentColor"
            ? color
            : value === "var(--robot-face, #1b1b1d)"
              ? robotAvatarFaceColor(color)
              : String(value);
        return [`${name}="${escape(resolved)}"`];
      })
      .join(" ");
    return `<${node.tag} ${attributes}>${node.children?.map(render).join("") ?? ""}</${node.tag}>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="${ROBOT_AVATAR_VIEW_BOX}">${ROBOT_AVATAR_ARTWORK[normalizeRobotAvatarShape(sender.icon)].map(render).join("")}</svg>`;
}

export function notificationAvatarDataUrl(sender: NotificationSender): Promise<string | undefined> {
  const key = `${sender.icon}:${sender.color}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const result = new Promise<string | undefined>((resolve) => {
    const picture = new Image();
    const timer = setTimeout(() => resolve(undefined), 1000);
    picture.onload = () => {
      clearTimeout(timer);
      try {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 144;
        canvas.getContext("2d")?.drawImage(picture, 0, 0);
        resolve(canvas.toDataURL("image/png"));
      } catch {
        resolve(undefined);
      }
    };
    picture.onerror = () => {
      clearTimeout(timer);
      resolve(undefined);
    };
    picture.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(notificationAvatarSvg(sender))}`;
  });
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  cache.set(key, result);
  return result;
}
