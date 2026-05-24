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

-- Embedding column on Chunk. Dimension MUST match RAG_EMBEDDING_DIM
-- (lib/ragConfig.ts). Defaults by provider:
--   * OpenAI  text-embedding-3-small   → 1536  ← the value below
--   * Google  gemini-embedding-001     → 3072  (drop column, change to vector(3072), re-ingest)
-- Switching providers/dims requires:
--   ALTER TABLE "Chunk" DROP COLUMN embedding;
--   ALTER TABLE "Chunk" ADD COLUMN embedding vector(<new_dim>);
--   DROP INDEX chunk_embedding_hnsw;
--   CREATE INDEX chunk_embedding_hnsw ON "Chunk" USING hnsw (embedding vector_cosine_ops);
-- ...then re-run ingestion.
ALTER TABLE "Chunk" ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- HNSW index with cosine ops — strong recall-at-k for the corpus sizes we'll
-- target (≤500k chunks). Switch to vector_l2_ops or vector_ip_ops only if the
-- embedding model ships normalized vectors and you've measured a difference.
CREATE INDEX IF NOT EXISTS chunk_embedding_hnsw
  ON "Chunk"
  USING hnsw (embedding vector_cosine_ops);
