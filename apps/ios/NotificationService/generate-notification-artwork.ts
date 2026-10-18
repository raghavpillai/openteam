import { ROBOT_AVATAR_ARTWORK } from "@openteam/design-tokens/robot-avatar-artwork";
const output = new URL("RobotNotificationArtwork.json", import.meta.url);
await Bun.write(output, `${JSON.stringify(ROBOT_AVATAR_ARTWORK)}\n`);
