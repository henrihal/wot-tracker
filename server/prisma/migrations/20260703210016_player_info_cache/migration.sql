-- CreateTable
CREATE TABLE "PlayerInfoCache" (
    "accountId" INTEGER NOT NULL,
    "realm" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("accountId", "realm")
);

-- CreateIndex
CREATE INDEX "PlayerInfoCache_fetchedAt_idx" ON "PlayerInfoCache"("fetchedAt");
