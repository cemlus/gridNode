/*
  Warnings:

  - The values [notebook,video] on the enum `JobType` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "JobType_new" AS ENUM ('ml_notebook', 'video_render', 'server_run', 'data_processing');
ALTER TABLE "public"."Job" ALTER COLUMN "type" DROP DEFAULT;
ALTER TABLE "Job" ALTER COLUMN "type" TYPE "JobType_new" USING ("type"::text::"JobType_new");
ALTER TYPE "JobType" RENAME TO "JobType_old";
ALTER TYPE "JobType_new" RENAME TO "JobType";
DROP TYPE "public"."JobType_old";
ALTER TABLE "Job" ALTER COLUMN "type" SET DEFAULT 'ml_notebook';
COMMIT;

-- AlterTable
ALTER TABLE "Job" ALTER COLUMN "type" SET DEFAULT 'ml_notebook';
