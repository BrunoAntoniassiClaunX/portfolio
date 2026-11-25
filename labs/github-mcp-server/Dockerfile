# GitHub MCP server: stdio only. No ports, no HTTP server.
# Run with:  docker run -i --rm github-mcp-server:local
# (-i keeps stdin open; MCP messages travel over stdin/stdout.)

# Base image pinned by version and digest, so every build starts from the
# same bytes. Same Node.js version as development (24.15.0).
FROM node:24.15.0-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first: this layer is rebuilt only when the manifest or lockfile
# changes. `npm ci` installs exactly what package-lock.json records;
# --omit=dev leaves out the test-only MCP client; --ignore-scripts skips
# install hooks from dependencies.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Application code: the three source files, named explicitly. Files stay owned
# by root, so the runtime user can read but not modify them.
COPY src/index.js src/server.js src/github.js ./src/

# Run as the unprivileged `node` user (uid 1000) that the base image provides.
USER node

# Exec form: node is PID 1 and receives SIGTERM from `docker stop` directly;
# src/index.js handles it and exits with code 0.
ENTRYPOINT ["node", "src/index.js"]
