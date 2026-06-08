-- Sibling-order column for Node. Created via raw SQL (not `prisma db push`)
-- because a full push diff insists on dropping Chunk.embedding (the pgvector
-- column lives outside the Prisma schema). Run once against the database.
ALTER TABLE "Node" ADD COLUMN IF NOT EXISTS "ordinal" INTEGER NOT NULL DEFAULT 0;
