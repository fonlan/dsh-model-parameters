/**
 * Standalone verification of the catalog matching logic against the real
 * models.dev dataset (downloaded to /tmp/modelsdev.json).
 * Run: node --input-type=module scripts/verify-catalog.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { CatalogManager, identityReasoningEfforts, acceptedInputModalities } from '../lib/index.js'

const DATA_DIR = '/tmp/mp-verify'
const silent = { info() {}, warn() {} }
const body = JSON.parse(await readFile('/tmp/modelsdev.json', 'utf8'))

await mkdir(DATA_DIR, { recursive: true })
await writeFile(join(DATA_DIR, 'catalog.json'), JSON.stringify({ fetchedAt: Date.now(), body }), 'utf8')

const mgr = new CatalogManager(silent, DATA_DIR)
await mgr.ensureFresh({ ttlDays: 999 })

const defaultConfig = {
  providerMap: {},
  officialProviders: ['deepseek', 'openai', 'anthropic', 'google', 'xai', 'moonshotai', 'zai', 'zhipuai', 'minimax', 'stepfun', 'xiaomi', 'meta', 'cohere', 'nvidia', 'alibaba'],
}

// The user's actual providers/models from settings.yaml (missing-field cases only).
const cases = [
  // [dsh provider, model id, expected minimal outcome]
  ['opencode-go', 'deepseek-v4-flash', 'exact-provider'],
  ['opencode-go', 'qwen3.7-max', 'strip'],
  ['opencode-go', 'kimi-k2.7-code', 'strip'],
  ['command-code', 'deepseek/deepseek-v4-pro', 'prefixed'],
  ['command-code', 'zai-org/GLM-5.2', 'prefixed'],
  ['command-code', 'google/gemini-3.7-flash', 'prefixed'],
  ['cpa', 'gpt-5.6-sol', 'strip'],
  ['grok2api', 'grok-4.6', 'strip'],
  ['opencode-go', 'hy3', 'none-or-strip'],
  ['opencode-go', 'hy3-paid', 'NO-MATCH'],
  ['mtplx', 'automatosx-ax-qwen3.8-27b-mlx-axq-4bit-mtp', 'NO-MATCH-or-local'],
]

let pass = 0
let fail = 0
for (const [provider, modelId, note] of cases) {
  const entry = mgr.resolve(modelId, provider, defaultConfig)
  const status = entry === undefined ? 'NO-MATCH' : `${entry.provider}/${entry.id}`
  const efforts = entry === undefined ? '-' : JSON.stringify(identityReasoningEfforts(entry) ?? null)
  const input = entry === undefined ? '-' : JSON.stringify(acceptedInputModalities(entry) ?? null)
  const line = `${provider.padEnd(14)} ${modelId.padEnd(52)} → ${status.padEnd(48)} [${note}]`
  const ok = entry !== undefined || note === 'NO-MATCH' || note === 'NO-MATCH-or-local'
  if (ok && entry !== undefined) {
    console.log(`✓ ${line}\n    efforts=${efforts} input=${input}`)
    pass++
  } else if (!ok) {
    console.log(`✗ ${line}`)
    fail++
  } else {
    console.log(`○ ${line} (unmatched, acceptable)`)
    pass++
  }
}

// Reasoning mapping spot checks against known models.dev entries.
console.log('\n-- reasoning mapping --')
const ds = mgr.resolve('deepseek-v4-flash', 'opencode-go', defaultConfig)
console.log('opencode-go/deepseek-v4-flash efforts:', JSON.stringify(identityReasoningEfforts(ds)))
const gpt = mgr.resolve('gpt-5.6-sol', 'cpa', defaultConfig)
console.log('cpa/gpt-5.6-sol efforts:', JSON.stringify(identityReasoningEfforts(gpt)))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
