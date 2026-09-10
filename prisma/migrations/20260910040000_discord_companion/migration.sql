ALTER TABLE "Room" ADD COLUMN "companionTokenHash" TEXT;
ALTER TABLE "Room" ADD COLUMN "companionLastSeen" DATETIME;
ALTER TABLE "Room" ADD COLUMN "discordChannelId" TEXT;
ALTER TABLE "Room" ADD COLUMN "discordChannelName" TEXT;
CREATE UNIQUE INDEX "Room_companionTokenHash_key" ON "Room"("companionTokenHash");

ALTER TABLE "DiscordConnection" ADD COLUMN "accessTokenEncrypted" TEXT;
ALTER TABLE "DiscordConnection" ADD COLUMN "refreshTokenEncrypted" TEXT;
ALTER TABLE "DiscordConnection" ADD COLUMN "tokenExpiresAt" DATETIME;
ALTER TABLE "DiscordConnection" ADD COLUMN "scopes" TEXT NOT NULL DEFAULT '';
