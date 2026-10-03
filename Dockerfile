# ============================================================================
#  TeleTimeTracker — imagen unica (Backend Fastify + Panel React + Bot Telegram)
#  Multi-stage:
#    1) deps     -> instala dependencias de todo el monorepo (npm workspaces)
#    2) build    -> compila el backend (tsc) y el panel web (Vite)
#    3) runner   -> imagen final ligera (node:20-alpine) con solo lo necesario
# ============================================================================

# ---------------------------------------------------------------------------
# 1) Dependencias
# ---------------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app

# OpenSSL es requerido por el motor de Prisma en Alpine.
RUN apk add --no-cache openssl libc6-compat

# Manifiestos primero: aprovecha la cache de capas de Docker.
COPY package.json package-lock.json* ./
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json

RUN npm install --include=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# 2) Compilacion
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig.json tsconfig.server.json ./
COPY shared ./shared
COPY server ./server
COPY web ./web

# Prisma Client: se generan los DOS motores. La imagen se queda con SQLite (modo
# por defecto) y guarda el de MySQL en /prisma-client-mysql; el arranque copia el
# que corresponda segun DATABASE_URL, sin necesidad de regenerar ni de red.
RUN mkdir -p /tmp/prisma-mysql \
 && npx prisma generate --schema=server/prisma/schema.mysql.prisma \
 && cp -r node_modules/.prisma/client/. /tmp/prisma-mysql/ \
 && npx prisma generate --schema=server/prisma/schema.prisma \
 && npm run build:server \
 && npm run build:web

# ---------------------------------------------------------------------------
# 3) Runtime
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    HOST=0.0.0.0 \
    PORT=8080

RUN apk add --no-cache openssl libc6-compat tini \
 && mkdir -p /app/data

# Dependencias de produccion + CLI de Prisma (necesario para migrar al arrancar).
# --include=dev trae el CLI de prisma para poder hacer "migrate deploy" en runtime.
COPY --from=deps /app/node_modules ./node_modules

# IMPORTANTE: el cliente generado por "prisma generate" vive en node_modules/.prisma
# y en @prisma/client, que en la etapa de deps solo contienen stubs. Sin estas dos
# copias el runtime falla con "@prisma/client did not initialize yet".
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client
# Respaldo del cliente generado para MySQL (ver etapa de build).
COPY --from=build /tmp/prisma-mysql ./prisma-client-mysql

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/prisma ./server/prisma
COPY --from=build /app/web/dist ./web/dist

# El seed compilado vive en dist/server/prisma/seed.js y el esquema en server/prisma.
VOLUME ["/app/data"]

EXPOSE 8080

# tini como PID 1 para reenviar senales correctamente (SIGTERM en deploy).
ENTRYPOINT ["/sbin/tini", "--"]

# Healthcheck usando el endpoint /health del backend.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/src/index.js"]
