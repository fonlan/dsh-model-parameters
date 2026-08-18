/**
 * Plugin configuration and shared constants for @fonlan/dsh-model-parameters.
 *
 * The plugin owns the `model-parameters` settings namespace (stored in
 * settings.yaml) and OBSERVES the `llm-pi-ai` namespace: whenever provider
 * models are written there with missing capability fields (which is the norm
 * for a freshly synced gateway), it patches the missing fields from the cached
 * models.dev catalog.
 */
import z from '@deepseek-ai/schemastery'

/** This plugin's own settings namespace. */
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

/** Plugin configuration shape. */
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

export const Config: z<ModelParametersConfig> = z.object({
  enabled: z.boolean().default(true),
  ttlDays: z.number().min(1).max(90).default(7),
  fillName: z.boolean().default(true),
  fillContext: z.boolean().default(true),
  fillMaxTokens: z.boolean().default(true),
  fillReasoning: z.boolean().default(true),
  fillInput: z.boolean().default(true),
  providerMap: z.dict(z.string()).default({}),
  officialProviders: z.array(z.string()).default([...DEFAULT_OFFICIAL_PROVIDERS]),
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
