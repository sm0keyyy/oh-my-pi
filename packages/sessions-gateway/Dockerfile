FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY patches/ ./patches/
COPY packages/sessions-gateway/package.json ./packages/sessions-gateway/package.json
COPY packages/utils/package.json ./packages/utils/package.json
COPY packages/natives/package.json ./packages/natives/package.json
RUN bun install --filter @oh-my-pi/sessions-gateway --frozen-lockfile --production --ignore-scripts --linker=hoisted
COPY packages/sessions-gateway/src/ ./packages/sessions-gateway/src/
COPY packages/utils/src/ ./packages/utils/src/
COPY packages/natives/native/ ./packages/natives/native/
COPY packages/coding-agent/src/modes/rpc/rpc-frame.ts ./packages/coding-agent/src/modes/rpc/rpc-frame.ts
RUN bun build --target=bun packages/sessions-gateway/src/server.ts --outfile=/app/server.js

FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f
WORKDIR /app
COPY --from=build /app/server.js ./server.js
COPY packages/sessions-web/dist/ ./site/
COPY LICENSE THIRD-PARTY-NOTICES.txt ./
ENV SITE_DIR=/app/site BRIDGE_TOKEN_FILE=/run/secrets/bridge-token
USER bun
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD bun -e 'const r = await fetch("http://127.0.0.1:8080/healthz"); process.exit(r.ok ? 0 : 1)'
CMD ["bun", "server.js"]
