/**
 * models.dev catalog: fetch, disk cache, lazy TTL refresh, and id matching.
 *
 * The catalog is flattened into a list of entries keyed by provider, then
 * indexed by the last path segment of the model id (case-insensitive) so a
 * synced bare id like `qwen3.7-max` can resolve `Qwen/Qwen3.7-Max` wherever
 * models.dev carries it.
 *
 * Collisions are real: the same bare id appears under dozens of providers with
 * different limits. Resolution is deterministic and provider-aware:
 *   1. the models.dev provider mapped for the dsh provider (providerMap
 *      override, then same provider id);
 *   2. an exact full-id match (the dsh model id already carries a vendor/);
 *   3. first-party vendor list position (officialProviders);
 *   4. entry completeness (both context and output limits known);
 *   5. alphabetical provider id (stable last resort).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ACCEPTED_INPUT_MODALITIES,
  CATALOG_URL,
  REASONING_LEVELS,
  type ModelParametersConfig,
} from '../shared/config.js'

/** Structural logger subset satisfied by cordis' LoggerService. */
export interface CatalogLogger {
  info(format: any, ...param: any[]): void
  warn(format: any, ...param: any[]): void
}

/** One flattened models.dev entry. */
export interface CatalogEntry {
  /** models.dev provider id that carries this model. */
  provider: string
  /** Full model id as models.dev keys it (may carry a vendor/ prefix). */
  id: string
  /** Display name. */
  name?: string
  /** Context window in tokens, when known. */
  context?: number
  /** Output limit in tokens, when known. */
  output?: number
  /** Whether the model reasons at all, when stated. */
  reasoning?: boolean
  /** Offered reasoning effort levels (e.g. ["low","high","max"]). */
  effortValues?: string[]
  /** Accepted request modalities, raw from models.dev (may include pdf/audio/video). */
  input?: string[]
}

export interface CatalogSnapshot {
  /** Flattened entries in stable provider order. */
  entries: CatalogEntry[]
  /** Number of models.dev providers covered. */
  providers: number
  /** Epoch ms the cache was last fetched (0 = never fetched). */
  fetchedAt: number
}

const DAY_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 20_000

function strippedId(id: string): string {
  const last = id.split('/').pop() ?? id
  return last.toLowerCase()
}

function isOfficial(provider: string, official: readonly string[]): number {
  const index = official.indexOf(provider)
  return index === -1 ? official.length : index
}

function completeness(entry: CatalogEntry): number {
  return entry.context !== undefined && entry.output !== undefined ? 0 : 1
}

/** The cached raw document on disk: the api.json body plus fetch metadata. */
interface CacheDocument {
  fetchedAt: number
  body: Record<string, unknown>
}

export class CatalogManager {
  private snapshot: CatalogSnapshot = { entries: [], providers: 0, fetchedAt: 0 }
  private loaded = false
  private inflight: Promise<void> | null = null
  private readonly dir: string
  private readonly cachePath: string

  constructor(
    private readonly logger: CatalogLogger,
    dataDir?: string,
  ) {
    this.dir = dataDir ?? join(homedir(), '.dsh', 'model-parameters')
    this.cachePath = join(this.dir, 'catalog.json')
  }

  /** The current snapshot (empty until the first load/fetch completes). */
  snapshotOf(): CatalogSnapshot {
    return this.snapshot
  }

  /**
   * Load the disk cache once, then fetch when stale (or `force`). A failed
   * fetch keeps the last good cache; with no cache at all the snapshot stays
   * empty and the caller simply fills nothing. Concurrent callers share one
   * in-flight refresh.
   * @returns true when the snapshot may have changed.
   */
  async ensureFresh(config: Pick<ModelParametersConfig, 'ttlDays'>, force = false): Promise<boolean> {
    if (!this.loaded) {
      await this.loadCache()
      this.loaded = true
    }
    const stale = Date.now() - this.snapshot.fetchedAt >= config.ttlDays * DAY_MS
    if (!force && !stale) return false
    if (this.inflight !== null) {
      await this.inflight
      return true
    }
    this.inflight = this.fetchAndPersist()
      .catch((error) => {
        this.logger.warn(
          `model-parameters: catalog fetch failed (${error instanceof Error ? error.message : String(error)}); using cached copy`,
        )
      })
      .finally(() => {
        this.inflight = null
      })
    await this.inflight
    return true
  }

  /** Force a fetch now; never throws (falls back to cache or keeps empty). */
  async refresh(ttlDays: number): Promise<boolean> {
    return this.ensureFresh({ ttlDays }, true)
  }

  /**
   * Resolve one dsh model id to the best catalog entry for its provider.
   * @param modelId - the model id stored in the dsh provider profile.
   * @param dshProvider - the dsh provider route id.
   * @param config - plugin config (providerMap + officialProviders).
   */
  resolve(modelId: string, dshProvider: string, config: Pick<ModelParametersConfig, 'providerMap' | 'officialProviders'>): CatalogEntry | undefined {
    const mapped = config.providerMap[dshProvider]
    const candidates = this.candidatesFor(modelId)
    if (candidates.length === 0) return undefined
    const official = config.officialProviders

    const score = (entry: CatalogEntry): number[] => {
      const providerMatch = entry.provider === mapped || entry.provider === dshProvider ? 0 : 1
      const exact = modelId.includes('/') && strippedId(entry.id) === modelId.toLowerCase() ? 0 : 1
      return [providerMatch, exact, isOfficial(entry.provider, official), completeness(entry)]
    }

    // Stable total order: score tuple, then provider id, then full id.
    candidates.sort((a, b) => {
      const sa = score(a)
      const sb = score(b)
      for (let i = 0; i < sa.length; i++) {
        if (sa[i] !== sb[i]) return sa[i] - sb[i]
      }
      if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1
      return a.id < b.id ? -1 : 1
    })
    return candidates[0]
  }

  /**
   * All entries whose stripped id matches, plus any whose full id matches
   * exactly (a dsh model id may already carry a vendor/ prefix that models.dev
   * keys verbatim).
   */
  private candidatesFor(modelId: string): CatalogEntry[] {
    const stripped = strippedId(modelId)
    const out: CatalogEntry[] = []
    for (const entry of this.snapshot.entries) {
      if (strippedId(entry.id) === stripped) out.push(entry)
      else if (modelId.includes('/') && entry.id.toLowerCase() === modelId.toLowerCase()) out.push(entry)
    }
    return out
  }

  // ── disk / wire ────────────────────────────────────────────────────────────

  private async loadCache(): Promise<void> {
    try {
      const raw = await readFile(this.cachePath, 'utf8')
      const doc = JSON.parse(raw) as CacheDocument
      if (typeof doc.fetchedAt !== 'number' || typeof doc.body !== 'object' || doc.body === null) {
        this.logger.warn('model-parameters: catalog cache is malformed; ignoring')
        return
      }
      this.snapshot = this.buildSnapshot(doc.body, doc.fetchedAt)
      this.logger.info(
        `model-parameters: loaded ${this.snapshot.entries.length} catalog entries from cache (fetched ${new Date(doc.fetchedAt).toISOString()})`,
      )
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        this.logger.warn(`model-parameters: catalog cache read failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private async fetchAndPersist(): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(CATALOG_URL, { signal: controller.signal, headers: { accept: 'application/json' } })
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }
    const body = (await response.json()) as Record<string, unknown>
    const fetchedAt = Date.now()
    this.snapshot = this.buildSnapshot(body, fetchedAt)
    await mkdir(this.dir, { recursive: true })
    const doc: CacheDocument = { fetchedAt, body }
    await writeFile(this.cachePath, JSON.stringify(doc), 'utf8')
    this.logger.info(
      `model-parameters: catalog refreshed from models.dev (${this.snapshot.providers} providers, ${this.snapshot.entries.length} models)`,
    )
  }

  private buildSnapshot(body: Record<string, unknown>, fetchedAt: number): CatalogSnapshot {
    const entries: CatalogEntry[] = []
    for (const [provider, raw] of Object.entries(body)) {
      if (typeof raw !== 'object' || raw === null) continue
      const providerDoc = raw as Record<string, unknown>
      const models = providerDoc.models
      if (typeof models !== 'object' || models === null) continue
      for (const [id, rawModel] of Object.entries(models as Record<string, unknown>)) {
        if (typeof rawModel !== 'object' || rawModel === null) continue
        const model = rawModel as Record<string, unknown>
        const limit = (typeof model.limit === 'object' && model.limit !== null ? model.limit : {}) as Record<string, unknown>
        const entry: CatalogEntry = { provider, id }
        if (typeof model.name === 'string' && model.name.length > 0) entry.name = model.name
        if (typeof limit.context === 'number') entry.context = limit.context
        if (typeof limit.output === 'number') entry.output = limit.output
        if (typeof model.reasoning === 'boolean') entry.reasoning = model.reasoning
        const effortValues: string[] = []
        if (Array.isArray(model.reasoning_options)) {
          for (const option of model.reasoning_options) {
            if (typeof option === 'object' && option !== null && (option as Record<string, unknown>).type === 'effort') {
              const values = (option as Record<string, unknown>).values
              if (Array.isArray(values)) {
                for (const value of values) {
                  if (typeof value === 'string') effortValues.push(value)
                }
              }
            }
          }
        }
        if (effortValues.length > 0) entry.effortValues = effortValues
        const modalities = (typeof model.modalities === 'object' && model.modalities !== null ? model.modalities : {}) as Record<string, unknown>
        if (Array.isArray(modalities.input)) {
          const input = modalities.input.filter((value): value is string => typeof value === 'string')
          if (input.length > 0) entry.input = input
        }
        entries.push(entry)
      }
    }
    return { entries, providers: Object.keys(body).length, fetchedAt }
  }
}

/**
 * Build the dsh `reasoningEfforts` identity dict from models.dev effort
 * values, filtered to the levels dsh accepts. Returns undefined when nothing
 * valid is offered (or the model does not state reasoning).
 */
export function identityReasoningEfforts(entry: CatalogEntry): Record<string, string> | undefined {
  if (entry.reasoning === false) return undefined
  if (entry.effortValues === undefined || entry.effortValues.length === 0) return undefined
  const efforts: Record<string, string> = {}
  for (const value of entry.effortValues) {
    if (REASONING_LEVELS.includes(value)) efforts[value] = value
  }
  return Object.keys(efforts).length > 0 ? efforts : undefined
}

/**
 * The dsh-writable input modality list for one entry: models.dev values
 * intersected with what pi-ai accepts. Returns undefined when nothing is
 * accepted (writing an empty list is semantically "keep defaults", so absent
 * is the honest fill).
 */
export function acceptedInputModalities(entry: CatalogEntry): ('text' | 'image')[] | undefined {
  if (entry.input === undefined || entry.input.length === 0) return undefined
  const accepted = entry.input.filter((value): value is 'text' | 'image' => ACCEPTED_INPUT_MODALITIES.includes(value))
  return accepted.length > 0 ? accepted : undefined
}
