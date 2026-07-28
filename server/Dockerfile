# syntax=docker/dockerfile:1

# ---- build stage ----
# Compile TS -> dist/ with tsc. The Prisma client is generated with
# importFileExtension = "js" (see prisma/schema.prisma), so its internal imports
# are `.js`-suffixed; tsc emits them unchanged and plain `node` resolves them to
# the compiled output. No tsx/loader hook is needed at runtime.
FROM node:22-alpine AS build
WORKDIR /app

# Install dependencies first so this layer is cached across source changes.
COPY package.json package-lock.json ./
RUN npm ci

# Source, Prisma schema/config, and tsconfig. `prisma generate` materializes the
# gitignored generated client (output: generated/prisma) before tsc compiles it.
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY tsconfig.json ./
COPY src ./src
RUN npx prisma generate
RUN npm run build

# ---- runtime stage ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5001

# Production dependencies only, plus the Prisma CLI for `migrate deploy` at start.
# tsx is NOT needed: the app runs as compiled JS via plain `node`.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install --no-save prisma

# Compiled app + generated client, and the schema/migrations + config for migrate.
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts

EXPOSE 5001

# Apply migrations (retry until the DB is reachable) then start the server.
CMD ["sh", "-c", "until npx prisma migrate deploy; do echo 'prisma migrate deploy failed, retrying in 5s'; sleep 5; done && node dist/src/app.js"]
