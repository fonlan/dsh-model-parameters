/**
 * The model-parameters service: completes missing model fields in the
 * `llm-pi-ai` settings namespace from the cached models.dev catalog and tracks
 * a fill report. Its own settings ARE this plugin's loader entry config (see
 * shared/config.ts), so there is no per-plugin settings scope to own here.
 *
 * Trigger model:
 *  - any committed `llm-pi-ai` settings change (settings UI apply, manual
 *    profile-patch edit, model-router-style external writes) runs a reconcile;
 *  - plugin start runs a backfill reconcile over the existing configuration.
 * Reconcile is fill-only: it never overwrites a present field, and it writes
 * nothing when nothing is missing — so its own writes cannot re-trigger a
 * second patch (the next event sees the fields present and produces no ops).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { PiAiModelProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import {
  PLUGIN_NS,
  TARGET_NS,
  readConfig,
  type ModelParametersConfig,
  type ModelParametersLiveConfig,
} from '../shared/config.js'
import {
  CatalogManager,
  acceptedInputModalities,
  identityReasoningEfforts,
  type CatalogEntry,
  type CatalogSnapshot,
} from './catalog.js'

const TARGET = TARGET_NS
const OWN = PLUGIN_NS

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
   * and writes of the `llm-pi-ai` namespace go through the captured service
   * value, which is a plain object and never walks the fiber chain.
   */
  private settings: Context['settings'] | undefined
  private lastReport: FillReport | null = null
  private readonly catalog: CatalogManager
  private reconciling: Promise<void> | null = null

  /**
   * @param ctx the plugin context.
   * @param entryConfig this plugin's own live entry config (the profile entry
   *   `model-parameters`): the resolved `Config` document, whose `.volatile()`
   *   fields are live cells that the loader swaps in place on every settings
   *   write. Read through {@link readConfig} on each access, never cached.
   */
  constructor(
    private readonly ctx: Context,
    private readonly entryConfig: ModelParametersLiveConfig | undefined,
  ) {
    this.catalog = new CatalogManager(ctx.logger)
  }

  start(): void {
    // The plugin's own settings ARE this entry config, so nothing is
    // registered here: `config()` projects the live entry config and writes
    // go through the settings service (see updateConfig). The inject callback
    // fires asynchronously once the settings service is available, so the
    // first-run backfill reconcile lives INSIDE it — reconcile needs the
    // settings service (to read the target namespace and persist fills).
    this.ctx.inject(['settings'], (sctx) => {
      this.settings = sctx.settings
      // First-run backfill: ensure a fresh-enough catalog, then fill existing
      // models. Never blocks plugin startup.
      void this.reconcile()
    })

    // Watch the target namespace: any committed provider-model change may
    // leave fields missing -> reconcile. `settings/document-updated` is the
    // committed-change signal (dsh-settings bumps a form revision after the
    // profile patch was written); it also fires for this plugin's own entry,
    // which is filtered out here so a toggle write never triggers a reconcile.
    this.ctx.on('settings/document-updated', (ns) => {
      if (ns !== TARGET) return
      void this.reconcile()
    })
  }

  stop(): void {
    this.settings = undefined
  }

  // ── reads for the settings page ────────────────────────────────────────────

  /**
   * The plugin's current settings, projected from the live entry config.
   * Works with no settings service at all (headless), which is why the plain
   * {@link DEFAULT_CONFIG} fallback lives in {@link readConfig}.
   */
  config(): ModelParametersConfig {
    return readConfig(this.entryConfig)
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

  /**
   * Update the plugin's own settings from the settings page. `dsh-settings`
   * addresses the plugin's loader entry by its id and refuses any path the
   * `Config` schema did not mark volatile — every field here is volatile.
   */
  async updateConfig(patch: Partial<ModelParametersConfig>): Promise<void> {
    const settings = this.settings
    if (settings === undefined) {
      throw new Error('model-parameters: settings service is not available in this profile')
    }
    // `update` MERGES the patch into the entry's stored section — the
    // "merge a partial into the current config" contract the page has always
    // used. `providerMap` is the one plain OBJECT the page re-sends whole (a
    // removed mapping row must disappear), and a deep merge would resurrect
    // the removed key, so that field rides a path `set` op instead: `mutate`
    // delegates to the same `write()` and replaces the value at the path
    // wholesale. Arrays (`officialProviders`) are replaced by the merge
    // itself, since the merge only recurses into plain objects.
    const { providerMap, ...rest } = patch
    if (Object.keys(rest).length > 0) await settings.update(OWN, rest)
    if (providerMap !== undefined) {
      await settings.mutate(OWN, [{ op: 'set', path: ['providerMap'], value: providerMap }])
    }
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
    // shape would leak schema-default noise into the profile patch. The raw
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
