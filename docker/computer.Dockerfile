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
    tzdata \
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
  && mkdir -p /app/apps/computer/dist /workspace /home/box/.pi/agent /usr/lib/openteam/bin \
  && mv /usr/bin/chromium /usr/lib/openteam/bin/google-chrome \
  && mv /usr/local/bin/bun /usr/lib/openteam/bin/bun \
  && ln -s bun /usr/lib/openteam/bin/bunx \
  && rm -rf /usr/local/bin/bunx /usr/local/bin/docker-entrypoint.sh /usr/local/bun-node-fallback-bin \
  && chown -R box:box /app /workspace /home/box

# OpenTeam's own tools and libraries live in /usr/lib/openteam. /usr/local is
# a volume the bots install into, so the image ships nothing there.
COPY --from=ghcr.io/astral-sh/uv:0.8.14 /uv /uvx /usr/lib/openteam/bin/

# Office toolkit for the knowledgeWork worker's deck skills, at the path those
# skills name, with the libraries they expect. docker/officekit-ts is a copy
# without the deck template library; docker/officekit-ts.sha256.json lists its
# files and that change.
COPY docker/officekit-ts /opt/sand/sand-host/officekit-ts
# Every Python finds the image's packages ahead of /usr/local and ~/.local
# (openteam.pth), so an update's versions are the ones skills get.
RUN npm install --global --prefix /usr/lib/openteam/node --no-audit --no-fund pptxgenjs@4.0.1 docx@9.8.1 \
  && npm install --prefix /opt/sand/sand-host/officekit-ts --no-audit --no-fund --omit=dev sharp@0.35.5 libxml2-wasm@0.7.2 \
  && chmod 0755 /opt/sand/sand-host/officekit-ts/bin/office \
  && pip install --break-system-packages --no-cache-dir --target /usr/lib/openteam/python \
    python-pptx==1.0.2 python-docx==1.2.0 openpyxl==3.1.5 xlsxwriter==3.2.9 \
    "markitdown[pptx,docx,xlsx]==0.1.7" pandas==3.0.6 pillow==12.3.0 lxml==6.1.3 \
  && ln -s /usr/lib/openteam/python/bin/* /usr/lib/openteam/bin/ \
  && printf '%s\n' 'import sys; sys.path.insert(min([i for i, d in enumerate(sys.path) if d.startswith("/usr/local/lib/python") or d == sys.modules["site"].USER_SITE] + [len(sys.path)]), "/usr/lib/openteam/python")' \
    > /usr/lib/python3/dist-packages/openteam.pth \
  && rm -rf /root/.npm /root/.cache

COPY --from=build --chown=box:box /app/node_modules /app/node_modules
COPY --from=build --chown=box:box /app/apps/computer/node_modules /app/apps/computer/node_modules
COPY --from=build --chown=box:box /app/apps/computer/dist/main.js /app/apps/computer/dist/main.js
COPY --from=build --chown=box:box /app/apps/computer/dist/provider-cli.js /app/apps/computer/dist/provider-cli.js
COPY --from=build --chown=box:box /app/apps/computer/dist/installs-cli.js /app/apps/computer/dist/installs-cli.js
COPY --from=memory-tools /openteam-memory-init /openteam-desktop-exec /usr/lib/openteam/bin/
COPY docker/openteam-memory-setup.py /usr/lib/openteam/bin/openteam-memory-setup.py
COPY --chown=box:box docker/computer-entrypoint.sh /usr/lib/openteam/bin/openteam-computer-entrypoint
COPY --chown=box:box docker/openteam-pi-auth /usr/lib/openteam/bin/openteam-pi-auth
COPY docker/openteam-installs /usr/lib/openteam/bin/openteam-installs
COPY docker/openteam-box-timezone /usr/lib/openteam/bin/openteam-box-timezone
COPY --chown=box:box docker/desktop /usr/share/openteam-desktop
COPY --chown=box:box docker/openteam-screen-launch /usr/lib/openteam/bin/openteam-screen-launch
COPY --chown=box:box docker/openteam-browser /usr/bin/chromium
COPY --chown=box:box docker/openteam-vnc.html /usr/share/novnc/openteam.html
COPY --from=desktop-assets /openteam-wallpaper.png /usr/share/openteam-desktop/wallpaper.png
RUN chmod 0755 \
    /usr/bin/chromium \
    /usr/lib/openteam/bin/openteam-computer-entrypoint \
    /usr/lib/openteam/bin/openteam-pi-auth \
    /usr/lib/openteam/bin/openteam-installs \
    /usr/lib/openteam/bin/openteam-box-timezone \
    /usr/lib/openteam/bin/openteam-screen-launch

# Bots find the image's tools by name through /usr/bin. Everything they
# install outside the home folder goes to the /usr/local volume, except apt
# packages, which are recorded and reinstalled at start (apps/computer/src/apt-packages.ts).
COPY docker/apt-keep-installs.conf /etc/apt/apt.conf.d/90openteam-keep-installs
COPY docker/dpkg-keep-installs.cfg /etc/dpkg/dpkg.cfg.d/openteam-keep-installs
# Like bot shells (apps/computer/src/agent-process.ts), sudo finds the image's tools before a
# same-named copy in /usr/local.
# Login shells (sudo -i, su -, bash -l) take PATH from /etc/profile and su's from login.defs.
RUN printf 'Defaults secure_path="/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/sbin:/usr/local/bin"\n' > /etc/sudoers.d/openteam-paths \
  && chmod 0440 /etc/sudoers.d/openteam-paths \
  && sed -i \
    -e 's#PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"#PATH="/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/sbin:/usr/local/bin"#' \
    -e 's#PATH="/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games"#PATH="/usr/bin:/bin:/usr/local/bin:/usr/local/games:/usr/games"#' \
    /etc/profile \
  && sed -i -E \
    -e 's#^(ENV_SUPATH\s+PATH=).*#\1/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/sbin:/usr/local/bin#' \
    -e 's#^(ENV_PATH\s+PATH=).*#\1/usr/bin:/bin:/usr/local/bin:/usr/local/games:/usr/games#' \
    /etc/login.defs \
  && for shell in "su - root" "su - box"; do \
    case ":$($shell -c 'echo $PATH'):" in *:/usr/local/bin:*:/usr/bin:*|*:/usr/local/sbin:*:/usr/sbin:*) echo "$shell searches /usr/local first" >&2; exit 1 ;; esac; \
  done
ENV PATH=/usr/lib/openteam/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV NODE_PATH=/usr/lib/openteam/node/lib/node_modules
ENV BUN_INSTALL_BIN=/home/box/.bun/bin

# GTK/Chromium must decode native chooser filenames as UTF-8. Without a
# locale, non-ASCII paths can become empty/unreadable File objects. A runtime
# LANG or LC_* override still takes precedence over this image default.
ENV LANG=C.UTF-8
ENV HOME=/home/box
ENV OPENTEAM_PI_AGENT_DIR=/home/box/.pi/agent
WORKDIR /workspace
USER root:box
EXPOSE 8790 6200-6299
# Keep this last: the baselines describe the finished image, and the build id
# changes whenever anything above does.
RUN for tool in /usr/lib/openteam/bin/*; do [ -e "/usr/bin/${tool##*/}" ] || ln -s "$tool" /usr/bin/; done \
  && mkdir -p /usr/share/openteam \
  && dpkg-query -W -f='${Package}\n' | sort > /usr/share/openteam/apt-baseline \
  && find /etc/apt/sources.list /etc/apt/sources.list.d /etc/apt/keyrings /etc/apt/trusted.gpg /etc/apt/trusted.gpg.d \
    /etc/apt/preferences.d /usr/share/keyrings -type f 2>/dev/null | sort > /usr/share/openteam/apt-sources-baseline \
  && if find /usr/local -mindepth 1 ! -type d ! -path /usr/local/man | grep .; then echo "the image must ship no files in /usr/local" >&2; exit 1; fi \
  && cat /proc/sys/kernel/random/uuid > /usr/lib/openteam/build-id
ENTRYPOINT ["tini", "--", "/usr/lib/openteam/bin/openteam-computer-entrypoint"]
CMD ["/usr/lib/openteam/bin/bun", "/app/apps/computer/dist/main.js"]
