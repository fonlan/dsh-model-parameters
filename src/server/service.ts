/**
 * The model-parameters service: owns the plugin settings namespace, watches
 * the `llm-pi-ai` namespace for provider model writes, reconciles missing
 * fields from the cached models.dev catalog, and tracks a fill report.
 *
 * Trigger model:
 *  - any committed `llm-pi-ai` settings change (settings UI apply, manual
 *    settings.yaml edit published by the file provider, model-router-style
 *    external writes) runs a reconcile;
 *  - plugin start runs a backfill reconcile over the existing configuration.
 * Reconcile is fill-only: it never overwrites a present field, and it writes
 * nothing when nothing is missing — so its own writes cannot re-trigger a
 * second patch (the next event sees the fields present and produces no ops).
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  settingsNamespace,
  type SettingsScope,
  type SettingsPathOp,
} from '@deepseek-ai/dsh-settings'
import type { PiAiModelProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import {
  Config,
  DEFAULT_CONFIG,
  PLUGIN_NS,
  TARGET_NS,
  type ModelParametersConfig,
} from '../shared/config.js'
import {
  CatalogManager,
  acceptedInputModalities,
  identityReasoningEfforts,
  type CatalogEntry,
  type CatalogSnapshot,
} from './catalog.js'

const TARGET = settingsNamespace(TARGET_NS)
const OWN = settingsNamespace(PLUGIN_NS)

/** One reconcile run's outcome, surfaced to the settings page. */
export interface FillReport {
  at: number
  /** Number of individual field fills applied. */
  filled: number
  /** Number of providers whose models array was rewritten. */
  touched: number
  /** Model ids (provider/model) that matched nothing in the catalog. */
  unmatched: string[]
}

export class ModelParametersService {
  /**
   * The settings service value captured from the inject callback. The plugin
   * itself declares `inject: []` (settings is optional — headless profiles
   * have no settings service), so `this.ctx.settings` is never resolvable:
   * the context proxy only walks ancestor fibers, and the provider lives on
   * a sibling fiber. The injected child ctx itself is only valid while its
   * fiber is active — the provider can be reloaded (and every dependent
   * fiber torn down) while an async reconcile is in flight — so all reads
   * and writes go through the captured service value, which is a plain
   * object and never walks the fiber chain.
   */
  private settings: Context['settings'] | undefined
  private scope: SettingsScope<ModelParametersConfig> | undefined
  private lastReport: FillReport | null = null
  private readonly catalog: CatalogManager
  private reconciling: Promise<void> | null = null

  constructor(private readonly ctx: Context) {
    this.catalog = new CatalogManager(ctx.logger)
  }

  start(): void {
    // Own settings namespace (config toggles, TTL, provider map). The inject
    // callback fires asynchronously once the settings service is available, so
    // the first-run backfill reconcile lives INSIDE it — reconcile needs the
    // settings service (to read the target namespace and persist fills).
    this.ctx.inject(['settings'], (sctx) => {
      this.settings = sctx.settings
      this.scope = this.settings.register(OWN, Config) as SettingsScope<ModelParametersConfig>
      // First-run backfill: ensure a fresh-enough catalog, then fill existing
      // models. Never blocks plugin startup.
      void this.reconcile()
    })

    // Watch the target namespace: any committed provider-model change may
    // leave fields missing -> reconcile.
    this.ctx.on('settings/updated', (ns) => {
      if (ns !== TARGET) return
      void this.reconcile()
    })
  }

  stop(): void {
    this.scope = undefined
    this.settings = undefined
  }

  // ── reads for the settings page ────────────────────────────────────────────

  config(): ModelParametersConfig {
    if (this.scope !== undefined) {
      try {
        return this.scope.get()
      } catch {
        // fall through to defaults
      }
    }
    return { ...DEFAULT_CONFIG, providerMap: {}, officialProviders: [...DEFAULT_CONFIG.officialProviders] }
  }

  catalogSnapshot(): CatalogSnapshot {
    return this.catalog.snapshotOf()
  }

  report(): FillReport | null {
    return this.lastReport
  }

  /** Force a catalog refresh, then reconcile and report. */
  async refreshAndReconcile(): Promise<void> {
    await this.catalog.refresh(this.config().ttlDays)
    await this.reconcile()
  }

  /** Update plugin config toggles from the settings page. */
  async updateConfig(patch: Partial<ModelParametersConfig>): Promise<void> {
    if (this.scope === undefined) {
      throw new Error('model-parameters: settings service is not available in this profile')
    }
    const current = this.config()
    await this.scope.update({ ...current, ...patch })
  }

  // ── reconcile ──────────────────────────────────────────────────────────────

  /**
   * Fill missing fields on every provider model from the catalog. Serialized:
   * concurrent triggers (event + backfill) coalesce into one run. Fill-only
   * guarantees termination: after a write the fields are present, so the next
   * event produces no ops.
   */
  async reconcile(): Promise<void> {
    if (this.reconciling !== null) return this.reconciling
    this.reconciling = this.runReconcile().finally(() => {
      this.reconciling = null
    })
    return this.reconciling
  }

  private async runReconcile(): Promise<void> {
    const config = this.config()
    if (!config.enabled) return
    const settings = this.settings
    if (settings === undefined) return
    try {
      await this.catalog.ensureFresh(config)
    } catch (error) {
      this.ctx.logger.warn(`model-parameters: reconcile skipped, catalog unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    // Operate on the RAW user section (descriptor.user), not the resolved
    // value: the resolved section is schema-normalized (pi-ai's loose object
    // resolution adds empty `input`/`compat` defaults), and persisting that
    // shape would leak schema-default noise into settings.yaml. The raw
    // section is exactly what the user document stores.
    const descriptor = settings.describe({ redactSecrets: false }).find((candidate) => candidate.ns === TARGET)
    const section = descriptor?.user as { providers?: Record<string, { models?: PiAiModelProfile[] }> } | undefined
    if (section === undefined || typeof section !== 'object' || section.providers === undefined) return

    const ops: SettingsPathOp[] = []
    const report: FillReport = { at: Date.now(), filled: 0, touched: 0, unmatched: [] }

    for (const [providerId, profile] of Object.entries(section.providers)) {
      if (typeof profile !== 'object' || profile === null) continue
      const models = profile.models
      if (!Array.isArray(models) || models.length === 0) continue
      const nextModels: PiAiModelProfile[] = []
      let changed = false
      for (const model of models) {
        const next = this.fillModel(model, providerId, config, report)
        if (next !== model) changed = true
        nextModels.push(next)
      }
      if (changed) {
        ops.push({ op: 'set', path: ['providers', providerId, 'models'], value: nextModels })
        report.touched++
      }
    }

    if (ops.length > 0) {
      try {
        await settings.mutate(TARGET, ops)
      } catch (error) {
        this.ctx.logger.warn(`model-parameters: reconcile persist failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.lastReport = report
    if (report.filled > 0 || report.unmatched.length > 0) {
      this.ctx.logger.info(
        `model-parameters: reconcile filled ${report.filled} fields across ${report.touched} providers; ${report.unmatched.length} unmatched (${report.unmatched.slice(0, 5).join(', ')}${report.unmatched.length > 5 ? ', …' : ''})`,
      )
    }
  }

  /** Fill one model entry (fill-only), returning the same object when untouched. */
  private fillModel(
    model: PiAiModelProfile,
    providerId: string,
    config: ModelParametersConfig,
    report: FillReport,
  ): PiAiModelProfile {
    const entry = this.catalog.resolve(model.id, providerId, config)
    if (entry === undefined) {
      report.unmatched.push(`${providerId}/${model.id}`)
      return model
    }
    const next = { ...model }
    let filledFields = 0

    if (config.fillName && next.name === undefined) {
      const name = catalogName(entry)
      if (name !== undefined) {
        next.name = name
        filledFields++
      }
    }
    if (config.fillContext && next.contextWindow === undefined && entry.context !== undefined && entry.context > 0) {
      next.contextWindow = entry.context
      filledFields++
    }
    if (config.fillMaxTokens && next.maxTokens === undefined && entry.output !== undefined && entry.output > 0) {
      next.maxTokens = entry.output
      filledFields++
    }
    if (config.fillReasoning && next.reasoningEfforts === undefined) {
      const efforts = identityReasoningEfforts(entry)
      if (efforts !== undefined) {
        next.reasoningEfforts = efforts
        filledFields++
      }
    }
    if (config.fillInput && next.input === undefined) {
      const input = acceptedInputModalities(entry)
      if (input !== undefined) {
        next.input = input
        filledFields++
      }
    }
    if (filledFields === 0) return model
    report.filled += filledFields
    return next
  }
}

function catalogName(entry: CatalogEntry): string | undefined {
  return entry.name !== undefined && entry.name.length > 0 ? entry.name : undefined
}
