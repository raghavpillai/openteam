FROM --platform=$BUILDPLATFORM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS build

WORKDIR /app
COPY package.json bun.lock turbo.json tsconfig.base.json ./
COPY apps/computer/package.json apps/computer/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/landing/package.json apps/landing/package.json
COPY apps/ios/package.json apps/ios/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/client-core/package.json packages/client-core/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/shell-jobs/package.json packages/shell-jobs/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/design-tokens/package.json packages/design-tokens/package.json
COPY packages/messaging/package.json packages/messaging/package.json
COPY packages/product-core/package.json packages/product-core/package.json
COPY packages/plugin-sdk/package.json packages/plugin-sdk/package.json
COPY packages/plugins/package.json packages/plugins/package.json
COPY patches ./patches
COPY vendor/sheetjs/xlsx-0.20.3.tgz vendor/sheetjs/xlsx-0.20.3.tgz
RUN bun install --frozen-lockfile --production --filter @openteam/computer
COPY apps/computer ./apps/computer
COPY packages/contracts ./packages/contracts
COPY packages/shell-jobs ./packages/shell-jobs
COPY packages/plugin-sdk ./packages/plugin-sdk
COPY packages/plugins ./packages/plugins
RUN bun --filter @openteam/computer build

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS desktop-assets

RUN apt-get update \
  && apt-get install -y --no-install-recommends imagemagick \
  && rm -rf /var/lib/apt/lists/* \
  && convert -size 1280x800 'gradient:#35383c-#151719' /tmp/openteam-wallpaper-base.png \
  && convert -size 1280x800 xc:none \
    -fill none \
    -stroke 'rgba(220,222,224,0.20)' \
    -strokewidth 150 \
    -draw "path 'M -180,930 C 260,610 600,770 760,470 C 900,205 1040,130 1430,-80'" \
    -blur 0x22 \
    /tmp/openteam-wallpaper-ribbon.png \
  && composite \
    /tmp/openteam-wallpaper-ribbon.png \
    /tmp/openteam-wallpaper-base.png \
    /openteam-wallpaper.png

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS memory-tools
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY docker/openteam-memory-init.c docker/openteam-desktop-exec.c /tmp/
RUN gcc -static -O2 -Wall -Wextra -Werror /tmp/openteam-memory-init.c -o /openteam-memory-init \
  && gcc -static -O2 -Wall -Wextra -Werror /tmp/openteam-desktop-exec.c -o /openteam-desktop-exec

FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    antiword \
    chromium \
    curl \
    dbus-x11 \
    fonts-dejavu-core \
    fonts-liberation \
    fonts-noto-core \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    fonts-urw-base35 \
    ffmpeg \
    gcc \
    gh \
    git \
    imagemagick \
    jq \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    libreoffice-draw \
    mousepad \
    mupdf \
    nodejs \
    npm \
    file \
    novnc \
    poppler-utils \
    python3-openpyxl \
    python3-pip \
    python3-reportlab \
    python3-venv \
    python-is-python3 \
    ripgrep \
    sudo \
    thunar \
    tesseract-ocr \
    tesseract-ocr-eng \
    tini \
    unzip \
    zip \
    websockify \
    wget \
    x11-xserver-utils \
    x11vnc \
    xclip \
    xdotool \
    xdg-utils \
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
  && groupadd --gid 998 orbitd \
  && usermod --append --groups orbitd box \
  && mkdir -p /app/apps/computer/dist /workspace /home/box/.pi/agent \
  && mv /usr/bin/chromium /usr/local/bin/google-chrome \
  && chown -R box:box /app /workspace /home/box

COPY --from=ghcr.io/astral-sh/uv:0.8.14 /uv /uvx /usr/local/bin/

# Office toolkit for the knowledgeWork worker's deck skills, at the path those
# skills name, with the libraries they expect. docker/officekit-ts is a copy
# without the deck template library; docker/officekit-ts.sha256.json lists its
# files and that change.
COPY docker/officekit-ts /opt/sand/sand-host/officekit-ts
RUN npm install --global --no-audit --no-fund pptxgenjs@4.0.1 docx@9.8.1 \
  && npm install --prefix /opt/sand/sand-host/officekit-ts --no-audit --no-fund --omit=dev sharp@0.35.5 libxml2-wasm@0.7.2 \
  && chmod 0755 /opt/sand/sand-host/officekit-ts/bin/office \
  && pip install --break-system-packages --no-cache-dir \
    python-pptx==1.0.2 python-docx==1.2.0 openpyxl==3.1.5 xlsxwriter==3.2.9 \
    "markitdown[pptx,docx,xlsx]==0.1.7" pandas==3.0.6 pillow==12.3.0 lxml==6.1.3 \
  && rm -rf /root/.npm /root/.cache
# Skills require("pptxgenjs") from any folder.
ENV NODE_PATH=/usr/local/lib/node_modules

COPY --from=build --chown=box:box /app/node_modules /app/node_modules
COPY --from=build --chown=box:box /app/apps/computer/node_modules /app/apps/computer/node_modules
COPY --from=build --chown=box:box /app/apps/computer/dist/main.js /app/apps/computer/dist/main.js
COPY --from=build --chown=box:box /app/apps/computer/dist/provider-cli.js /app/apps/computer/dist/provider-cli.js
COPY --from=memory-tools /openteam-memory-init /openteam-desktop-exec /usr/local/bin/
COPY docker/openteam-memory-setup.py /usr/local/bin/openteam-memory-setup.py
COPY --chown=box:box docker/computer-entrypoint.sh /usr/local/bin/openteam-computer-entrypoint
COPY --chown=box:box docker/openteam-pi-auth /usr/local/bin/openteam-pi-auth
COPY --chown=box:box docker/desktop /usr/share/openteam-desktop
COPY --chown=box:box docker/openteam-screen-launch /usr/local/bin/openteam-screen-launch
COPY --chown=box:box docker/openteam-browser /usr/bin/chromium
COPY --chown=box:box docker/openteam-vnc.html /usr/share/novnc/openteam.html
COPY --from=desktop-assets /openteam-wallpaper.png /usr/share/openteam-desktop/wallpaper.png
RUN chmod 0755 \
    /usr/bin/chromium \
    /usr/local/bin/openteam-computer-entrypoint \
    /usr/local/bin/openteam-pi-auth \
    /usr/local/bin/openteam-screen-launch

# GTK/Chromium must decode native chooser filenames as UTF-8. Without a
# locale, non-ASCII paths can become empty/unreadable File objects. A runtime
# LANG or LC_* override still takes precedence over this image default.
ENV LANG=C.UTF-8
ENV HOME=/home/box
ENV OPENTEAM_PI_AGENT_DIR=/home/box/.pi/agent
WORKDIR /workspace
USER root:box
EXPOSE 8790 6200-6299
ENTRYPOINT ["tini", "--", "openteam-computer-entrypoint"]
CMD ["bun", "/app/apps/computer/dist/main.js"]
