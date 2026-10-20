import type { CSSProperties } from "react";
import { BotAvatarGlyph } from "../avatar-picker-icons";

// The pictures for welcome and sign-in. They live apart from the setup screens' pictures
// (visuals.tsx), so the sign-in chunk doesn't carry the provider artwork it never shows.

// Per-item index for staggered CSS entrances (see --i in setup.css).
const nth = (index: number) => ({ "--i": index }) as CSSProperties;

/**
 * The three OpenTeam robots. They drop in one after another and land with a bounce, then
 * the first one says hello; afterwards they float out of phase and blink now and then.
 */
export function RobotsVisual() {
  return (
    <div className="setup-robots">
      <div className="setup-hello">Hi! Let's get you set up.</div>
      <span style={{ ...nth(0), "--tilt": "-9deg" } as CSSProperties}>
        <BotAvatarGlyph color="#08c875" eyeColor="#111111" mode="idle" shape="chip" />
      </span>
      <span style={{ ...nth(1), "--tilt": "5deg" } as CSSProperties}>
        <BotAvatarGlyph color="#1685ed" eyeColor="#111111" mode="idle" shape="tv-head" />
      </span>
      <span style={{ ...nth(2), "--tilt": "10deg" } as CSSProperties}>
        <BotAvatarGlyph color="#ff9912" eyeColor="#111111" mode="idle" shape="helmet" />
      </span>
    </div>
  );
}

/**
 * The end of `openteam setup`, pointing at the line this screen asks for. The address and
 * sign-in screens share it, so the card stays and only the highlight glides between lines.
 * The username is an example: the terminal asks people to choose their own.
 */
export function TerminalVisual({ highlight }: { highlight: "server" | "username" }) {
  return (
    <div className="setup-terminal">
      <div className="setup-terminal-bar">
        <i />
        <i />
        <i />
      </div>
      {/* Lines type in one after another; then the highlight settles on the asked-for line. */}
      <pre>
        <span aria-hidden="true" className="setup-terminal-mark" data-line={highlight} />
        <span className="setup-line dim" style={nth(0)}>
          $ openteam setup
        </span>
        <span className="setup-line dim" style={nth(1)}>
          {" …"}
        </span>
        <span className="setup-line" style={nth(2)} />
        <span className="setup-line" style={nth(3)}>
          <span className="ok">✓</span> OpenTeam is ready
        </span>
        <span className="setup-line" data-lit={highlight === "server"} style={nth(4)}>
          {"  Server    http://192.168.1.20:8787"}
        </span>
        <span className="setup-line" data-lit={highlight === "username"} style={nth(5)}>
          {"  Username  sam"}
        </span>
        <span className="setup-line" style={nth(6)} />
        <span className="setup-line dim" style={nth(7)}>
          Next: open the OpenTeam app and sign in.
        </span>
      </pre>
    </div>
  );
}
