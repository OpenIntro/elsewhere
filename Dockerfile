# Elsewhere: one-port production server (client build + REST API + websocket).
#
#   docker build -t elsewhere .
#   docker run -p 2567:2567 -e SESSION_SECRET=$(openssl rand -hex 32) -v elsewhere-data:/data elsewhere
#
# Persistence: embedded PGlite in /data/pglite (mount a volume), or set DATABASE_URL for Postgres/Supabase.

ARG NODE_IMAGE=node:22-bookworm-slim

# --- build -------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --no-audit --no-fund
COPY shared shared
COPY server server
COPY client client
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# --- runtime -----------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=2567 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/shared/package.json shared/
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/package.json client/
COPY --from=build /app/client/dist client/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 2567
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||2567)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
