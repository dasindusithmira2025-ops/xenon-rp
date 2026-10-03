-- Imported source rules may have no severity in the official document.
ALTER TABLE "rules" ALTER COLUMN "severity" DROP NOT NULL;
ALTER TABLE "rule_revisions" ALTER COLUMN "severity" DROP NOT NULL;
ALTER TABLE "rules" ADD COLUMN "isDevelopmentFixture" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "rule_categories"
  ADD COLUMN "sourceRoot" TEXT,
  ADD COLUMN "sourceUrl" TEXT,
  ADD COLUMN "sourcePath" TEXT,
  ADD COLUMN "sourcePageTitle" TEXT,
  ADD COLUMN "sourceOrder" INTEGER,
  ADD COLUMN "sourceContentHash" TEXT,
  ADD COLUMN "sourceRetrievedAt" TIMESTAMP(3);

ALTER TABLE "rules"
  ADD COLUMN "sourceRoot" TEXT,
  ADD COLUMN "sourceUrl" TEXT,
  ADD COLUMN "sourcePath" TEXT,
  ADD COLUMN "sourceOrder" INTEGER,
  ADD COLUMN "sourceContentHash" TEXT,
  ADD COLUMN "sourceRetrievedAt" TIMESTAMP(3);

ALTER TABLE "rule_revisions"
  ADD COLUMN "contentHash" TEXT,
  ADD COLUMN "sourceRoot" TEXT,
  ADD COLUMN "sourceUrl" TEXT,
  ADD COLUMN "sourcePath" TEXT,
  ADD COLUMN "sourceOrder" INTEGER,
  ADD COLUMN "sourceContentHash" TEXT,
  ADD COLUMN "sourceRetrievedAt" TIMESTAMP(3);

ALTER TABLE "rule_sets"
  ADD COLUMN "sourceRoot" TEXT,
  ADD COLUMN "sourceContentHash" TEXT,
  ADD COLUMN "sourceRetrievedAt" TIMESTAMP(3);

ALTER TABLE "rule_acceptances"
  ADD COLUMN "ruleSetHash" TEXT;
