-- AlterEnum
ALTER TYPE "LinkSource" ADD VALUE 'CFX';

-- AlterTable
ALTER TABLE "game_identities" ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "cfx_link_attempts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "browserSecretHash" TEXT NOT NULL,
    "privateKeyEnc" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "cfxUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdIpHash" TEXT,

    CONSTRAINT "cfx_link_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cfx_link_attempts_userId_createdAt_idx" ON "cfx_link_attempts"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "cfx_link_attempts_expiresAt_idx" ON "cfx_link_attempts"("expiresAt");

-- AddForeignKey
ALTER TABLE "cfx_link_attempts" ADD CONSTRAINT "cfx_link_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
