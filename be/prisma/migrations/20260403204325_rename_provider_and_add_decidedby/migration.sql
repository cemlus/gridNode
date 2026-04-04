/*
  Warnings:

  - You are about to drop the column `ownerId` on the `Job` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "Job" DROP CONSTRAINT "Job_ownerId_fkey";

-- DropIndex
DROP INDEX "Job_ownerId_idx";

-- DropIndex
DROP INDEX "Machine_userKey_key";

-- AlterTable
ALTER TABLE "Job" DROP COLUMN "ownerId",
ADD COLUMN     "decidedById" TEXT,
ADD COLUMN     "providerId" TEXT;

-- CreateIndex
CREATE INDEX "Job_providerId_idx" ON "Job"("providerId");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
