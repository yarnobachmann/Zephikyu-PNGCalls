ALTER TABLE "Player" ADD COLUMN "mediaMode" TEXT NOT NULL DEFAULT 'png';
CREATE TABLE "DiscordConnection" (
  "id" INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
  "discordUserId" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "connectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "DiscordConnection_discordUserId_key" ON "DiscordConnection"("discordUserId");
