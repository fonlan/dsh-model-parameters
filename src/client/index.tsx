/**
 * @fonlan/dsh-model-parameters client half: the Model Parameters settings
 * page, registered into the settings section slot.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { LOCALE_NS, zh, en } from './locales'
import { makeSettingsSection } from './settings-section'

/** Services required before mounting (provided by the client runtime). */
export const inject = ['slots', 'locale']

/** Client plugin body. */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(LOCALE_NS)
  ctx.effect(() => {
    const off = ctx.locale.register(LOCALE_NS, { zh, en })
    return () => off()
  }, 'model-parameters: dictionaries')

  const SettingsSection = makeSettingsSection(ctx)
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section',
      id: 'model-parameters',
      order: 320,
      label: () => t('settingsTitle'),
      locale: LOCALE_NS,
    }, SettingsSection as never),
  )
}
