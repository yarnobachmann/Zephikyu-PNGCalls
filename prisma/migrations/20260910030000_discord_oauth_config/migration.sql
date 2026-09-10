CREATE TABLE "DiscordOAuthConfig" (
  "id" INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
  "clientId" TEXT NOT NULL,
  "clientSecretEncrypted" TEXT NOT NULL,
  "updatedAt" DATETIME NOT NULL
);
