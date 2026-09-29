/**
 * Plugin configuration and shared constants for @fonlan/dsh-model-parameters.
 *
 * The plugin's own settings ARE its loader entry config (DSH >= 0.1.7): the
 * profile entry whose id is `model-parameters` (see cordis.patch.yml) is
 * validated with {@link Config}, the resolved document is handed to
 * `apply(ctx, config)`, and the settings page is derived from that schema. The
 * plugin OBSERVES the `llm-pi-ai` namespace: whenever provider models are
 * written there with missing capability fields (which is the norm for a freshly
 * synced gateway), it patches the missing fields from the cached models.dev
 * catalog.
 */
import z from '@deepseek-ai/schemastery'

/** This plugin's own settings namespace: its profile entry id. */
export const PLUGIN_NS = 'model-parameters'

/** The namespace whose models this plugin completes: pi-ai provider profiles. */
export const TARGET_NS = 'llm-pi-ai'

/** models.dev catalog endpoint. */
export const CATALOG_URL = 'https://models.dev/api.json'

/** Default provider ids treated as first-party vendors (tie-break for id collisions). */
export const DEFAULT_OFFICIAL_PROVIDERS: readonly string[] = [
  'deepseek',
  'openai',
  'anthropic',
  'google',
  'xai',
  'moonshotai',
  'zai',
  'zhipuai',
  'minimax',
  'stepfun',
  'xiaomi',
  'meta',
  'cohere',
  'nvidia',
  'alibaba',
]

/**
 * dsh pi-ai only accepts these request modalities; models.dev may also list
 * pdf/audio/video, which must be filtered out before writing (schema rejects
 * unknown modality values).
 */
export const ACCEPTED_INPUT_MODALITIES: readonly string[] = ['text', 'image']

/**
 * Valid `reasoningEfforts` keys in pi-ai, in escalation order. models.dev
 * effort values like `default`/`none`/empty are filtered out; only values in
 * this set are written.
 */
export const REASONING_LEVELS: readonly string[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

/** Plugin configuration shape: the PLAIN document, with no live handles in it. */
export interface ModelParametersConfig {
  /** Master switch: when off, no fills happen (listener is inert). */
  enabled: boolean
  /** How many days a cached models.dev catalog is considered fresh. */
  ttlDays: number
  /** Fill display name from the catalog when the entry lacks one. */
  fillName: boolean
  /** Fill contextWindow when the entry lacks one. */
  fillContext: boolean
  /** Fill maxTokens when the entry lacks one. */
  fillMaxTokens: boolean
  /** Fill reasoningEfforts (identity dict over offered effort levels) when absent. */
  fillReasoning: boolean
  /** Fill input modalities (filtered to text/image) when absent. */
  fillInput: boolean
  /** dsh provider id -> models.dev provider id overrides for matching. */
  providerMap: Record<string, string>
  /** models.dev provider ids treated as first-party vendors for tie-breaking. */
  officialProviders: string[]
}

/**
 * Recursively readonly value a live handle returns — cosmokit's
 * `VolatileSnapshot<T>`, spelled locally for the same reason as
 * {@link LiveSettingsField}.
 */
export type LiveSettingsSnapshot<T> = T extends object
  ? { readonly [K in keyof T]: LiveSettingsSnapshot<T[K]> }
  : T

/**
 * One `volatile()` config field as the loader hands it to `apply()`: a live
 * handle, not the value it currently holds. Spelled structurally rather than as
 * cosmokit's `Volatile<T>` on purpose — cosmokit is a transitive dependency
 * here, and importing it would put a second schemastery/cosmokit pair into the
 * emitted declaration.
 */
export interface LiveSettingsField<T> {
  get(): LiveSettingsSnapshot<T>
}

/** A hand-written entry config (profile patch / test fixture): every field is optional. */
export type ModelParametersConfigInput = {
  enabled?: boolean | null
  ttlDays?: number | null
  fillName?: boolean | null
  fillContext?: boolean | null
  fillMaxTokens?: boolean | null
  fillReasoning?: boolean | null
  fillInput?: boolean | null
  providerMap?: Record<string, string> | null
  officialProviders?: string[] | null
}

/** The resolved entry config `apply()` receives: every field is a live handle. */
export type ResolvedModelParametersConfig = {
  enabled: LiveSettingsField<boolean>
  ttlDays: LiveSettingsField<number>
  fillName: LiveSettingsField<boolean>
  fillContext: LiveSettingsField<boolean>
  fillMaxTokens: LiveSettingsField<boolean>
  fillReasoning: LiveSettingsField<boolean>
  fillInput: LiveSettingsField<boolean>
  providerMap: LiveSettingsField<Record<string, string>>
  officialProviders: LiveSettingsField<string[]>
}

/**
 * Entry config schema. Deliberately NOT annotated `z<ModelParametersConfig>`:
 * schemastery >= 3.18.3 carries a third `Mode` type parameter, so a
 * `.volatile()` field's OUTPUT type is `Volatile<T>` (a live `{ get() }` cell),
 * and that annotation no longer compiles. The plain document shape stays
 * {@link ModelParametersConfig} and is what {@link readConfig} projects to.
 *
 * The annotation below names the type through the package's own default export
 * (`z<...>`), with locally declared type arguments: the bare inferred type of a
 * volatile schema resolves through a schemastery copy this package does not
 * import, so `tsc -p tsconfig.build.json` (`declaration: true`) could not name
 * it (TS2742) — the emitted declaration stays portable this way.
 *
 * `.volatile()` is REQUIRED on every field the settings page may write, not
 * cosmetic: `dsh-settings` derives `volatileForm(schema)` from this schema, and
 * with no volatile field at all it SKIPS this entry in `describe()` (the
 * settings page disappears) and REJECTS every write as a non-volatile path.
 * The profile entry id (`model-parameters`, see cordis.patch.yml) is the
 * namespace those writes address.
 */
export type ModelParametersConfigSchema = z<
  ModelParametersConfigInput,
  ResolvedModelParametersConfig
>

/** The plugin's `Config` schema, exported for the loader and the settings page. */
export const Config: ModelParametersConfigSchema = z.object({
  enabled: z.boolean().default(true).volatile(),
  ttlDays: z.number().min(1).max(90).default(7).volatile(),
  fillName: z.boolean().default(true).volatile(),
  fillContext: z.boolean().default(true).volatile(),
  fillMaxTokens: z.boolean().default(true).volatile(),
  fillReasoning: z.boolean().default(true).volatile(),
  fillInput: z.boolean().default(true).volatile(),
  providerMap: z.dict(z.string()).default({}).volatile(),
  officialProviders: z.array(z.string()).default([...DEFAULT_OFFICIAL_PROVIDERS]).volatile(),
})

export const DEFAULT_CONFIG: ModelParametersConfig = {
  enabled: true,
  ttlDays: 7,
  fillName: true,
  fillContext: true,
  fillMaxTokens: true,
  fillReasoning: true,
  fillInput: true,
  providerMap: {},
  officialProviders: [...DEFAULT_OFFICIAL_PROVIDERS],
}

/**
 * The entry config as `apply()` receives it. Every field may arrive either as a
 * live `Volatile` cell or as a plain value (a hand-built config object, a
 * profile patch written before the volatile marker existed, or a host that
 * resolves the document without the wrapper).
 */
export type ModelParametersLiveConfig = Partial<Record<keyof ModelParametersConfig, unknown>>

/**
 * Read a config node that may be a plain value or a live (`.volatile()`) node.
 *
 * A plugin whose Config declares volatile fields receives a reactive config
 * whose fields expose `get()`, while hand-written config objects and tests pass
 * plain values. Both shapes are supported here so the same code path serves the
 * settings page, `cordis.patch.yml`, and the unit tests.
 */
function liveValue<T>(node: unknown, fallback: T): T {
  if (node === undefined || node === null) return fallback
  const getter = (node as { get?: unknown }).get
  if (typeof getter === 'function') {
    const value = (getter as () => unknown).call(node)
    return value === undefined ? fallback : (value as T)
  }
  return node as T
}

/**
 * Project the loader entry config into the plain document shape, per field
 * falling back to {@link DEFAULT_CONFIG}. The config is re-read on EVERY call,
 * so settings-page edits (which the loader swaps into the live cells in place)
 * take effect immediately. Container fields are copied so callers can never
 * mutate the live document through a returned reference.
 */
export function readConfig(config: ModelParametersLiveConfig | undefined): ModelParametersConfig {
  const section = config ?? {}
  return {
    enabled: liveValue(section.enabled, DEFAULT_CONFIG.enabled),
    ttlDays: liveValue(section.ttlDays, DEFAULT_CONFIG.ttlDays),
    fillName: liveValue(section.fillName, DEFAULT_CONFIG.fillName),
    fillContext: liveValue(section.fillContext, DEFAULT_CONFIG.fillContext),
    fillMaxTokens: liveValue(section.fillMaxTokens, DEFAULT_CONFIG.fillMaxTokens),
    fillReasoning: liveValue(section.fillReasoning, DEFAULT_CONFIG.fillReasoning),
    fillInput: liveValue(section.fillInput, DEFAULT_CONFIG.fillInput),
    providerMap: { ...liveValue<Record<string, string>>(section.providerMap, DEFAULT_CONFIG.providerMap) },
    officialProviders: [...liveValue<readonly string[]>(section.officialProviders, DEFAULT_CONFIG.officialProviders)],
  }
}
