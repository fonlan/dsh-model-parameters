/**
 * @fonlan/dsh-model-parameters client half: the plugin's own Settings section.
 *
 * Registers into the settings.section slot, so the page owns one entry in the
 * settings sidebar and renders in the panel's content column. The page itself
 * lives in ./settings-section.
 *
 * Deps resolved from the browser module table: react only. The slots service
 * is reached through the cordis context; types come from devDependencies and
 * are erased at build time.
 */
import type { Context } from '@deepseek-ai/cordis'
type ClientContext = Context
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { LOCALE_NS, zh, en } from './locales'
import { makeSettingsSection } from './settings-section'

/** The settings sidebar entry this page owns (must stay stable). */
const SECTION_ID = 'model-parameters'

/** The slots service face (subset of @deepseek-ai/dsh-client-ui-slots). */
interface SlotEntry {
  name: string
  id?: string
  order?: number
  label?: () => string
  locale?: string
}

interface Slots {
  inject(name: string, register: () => unknown): unknown
  register(def: SlotEntry, component: unknown): unknown
}

/** Services required before mounting (provided by the client runtime). */
export const inject = ['slots', 'locale']

/** Client plugin body. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const off = ctx.locale.register(LOCALE_NS, { zh, en })
    return () => off()
  }, 'model-parameters: dictionaries')

  const t = ctx.locale.bind(LOCALE_NS) as unknown as (key: string) => string
  const Section = makeSettingsSection(ctx)
  const slots = (ctx as unknown as { slots: Slots }).slots
  slots.inject('settings.section', () =>
    slots.register({
      name: 'settings.section',
      id: SECTION_ID,
      order: 320,
      label: () => t('settingsTitle'),
      locale: LOCALE_NS,
    }, Section),
  )
}
