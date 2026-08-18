/** Client transport for the model-parameters settings API. */
import type { ModelParametersConfig } from '../shared/config.js'

export interface CatalogView {
  entries: number
  providers: number
  fetchedAt: number
  fresh: boolean
  ttlDays: number
}

export interface FillReportView {
  at: number
  filled: number
  touched: number
  unmatched: string[]
}

export interface PluginState {
  config: ModelParametersConfig
  catalog: CatalogView
  report: FillReportView | null
}

export class ModelParametersApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

async function call<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/plugins/@fonlan/dsh-model-parameters/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    throw new ModelParametersApiError('network', error instanceof Error ? error.message : String(error))
  }
  const parsed: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } | null
    = await response.json().catch(() => null)
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new ModelParametersApiError(
      parsed?.error?.code ?? 'http',
      parsed?.error?.message ?? `HTTP ${response.status}`,
    )
  }
  return parsed.value as T
}

export const api = {
  state: () => call<PluginState>('state'),
  refresh: () => call<PluginState>('refresh'),
  reconcile: () => call<PluginState>('reconcile'),
  setConfig: (patch: Partial<ModelParametersConfig>) =>
    call<PluginState>('set-config', { patch }),
}
