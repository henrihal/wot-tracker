-- CreateTable
CREATE TABLE "Vehicle" (
    "tankId" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "shortName" TEXT NOT NULL,
    "nation" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "isPremium" BOOLEAN NOT NULL,
    "tag" TEXT,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "VehicleExpectedValue" (
    "tankId" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "expFrag" REAL NOT NULL,
    "expDamage" REAL NOT NULL,
    "expSpot" REAL NOT NULL,
    "expDef" REAL NOT NULL,
    "expWinRate" REAL NOT NULL,
    "version" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PlayerVehicleStatsCache" (
    "accountId" INTEGER NOT NULL,
    "realm" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,

    PRIMARY KEY ("accountId", "realm")
);

-- CreateTable
CREATE TABLE "PlayerVehicleSnapshot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "accountId" INTEGER NOT NULL,
    "realm" TEXT NOT NULL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "data" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "PlayerVehicleStatsCache_expiresAt_idx" ON "PlayerVehicleStatsCache"("expiresAt");

-- CreateIndex
CREATE INDEX "PlayerVehicleSnapshot_accountId_realm_capturedAt_idx" ON "PlayerVehicleSnapshot"("accountId", "realm", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerVehicleSnapshot_accountId_realm_capturedAt_key" ON "PlayerVehicleSnapshot"("accountId", "realm", "capturedAt");
