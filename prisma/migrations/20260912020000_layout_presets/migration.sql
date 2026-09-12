CREATE TABLE "LayoutPreset" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "roomId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "data" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "LayoutPreset_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "LayoutPreset_roomId_name_key" ON "LayoutPreset"("roomId", "name");
CREATE INDEX "LayoutPreset_roomId_idx" ON "LayoutPreset"("roomId");
