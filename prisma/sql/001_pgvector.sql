-- Phase 6 — Stage 1 pgvector setup.
--
-- Why this is raw SQL: Prisma 5 has no native type for pgvector's `vector`
-- column or its similarity operators (`<=>`, `<#>`, `<->`). This file is the
-- one documented exception to "no raw SQL" — kept here so the vector storage
-- is reproducible, version-controlled, and obvious.
--
-- Run order (one-time, against your Docker Postgres):
--   1. Apply Prisma schema:          npx prisma db push
--   2. Apply this file:              psql "$DATABASE_URL" -f prisma/sql/001_pgvector.sql
--
-- Re-running is safe — every statement is guarded by IF NOT EXISTS.

CREATE EXTENSION IF NOT EXISTS vector;

-- Embedding column on Chunk. Dimension 1536 matches OpenAI text-embedding-3-small
-- (current default in lib/ragConfig.ts). If you switch to a model with a
-- different dimension (e.g. Gemini text-embedding-004 = 768), drop and recreate
-- this column AND the index below, then re-ingest. The chunker is the same;
-- only the embeddings change.
ALTER TABLE "Chunk" ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- HNSW index with cosine ops — strong recall-at-k for the corpus sizes we'll
-- target (≤500k chunks). Switch to vector_l2_ops or vector_ip_ops only if the
-- embedding model ships normalized vectors and you've measured a difference.
CREATE INDEX IF NOT EXISTS chunk_embedding_hnsw
  ON "Chunk"
  USING hnsw (embedding vector_cosine_ops);
