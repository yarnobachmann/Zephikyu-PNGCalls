import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
console.log(JSON.stringify({
  owners: await prisma.owner.findMany({ select: { username: true, createdAt: true } }),
  rooms: await prisma.room.findMany({ select: { id: true, name: true, createdAt: true } }),
  hostSessions: await prisma.hostSession.count(),
}, null, 2));
await prisma.$disconnect();
