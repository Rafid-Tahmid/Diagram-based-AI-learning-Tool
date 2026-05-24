-- Phase 6 — pgvector setup.
--
-- Why this is raw SQL: Prisma 5 has no native type for pgvector's `vector`
-- column or its similarity operators (`<=>`, `<#>`, `<->`). This file is the
-- one documented exception to "no raw SQL" — kept here so the vector storage
-- is reproducible, version-controlled, and obvious.
--
-- Run order (one-time, against your Postgres instance):
--   1. Apply Prisma schema:          npx prisma db push
--   2. Apply this file:              docker exec -i learning-tool-db psql -U postgres -d learning_tool < prisma/sql/001_pgvector.sql
--
-- Re-running is safe — every statement is guarded by IF NOT EXISTS.

CREATE EXTENSION IF NOT EXISTS vector;

-- Embedding column on Chunk. Dimension matches RAG_EMBEDDING_DIM (lib/ragConfig.ts).
-- Configured for Google gemini-embedding-001 → 3072 dims.
--
-- pgvector's HNSW index is capped at 2000 dims, so we skip it here.
-- For corpus sizes under ~50k chunks a sequential scan is fast enough (<10ms).
-- When the corpus grows large enough to need an index, add IVFFlat:
--   CREATE INDEX chunk_embedding_ivfflat ON "Chunk"
--     USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
-- (Tune lists to roughly sqrt(row_count). Requires a full table scan to build.)
ALTER TABLE "Chunk" ADD COLUMN IF NOT EXISTS embedding vector(3072);
