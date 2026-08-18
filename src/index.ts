/**
 * @fonlan/dsh-model-parameters host half.
 *
 * Watches the `llm-pi-ai` settings namespace: whenever provider models are
 * written there with missing display name / context window / max output
 * tokens / reasoning efforts / input modalities (the norm for a freshly
 * synced gateway), it fills the missing fields from a cached models.dev
 * catalog (TTL-refreshed), and serves the fenced JSON API the web settings
 * page calls. The plugin's own toggles live in the `model-parameters`
 * settings namespace (settings.yaml).
 */
import type { Context } from '@deepseek-ai/cordis'
import { Config } from './shared/config.js'
import { ModelParametersService } from './server/service.js'
import { registerApiRoutes } from './server/rpc.js'
import {
  CatalogManager,
  acceptedInputModalities,
  identityReasoningEfforts,
  type CatalogEntry,
  type CatalogSnapshot,
} from './server/catalog.js'

export const name = '@fonlan/dsh-model-parameters'

// Nothing is hard-required at apply time: the settings service is attached
// opportunistically (web, CLI, headless all work — headless profiles just
// expose no settings page), and the web server only exists in web profiles.
export const inject: string[] = []

export { Config }
export { CatalogManager, acceptedInputModalities, identityReasoningEfforts }
export type { CatalogEntry, CatalogSnapshot }

export function apply(ctx: Context): void {
  const service = new ModelParametersService(ctx)

  ctx.effect(() => {
    service.start()
    return () => service.stop()
  }, 'model-parameters: service')

  // The settings-page API only exists where a web server does.
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => registerApiRoutes(sctx, service), 'model-parameters: api routes')
  })
}
