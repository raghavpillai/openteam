FROM oven/bun:1.3.8 AS build

WORKDIR /app
COPY package.json bun.lock turbo.json tsconfig.base.json ./
COPY apps/computer/package.json apps/computer/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/client-core/package.json packages/client-core/package.json
COPY packages/codex-client/package.json packages/codex-client/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/messaging/package.json packages/messaging/package.json
COPY patches ./patches
RUN bun install --frozen-lockfile --production --filter @openbot/computer
COPY apps/computer ./apps/computer
COPY packages/contracts ./packages/contracts
RUN bun --filter @openbot/computer build

FROM debian:bookworm-slim AS desktop-assets

RUN apt-get update \
  && apt-get install -y --no-install-recommends imagemagick \
  && rm -rf /var/lib/apt/lists/* \
  && convert -size 1280x800 'gradient:#35383c-#151719' /tmp/openbot-wallpaper-base.png \
  && convert -size 1280x800 xc:none \
    -fill none \
    -stroke 'rgba(220,222,224,0.20)' \
    -strokewidth 150 \
    -draw "path 'M -180,930 C 260,610 600,770 760,470 C 900,205 1040,130 1430,-80'" \
    -blur 0x22 \
    /tmp/openbot-wallpaper-ribbon.png \
  && composite \
    /tmp/openbot-wallpaper-ribbon.png \
    /tmp/openbot-wallpaper-base.png \
    /openbot-wallpaper.png

FROM oven/bun:1.3.8-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    curl \
    dbus-x11 \
    fonts-liberation \
    ffmpeg \
    gcc \
    gh \
    git \
    jq \
    nodejs \
    npm \
    novnc \
    poppler-utils \
    python3-pip \
    ripgrep \
    thunar \
    tini \
    unzip \
    websockify \
    wget \
    x11-xserver-utils \
    x11vnc \
    xdotool \
    xfce4-panel \
    xfce4-settings \
    xfce4-terminal \
    xfconf \
    xfdesktop4 \
    xfwm4 \
    xvfb \
  && rm -rf /var/lib/apt/lists/* \
  && groupmod --new-name box bun \
  && usermod --login box --home /home/box --move-home --shell /bin/bash bun \
  && mkdir -p /opt/pi /app /workspace /home/box/.pi/agent \
  && cd /app \
    && bun add @earendil-works/pi-coding-agent@0.84.3 playwright-core@1.55.0 \
  && cd /opt/pi \
    && bun add @earendil-works/pi-ai@0.84.3 \
  && ln -s /opt/pi/node_modules/.bin/pi-ai /usr/local/bin/pi-ai \
  && mv /usr/bin/chromium /usr/local/bin/google-chrome \
  && chown -R box:box /app /workspace /home/box

COPY --from=ghcr.io/astral-sh/uv:0.8.14 /uv /uvx /usr/local/bin/

COPY --from=build --chown=box:box /app/apps/computer/dist/main.js /app/main.js
COPY --from=build --chown=box:box /app/apps/computer/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js /app/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js
COPY --chown=box:box docker/computer-entrypoint.sh /usr/local/bin/openbot-computer-entrypoint
COPY --chown=box:box docker/openbot-pi-login /usr/local/bin/openbot-pi-login
COPY --chown=box:box docker/desktop /usr/share/openbot-desktop
COPY --chown=box:box docker/openbot-screen-launch /usr/local/bin/openbot-screen-launch
COPY --chown=box:box docker/openbot-vnc.html /usr/share/novnc/openbot.html
COPY --from=desktop-assets /openbot-wallpaper.png /usr/share/openbot-desktop/wallpaper.png
RUN chmod 0755 \
    /usr/local/bin/openbot-computer-entrypoint \
    /usr/local/bin/openbot-pi-login \
    /usr/local/bin/openbot-screen-launch

ENV HOME=/home/box
ENV OPENBOT_PI_AGENT_DIR=/home/box/.pi/agent
WORKDIR /workspace
USER box
EXPOSE 8790 6200-6299
ENTRYPOINT ["tini", "--", "openbot-computer-entrypoint"]
CMD ["bun", "/app/main.js"]
