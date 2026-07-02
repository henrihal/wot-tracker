# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project shape

Single package in `server/` (no root workspace). All commands below run from `server/`, not the repo root.

## Commands

```bash
npm run dev      # tsx watch, auto-loads .env (--env-file-if-exists). Default PORT=5001.
npm run build    # tsc --build
npm test         # placeholder, no tests yet
npx prisma migrate dev --name <name>   # create+apply migration (reads prisma.config.ts)
npx prisma generate                     # regenerate client into generated/prisma
npx tsc --noEmit                        # typecheck without emitting
npx eslint .        # lint (no npm script wired)
npx prettier --check .   # format check (no npm script wired)
```

## Architecture

Express app (`src/app.ts`) with routes defined inline; shared infrastructure lives in `src/lib/`. Two lib clients today:

- `lib/prisma.ts` — singleton `PrismaClient` using the `@prisma/adapter-better-sqlite3` adapter. Imports the generated client from `../../generated/prisma/client.js`.
- `lib/wargaming.ts` — caching middleman for the Wargaming `account/list` API. `searchPlayers(search, { forceRefresh })` checks a Prisma-backed cache (`PlayerSearchCache`, keyed by `[search, realm]`) and only caches `status: "ok"` responses; errors are always re-fetched. Realm/app id/TTL come from env.

### Prisma setup (non-default)

- Prisma **7** with a TypeScript config file `prisma.config.ts` (not just a schema). The datasource URL is read from there, which itself loads `dotenv/config` — so Prisma CLI commands pick up `DATABASE_URL` from `.env` automatically.
- Generator output is `generated/prisma` (gitignored). After any schema change, run `prisma migrate dev` (which applies + generates) or `prisma generate` to regenerate; the app imports the generated client directly, so a stale `generated/` dir causes build/runtime errors.
- Datasource is SQLite (`file:./dev.db`); `*.db` files are gitignored.

### Environment

`.env` is loaded via `dotenv/config` imported at the top of `app.ts`, `lib/prisma.ts`, and `lib/wargaming.ts`. Required vars: `DATABASE_URL`, `WARGAMING_APPLICATION_ID`, `WARGAMING_REALM` (default `eu`), `WARGAMING_CACHE_TTL_SECONDS` (default `3600`). `lib/wargaming.ts` **throws at import time** if `WARGAMING_APPLICATION_ID` is unset, so the server won't boot without it. Note NA realm maps to `api.worldoftanks.com` (not `.na`).

## TypeScript conventions (strict, easy to trip on)

`tsconfig.json` enables `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and `verbatimModuleSyntax`:

- **`verbatimModuleSyntax`**: use `import type` for type-only imports; never mix a value and type in one import without the `type` modifier on the type.
- **`noUncheckedIndexedAccess`**: indexing an array/record yields `T | undefined`; guard or narrow.
- **`exactOptionalPropertyTypes`**: don't assign `undefined` to an optional property expecting a value — either omit the key or provide a real value.
- ESM (`"type": "module"`, `moduleResolution: "bundler"`): relative imports use explicit `.js` extensions (see existing `import { prisma } from "./lib/prisma.js"`).

## Style

Prettier: no semicolons, single quotes, 2-space indent, trailing commas (es5). ESLint enforces `semi: "error"` (meaning **no** semicolons) and `prefer-const`. Match the surrounding no-semicolon style.