# syntax=docker/dockerfile:1

# ---- Build ------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- Runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim

# Compilers and interpreters for user code. prlimit/unshare come from
# util-linux, which is part of the base image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     python3 gcc g++ libc6-dev openjdk-17-jdk-headless ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

# Submitted programs run as this unprivileged user, never as root.
RUN groupadd --gid 10001 runner \
  && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin runner

# A few popular npm packages user programs can require/import. Each run lives
# in /sandbox/runs/<id>, so Node finds these in /sandbox/node_modules.
WORKDIR /sandbox
RUN npm init -y >/dev/null \
  && npm install --omit=dev --no-audit --no-fund lodash dayjs uuid date-fns ramda moment validator \
  && rm -f package.json package-lock.json \
  && mkdir -p /sandbox/runs \
  && chmod 711 /sandbox/runs

WORKDIR /app
ENV NODE_ENV=production \
    PORT=4000 \
    EXEC_UID=10001 \
    EXEC_GID=10001 \
    EXEC_WORKDIR=/sandbox/runs

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini runs as PID 1 and reaps orphaned processes left behind by user code;
# unreaped zombies would otherwise count against the runner's process limit.
ENTRYPOINT ["/usr/bin/tini", "--"]
# The server itself stays root so it can drop privileges for each run.
CMD ["node", "dist/index.js"]
