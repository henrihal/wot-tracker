-- CreateTable
CREATE TABLE "PlayerSearchCache" (
    "search" TEXT NOT NULL,
    "realm" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,

    PRIMARY KEY ("search", "realm")
);

-- CreateIndex
CREATE INDEX "PlayerSearchCache_expiresAt_idx" ON "PlayerSearchCache"("expiresAt");
