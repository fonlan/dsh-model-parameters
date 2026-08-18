/**
 * @fonlan/dsh-model-parameters client half: the plugin's own Settings Card.
 *
 * Registers into the `settings.plugin.item` slot keyed by the `model-parameters`
 * settings namespace (the same string the host half registers), so the card
 * appears inside 设置 → 插件 → 插件配置, paired with the namespace by the tab —
 * exactly like @fonlan/dsh-web-auth. The card draws its own expandable chrome
 * (external plugins cannot import the built-in PluginCard) with styles aligned
 * to the built-in plugin cards.
 *
 * Deps resolved from the browser module table: react only. The slots service
 * is reached through the cordis context; types come from devDependencies and
 * are erased at build time.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { LOCALE_NS, zh, en } from './locales'
import { makeSettingsCard } from './settings-card'

/** The settings namespace this card edits (must match the host half). */
const PLUGIN_NS = 'model-parameters'

/** The slots service face (subset of @deepseek-ai/dsh-client-ui-slots). */
interface SlotEntry {
  name: string
  key?: string
  inject?: () => unknown
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

  const Card = makeSettingsCard(ctx)
  const slots = (ctx as unknown as { slots: Slots }).slots
  slots.inject('settings.plugin.item', () =>
    slots.register({
      name: 'settings.plugin.item',
      key: PLUGIN_NS,
    }, Card),
  )
}
