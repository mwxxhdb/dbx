# syntax=docker/dockerfile:1

# Stage 1: Build frontend (native, no emulation)
FROM --platform=$BUILDPLATFORM node:22-slim AS frontend
WORKDIR /app
RUN npm i -g pnpm
# Keep the workspace package available because Vite resolves it directly from source.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/mongo-shell/ packages/mongo-shell/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY apps/desktop/ apps/desktop/
# The vite connection-types plugin runs scripts/sync-connection-types.mjs during
# `pnpm build`, which reads plugins/connection-types + plugins/dialects and
# regenerates the manifest and generated TS types in place.
COPY scripts/ scripts/
COPY plugins/ plugins/
COPY crates/dbx-core/assets/database-drivers.manifest.json crates/dbx-core/assets/database-drivers.manifest.json
RUN pnpm build

# Stage 2: Cross-compile Rust backend for the requested platform (native, no emulation)
FROM --platform=$BUILDPLATFORM rust:1-bookworm AS backend
ARG TARGETARCH
WORKDIR /app
# dbx-custom:start(china-mirrors) —— 见 CUSTOMIZATIONS.md
# RUN 步骤没有代理。builder 的 driver-opt env.HTTP_PROXY 只作用于 buildkitd 自己拉
# 基础镜像，不注入 RUN——实测 RUN 里 `env | grep -i proxy` 是空的。所以每一次
# apt / cargo / pip 都是直连，而直连 deb.debian.org 是 900ms 级延迟（实测一次 apt
# 装包跑了 939 秒），static.crates.io 更是完全不通，cargo 会卡在 0 字节然后报
# `transfer too slow`。换国内源就是为了解决这个，与代理无关。
#
# 必须重写成 http 而不是 https：最终镜像 debian:bookworm-slim 不带 ca-certificates
# （它正是在改完源后的这条 apt 里才装上的），换成 https 会让 apt 直接报
# `No system certificates available`。Debian 仓库本身有签名、apt 会验签，http 就是
# 基础镜像出厂时用的方案。
#
# 下面那条 rewritten 校验不是可有可无：sed 没匹配上不会报错，构建会静默退回直连、
# 慢到看起来像卡死。宁可在这里硬失败。
# 注意所有说明都写在 RUN 外面——RUN 的 \ 续行会把多行拼成一条 shell 命令，行内
# 的 # 注释会把后面的内容一起吞掉。
RUN set -eux; \
    rewritten=0; \
    for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list; do \
      [ -f "$f" ] || continue; \
      sed -i -e 's|https\?://deb\.debian\.org|http://mirrors.ustc.edu.cn|g' \
             -e 's|https\?://security\.debian\.org|http://mirrors.ustc.edu.cn|g' "$f"; \
      if grep -q 'mirrors\.ustc\.edu\.cn' "$f"; then rewritten=1; fi; \
    done; \
    [ "$rewritten" = 1 ] || { echo "apt sources 未被改写——基础镜像的源文件布局变了，见 CUSTOMIZATIONS.md china-mirrors" >&2; exit 1; }
# dbx-custom:end
# dbx-custom:start(china-mirrors) —— 见 CUSTOMIZATIONS.md
# ziglang 是 97.9MB 的 wheel，pypi 直连很慢。用环境变量而不是给下面 pip3 那行补
# -i，是为了不动上游那条 RUN。
ENV PIP_INDEX_URL=https://mirrors.ustc.edu.cn/pypi/simple
# cargo 的 source replacement 必须在任何 cargo 联网之前落地。rsproxy 的
# config.json 里 dl 指向自己（实测 {"dl":"https://rsproxy.cn/api/v1/crates",...}），
# 所以 index 和 crate 下载都不再碰不通的 static.crates.io。
# 基础镜像目前不带 cargo 配置。哪天它带了，宁可在这里停下来手工合并，也不要悄悄
# 覆盖掉——所以下面先检查再写。
RUN set -eux; \
    CH="${CARGO_HOME:-/usr/local/cargo}"; \
    if [ -e "$CH/config.toml" ] || [ -e "$CH/config" ]; then \
      echo "基础镜像已自带 cargo 配置，需手工合并，见 CUSTOMIZATIONS.md china-mirrors" >&2; \
      exit 1; \
    fi; \
    mkdir -p "$CH"; \
    printf '%s\n' \
      '[source.crates-io]' \
      'replace-with = "ustc-rsproxy"' \
      '' \
      '[source.ustc-rsproxy]' \
      'registry = "sparse+https://rsproxy.cn/index/"' \
      '' \
      '[net]' \
      'retry = 10' \
      > "$CH/config.toml"
# dbx-custom:end
# dbx-custom(china-mirrors): 下面这条 RUN 的 --mount 是本 fork 加的。上游给 pnpm 挂了
# cache mount，却从没给 cargo 挂过，所以失败重试要从零重下全部 crate。只挂 registry
# 和 git 两个下载缓存，不能挂整个 CARGO_HOME：cargo install 装出的 cargo-zigbuild 在
# $CARGO_HOME/bin，那个必须留在镜像层里。
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    dpkg --add-architecture arm64 \
    && apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake pkg-config perl python3-pip gcc-aarch64-linux-gnu \
    libfontconfig-dev:arm64 libfreetype-dev:arm64 \
    && pip3 install --break-system-packages ziglang \
    && cargo install cargo-zigbuild \
    && rustup target add x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency manifests only and create dummy sources to pre-compile dependencies.
# This layer is cached by GHA as long as Cargo.toml/Cargo.lock don't change.
COPY Cargo.toml Cargo.lock ./
COPY crates/dbx-core/Cargo.toml crates/dbx-core/
COPY crates/dbx-web/Cargo.toml crates/dbx-web/
COPY crates/dbx-mcp/Cargo.toml crates/dbx-mcp/
COPY crates/dbx-cli/Cargo.toml crates/dbx-cli/
COPY src-tauri/Cargo.toml src-tauri/
# Copy every vendored crate: root Cargo.toml [patch.crates-io] points at
# vendor/{ctor,rumqttc,dirs-sys,pageant,wry}; omitting any breaks the offline build.
COPY vendor/ vendor/
RUN mkdir -p crates/dbx-core/src && echo '' > crates/dbx-core/src/lib.rs \
    && mkdir -p crates/dbx-web/src && echo 'fn main() {}' > crates/dbx-web/src/main.rs \
    && mkdir -p crates/dbx-mcp/src && echo '' > crates/dbx-mcp/src/lib.rs && echo 'fn main() {}' > crates/dbx-mcp/src/main.rs \
    && mkdir -p crates/dbx-cli/src && echo 'fn main() {}' > crates/dbx-cli/src/main.rs \
    && mkdir -p src-tauri/src && echo 'fn main() {}' > src-tauri/src/main.rs && echo 'pub fn run() {}' > src-tauri/src/lib.rs

COPY src-tauri/build.rs src-tauri/
COPY src-tauri/tauri.conf.json src-tauri/

# dbx-custom(china-mirrors): --mount 由本 fork 添加，理由同上。这里多挂了 /app/target
# ——依赖编译是整个构建里最耗 CPU 的一步，挂上之后重复构建不必重编。
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/app/target,sharing=locked \
    case "$TARGETARCH" in \
      amd64) rust_target=x86_64-unknown-linux-gnu; lib_arch=x86_64-linux-gnu ;; \
      arm64) rust_target=aarch64-unknown-linux-gnu; lib_arch=aarch64-linux-gnu ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac && \
    LIBRARY_PATH="/usr/lib/$lib_arch" \
    PKG_CONFIG_PATH="/usr/lib/$lib_arch/pkgconfig" \
    PKG_CONFIG_SYSROOT_DIR="/" \
    RUSTFLAGS="-L native=/usr/lib/$lib_arch" \
    cargo zigbuild --release -p dbx-web --target "$rust_target" || true

# Copy real sources and rebuild (only application code recompiles)
COPY crates/ crates/
# dbx-core's build.rs embeds plugins/dialects (SQL dialects) and
# plugins/connection-types (database manifest + DatabaseType enum);
# either directory missing makes the build script panic.
COPY plugins/dialects/ plugins/dialects/
COPY plugins/connection-types/ plugins/connection-types/

# Docker COPY preserves original file timestamps, which may be older than the
# dummy-source binary compiled above. Touch all .rs files so cargo detects the
# source change and recompiles instead of reusing the dummy binary.
RUN find crates/ -name '*.rs' -exec touch {} +

# dbx-custom(china-mirrors): --mount 由本 fork 添加，理由同上。注意 /app/target 是
# cache mount，不在镜像层里——下面那条 cp 必须留在这条 RUN 内部，把二进制复制到
# /out（真实层）。把 cp 拆成单独的 RUN 会拿不到 target/ 的内容。
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/app/target,sharing=locked \
    case "$TARGETARCH" in \
      amd64) rust_target=x86_64-unknown-linux-gnu; lib_arch=x86_64-linux-gnu ;; \
      arm64) rust_target=aarch64-unknown-linux-gnu; lib_arch=aarch64-linux-gnu ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac && \
    LIBRARY_PATH="/usr/lib/$lib_arch" \
    PKG_CONFIG_PATH="/usr/lib/$lib_arch/pkgconfig" \
    PKG_CONFIG_SYSROOT_DIR="/" \
    RUSTFLAGS="-L native=/usr/lib/$lib_arch" \
    cargo zigbuild --release -p dbx-web --target "$rust_target" && \
    mkdir -p "/out/linux/$TARGETARCH" && \
    cp "/app/target/$rust_target/release/dbx-web" "/out/linux/$TARGETARCH/"

# Stage 3: Final image
FROM debian:bookworm-slim
ARG TARGETPLATFORM
# dbx-custom:start(china-mirrors) —— 见 CUSTOMIZATIONS.md
# RUN 步骤没有代理。builder 的 driver-opt env.HTTP_PROXY 只作用于 buildkitd 自己拉
# 基础镜像，不注入 RUN——实测 RUN 里 `env | grep -i proxy` 是空的。所以每一次
# apt / cargo / pip 都是直连，而直连 deb.debian.org 是 900ms 级延迟（实测一次 apt
# 装包跑了 939 秒），static.crates.io 更是完全不通，cargo 会卡在 0 字节然后报
# `transfer too slow`。换国内源就是为了解决这个，与代理无关。
#
# 必须重写成 http 而不是 https：最终镜像 debian:bookworm-slim 不带 ca-certificates
# （它正是在改完源后的这条 apt 里才装上的），换成 https 会让 apt 直接报
# `No system certificates available`。Debian 仓库本身有签名、apt 会验签，http 就是
# 基础镜像出厂时用的方案。
#
# 下面那条 rewritten 校验不是可有可无：sed 没匹配上不会报错，构建会静默退回直连、
# 慢到看起来像卡死。宁可在这里硬失败。
# 注意所有说明都写在 RUN 外面——RUN 的 \ 续行会把多行拼成一条 shell 命令，行内
# 的 # 注释会把后面的内容一起吞掉。
RUN set -eux; \
    rewritten=0; \
    for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list; do \
      [ -f "$f" ] || continue; \
      sed -i -e 's|https\?://deb\.debian\.org|http://mirrors.ustc.edu.cn|g' \
             -e 's|https\?://security\.debian\.org|http://mirrors.ustc.edu.cn|g' "$f"; \
      if grep -q 'mirrors\.ustc\.edu\.cn' "$f"; then rewritten=1; fi; \
    done; \
    [ "$rewritten" = 1 ] || { echo "apt sources 未被改写——基础镜像的源文件布局变了，见 CUSTOMIZATIONS.md china-mirrors" >&2; exit 1; }
# dbx-custom:end
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fontconfig \
    fonts-dejavu-core \
    libfreetype6 \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*
# dbx-custom:start(no-java) —— 见 CUSTOMIZATIONS.md
# 上游在上面的 apt 列表里还装了 openjdk-17-jre-headless，本 fork 已删除。
# 本部署只用 postgres(native) 与 mongodb(native) 两类驱动，不使用任何
# agent/jdbc 驱动，JRE 从不被拉起。
# fontconfig / fonts-dejavu-core / libfreetype6 不能一起删：它们是
# system-fonts feature（dbx-web 默认开启）链接的 font-kit 所需，与 Java 无关。
# dbx-custom:end
COPY --from=backend /out/${TARGETPLATFORM}/dbx-web /usr/local/bin/
COPY --from=frontend /app/dist /app/static
ENV DBX_STATIC_DIR=/app/static
ENV DBX_DATA_DIR=/app/data
# dbx-custom:start(no-java) —— 见 CUSTOMIZATIONS.md
# 上游此处还有 ENV DBX_JAVA_BIN=/usr/bin/java，本 fork 已删除。
# 必须与上面的 openjdk 一起删，不能只删一个：JRE 不存在时若保留此变量，
# external_driver_runtime_env（crates/dbx-core/src/connection.rs:1246）在
# Managed 模式下返回空 PluginRuntimeEnv，agent 驱动子进程会继承镜像里的
# DBX_JAVA_BIN，去 exec 一个不存在的 /usr/bin/java，报出的错难以定位。
# dbx-custom:end
EXPOSE 4224
CMD ["dbx-web"]
