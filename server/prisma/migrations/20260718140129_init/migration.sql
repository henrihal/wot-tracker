-- CreateTable
CREATE TABLE "PlayerSearchCache" (
    "search" TEXT NOT NULL,
    "realm" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlayerSearchCache_pkey" PRIMARY KEY ("search","realm")
);

-- CreateTable
CREATE TABLE "PlayerInfoCache" (
    "accountId" INTEGER NOT NULL,
    "realm" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlayerInfoCache_pkey" PRIMARY KEY ("accountId","realm")
);

-- CreateTable
CREATE TABLE "PlayerStatsSnapshot" (
    "id" SERIAL NOT NULL,
    "accountId" INTEGER NOT NULL,
    "realm" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastBattleTime" INTEGER,
    "data" TEXT NOT NULL,

    CONSTRAINT "PlayerStatsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackedAccount" (
    "accountId" INTEGER NOT NULL,
    "realm" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackedAccount_pkey" PRIMARY KEY ("accountId","realm")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "tankId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT NOT NULL,
    "nation" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "isPremium" BOOLEAN NOT NULL,
    "tag" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("tankId")
);

-- CreateTable
CREATE TABLE "VehicleExpectedValue" (
    "tankId" INTEGER NOT NULL,
    "expFrag" DOUBLE PRECISION NOT NULL,
    "expDamage" DOUBLE PRECISION NOT NULL,
    "expSpot" DOUBLE PRECISION NOT NULL,
    "expDef" DOUBLE PRECISION NOT NULL,
    "expWinRate" DOUBLE PRECISION NOT NULL,
    "version" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VehicleExpectedValue_pkey" PRIMARY KEY ("tankId")
);

-- CreateTable
CREATE TABLE "PlayerVehicleStatsCache" (
    "accountId" INTEGER NOT NULL,
    "realm" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlayerVehicleStatsCache_pkey" PRIMARY KEY ("accountId","realm")
);

-- CreateTable
CREATE TABLE "PlayerVehicleSnapshot" (
    "id" SERIAL NOT NULL,
    "accountId" INTEGER NOT NULL,
    "realm" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "data" TEXT NOT NULL,

    CONSTRAINT "PlayerVehicleSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlayerSearchCache_expiresAt_idx" ON "PlayerSearchCache"("expiresAt");

-- CreateIndex
CREATE INDEX "PlayerInfoCache_expiresAt_idx" ON "PlayerInfoCache"("expiresAt");

-- CreateIndex
CREATE INDEX "PlayerStatsSnapshot_accountId_realm_capturedAt_idx" ON "PlayerStatsSnapshot"("accountId", "realm", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerStatsSnapshot_accountId_realm_capturedAt_key" ON "PlayerStatsSnapshot"("accountId", "realm", "capturedAt");

-- CreateIndex
CREATE INDEX "PlayerVehicleStatsCache_expiresAt_idx" ON "PlayerVehicleStatsCache"("expiresAt");

-- CreateIndex
CREATE INDEX "PlayerVehicleSnapshot_accountId_realm_capturedAt_idx" ON "PlayerVehicleSnapshot"("accountId", "realm", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerVehicleSnapshot_accountId_realm_capturedAt_key" ON "PlayerVehicleSnapshot"("accountId", "realm", "capturedAt");
