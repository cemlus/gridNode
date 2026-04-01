-- AlterTable
ALTER TABLE "user" ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'requester';

-- CreateTable
CREATE TABLE "Machine" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "cpuTotal" INTEGER NOT NULL,
    "memoryTotal" INTEGER NOT NULL,
    "gpuTotal" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'idle',

    CONSTRAINT "Machine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "ownerId" TEXT,
    "machineId" TEXT,
    "repoUrl" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "datasetUri" TEXT,
    "cpuRequired" INTEGER NOT NULL,
    "memoryRequired" INTEGER NOT NULL,
    "gpuRequired" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_approval',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
