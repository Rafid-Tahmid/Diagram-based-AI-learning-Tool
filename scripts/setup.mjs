// One-command project setup: `npm run setup`
//
// Idempotent — safe to re-run. Handles both a fresh database and upgrading an
// existing one. Why not just `prisma db push` always: the pgvector embedding
// column on Chunk lives outside the Prisma schema, and a push against an
// initialized DB tries to drop it. Fresh DBs get push + pgvector SQL; existing
// DBs get only the idempotent raw-SQL migrations.

import { existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'

const root = process.cwd()
const ok = (msg) => console.log(`  ✓ ${msg}`)
const step = (msg) => console.log(`\n${msg}`)
const fail = (msg) => {
  console.error(`\n✗ ${msg}`)
  process.exit(1)
}

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: opts.quiet ? 'pipe' : 'inherit', cwd: root })
}

function parseEnv(path) {
  const out = {}
  if (!existsSync(path)) return out
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

console.log('Diagram Learning Tool — setup')

// 1. Env files
step('1/4  Environment files')
const envLocalPath = join(root, '.env.local')
if (!existsSync(envLocalPath)) {
  copyFileSync(join(root, '.env.example'), envLocalPath)
  ok('created .env.local from .env.example')
  fail(
    'Now open .env.local and set DATABASE_URL (free Postgres: https://neon.tech),\n' +
    '  then run `npm run setup` again. AI keys can be added later in the app (Settings page).',
  )
}
const env = parseEnv(envLocalPath)
const dbUrl = env.DATABASE_URL
if (!dbUrl || dbUrl.includes('USER:PASSWORD')) {
  fail('DATABASE_URL in .env.local is missing or still the placeholder. Set it, then re-run `npm run setup`.')
}
ok('.env.local has DATABASE_URL')

// Prisma CLI reads .env, not .env.local — keep them in sync automatically.
const envPath = join(root, '.env')
const envFile = parseEnv(envPath)
if (envFile.DATABASE_URL !== dbUrl) {
  const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
  const line = `DATABASE_URL=${dbUrl}`
  const next = /^DATABASE_URL=.*$/m.test(existing)
    ? existing.replace(/^DATABASE_URL=.*$/m, line)
    : `${existing.replace(/\n*$/, '\n')}${line}\n`
  writeFileSync(envPath, next.replace(/^\n/, ''))
  ok('synced DATABASE_URL into .env (Prisma CLI reads this one)')
} else {
  ok('.env already in sync')
}

// 2. Prisma client
step('2/4  Prisma client')
run('npx prisma generate', { quiet: true })
ok('client generated')

// 3. Database schema
step('3/4  Database schema')
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })
let nodeTableExists = false
try {
  const rows = await prisma.$queryRaw`SELECT to_regclass('public."Node"') IS NOT NULL AS exists`
  nodeTableExists = Boolean(rows?.[0]?.exists)
} catch (err) {
  await prisma.$disconnect()
  fail(`Could not reach the database: ${err.message?.split('\n')[0] ?? err}`)
}

const sqlDir = join(root, 'prisma', 'sql')
const sqlFiles = readdirSync(sqlDir).filter(f => f.endsWith('.sql')).sort()

if (!nodeTableExists) {
  console.log('  fresh database — creating schema')
  run('npx prisma db push --skip-generate', { quiet: true })
  ok('tables created (prisma db push)')
  for (const f of sqlFiles) {
    run(`npx prisma db execute --file prisma/sql/${f}`, { quiet: true })
    ok(`applied ${f}`)
  }
} else {
  console.log('  existing database — applying idempotent migrations only (no db push:')
  console.log('  push would drop the pgvector embedding column)')
  for (const f of sqlFiles) {
    run(`npx prisma db execute --file prisma/sql/${f}`, { quiet: true })
    ok(`applied ${f}`)
  }
}
await prisma.$disconnect()

// 4. Done
step('4/4  Done\n')
const hasKey = env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || env.GOOGLE_AI_API_KEY
console.log('Start the app:   npm run dev')
console.log('Then open:       http://localhost:3000')
if (!hasKey) {
  console.log('\nNo AI key configured yet — the app will prompt you; add one on the Settings page (gear icon).')
}
