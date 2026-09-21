/*
  Warnings:

  - Added the required column `publicIdPrefix` to the `application_templates` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "application_templates" ADD COLUMN     "publicIdPrefix" TEXT NOT NULL;
