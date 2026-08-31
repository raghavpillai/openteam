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
RUN bun install --frozen-lockfile --production --filter @openbot/computer
COPY apps/computer ./apps/computer
COPY packages/contracts ./packages/contracts
RUN bun --filter @openbot/computer build

FROM oven/bun:1.3.8-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    dbus-x11 \
    fonts-liberation \
    ffmpeg \
    git \
    imagemagick \
    nodejs \
    novnc \
    poppler-utils \
    ripgrep \
    thunar \
    tini \
    websockify \
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
  && groupadd --gid 10001 openbot \
  && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash openbot \
  && mkdir -p /opt/pi /app /workspace /home/openbot/.pi/agent \
  && cd /app \
    && bun add @earendil-works/pi-coding-agent@0.84.3 playwright-core@1.55.0 \
  && cd /opt/pi \
  && bun add @earendil-works/pi-ai@0.84.3 \
  && ln -s /opt/pi/node_modules/.bin/pi-ai /usr/local/bin/pi-ai \
  && chown -R openbot:openbot /app /workspace /home/openbot

COPY --from=build --chown=openbot:openbot /app/apps/computer/dist/main.js /app/main.js
COPY --chown=openbot:openbot docker/computer-entrypoint.sh /usr/local/bin/openbot-computer-entrypoint
COPY --chown=openbot:openbot docker/openbot-pi-login /usr/local/bin/openbot-pi-login
COPY --chown=openbot:openbot docker/desktop /usr/share/openbot-desktop
COPY --chown=openbot:openbot docker/openbot-screen-launch /usr/local/bin/openbot-screen-launch
COPY --chown=openbot:openbot docker/openbot-vnc.html /usr/share/novnc/openbot.html
RUN convert -size 1280x800 'gradient:#35383c-#151719' /tmp/openbot-wallpaper-base.png \
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
    /usr/share/openbot-desktop/wallpaper.png \
  && rm /tmp/openbot-wallpaper-base.png /tmp/openbot-wallpaper-ribbon.png \
  && chmod 0755 \
    /usr/local/bin/openbot-computer-entrypoint \
    /usr/local/bin/openbot-pi-login \
    /usr/local/bin/openbot-screen-launch

ENV HOME=/home/openbot
ENV OPENBOT_PI_AGENT_DIR=/home/openbot/.pi/agent
WORKDIR /app
USER openbot
EXPOSE 8790 6200-6299
ENTRYPOINT ["tini", "--", "openbot-computer-entrypoint"]
CMD ["bun", "main.js"]
