/*
  Warnings:

  - Added the required column `expiresAt` to the `PlayerInfoCache` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "PlayerStatsSnapshot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "accountId" INTEGER NOT NULL,
    "realm" TEXT NOT NULL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "data" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "TrackedAccount" (
    "accountId" INTEGER NOT NULL,
    "realm" TEXT NOT NULL,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("accountId", "realm")
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PlayerInfoCache" (
    "accountId" INTEGER NOT NULL,
    "realm" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,

    PRIMARY KEY ("accountId", "realm")
);
INSERT INTO "new_PlayerInfoCache" ("accountId", "fetchedAt", "expiresAt", "realm", "response") SELECT "accountId", "fetchedAt", datetime("fetchedAt", '+3600 seconds'), "realm", "response" FROM "PlayerInfoCache";
DROP TABLE "PlayerInfoCache";
ALTER TABLE "new_PlayerInfoCache" RENAME TO "PlayerInfoCache";
CREATE INDEX "PlayerInfoCache_expiresAt_idx" ON "PlayerInfoCache"("expiresAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "PlayerStatsSnapshot_accountId_realm_capturedAt_idx" ON "PlayerStatsSnapshot"("accountId", "realm", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerStatsSnapshot_accountId_realm_capturedAt_key" ON "PlayerStatsSnapshot"("accountId", "realm", "capturedAt");
