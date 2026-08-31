/**
 * The Model Parameters Settings Card: master + per-field toggles, catalog TTL,
 * provider→models.dev mapping overrides, a manual refresh/fill action, the
 * catalog freshness line, and the last fill report (filled / touched /
 * unmatched).
 *
 * The card registers into the `settings.plugin.item` slot keyed by the
 * `model-parameters` settings namespace, so it renders inside
 * 设置 → 插件 → 插件配置, stacked with the built-in plugin cards. The chrome is
 * self-drawn (external plugins cannot import the built-in PluginCard) with
 * styles aligned to it: an expandable header (collapsed by default) and a body
 * that discloses the controls in place.
 *
 * All reads/mutations go through the plugin's fenced API; config persists into
 * the `model-parameters` settings namespace (settings.yaml).
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
type ClientContext = Context
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { LOCALE_NS } from './locales'
import { api, type PluginState } from './api'
import type { ModelParametersConfig } from '../shared/config.js'
import './settings-card.css'

function useLocaleRevision(ctx: ClientContext): number {
  const subscribe = useCallback(
    (onChange: () => void) => {
      try {
        return ctx.locale.subscribe(onChange)
      } catch {
        return () => {}
      }
    },
    [ctx],
  )
  const getSnapshot = useCallback(() => {
    try {
      return ctx.locale.getLocale().revision
    } catch {
      return 0
    }
  }, [ctx])
  return useSyncExternalStore(subscribe, getSnapshot)
}

function formatTime(epochMs: number): string {
  try {
    return new Date(epochMs).toLocaleString()
  } catch {
    return String(epochMs)
  }
}

export function makeSettingsCard(ctx: ClientContext): () => JSX.Element {
  const t: Translate = (() => {
    try {
      return ctx.locale.bind(LOCALE_NS) as unknown as Translate
    } catch {
      return (key: string) => key
    }
  })()

  return function ModelParametersCard(): JSX.Element {
    useLocaleRevision(ctx)
    // Card-local disclosure: collapsed by default, like the built-in plugin cards.
    const [open, setOpen] = useState(false)
    const [state, setState] = useState<PluginState | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [busy, setBusy] = useState(false)
    const [saving, setSaving] = useState(false)
    const [mappingRows, setMappingRows] = useState<Array<{ from: string; to: string }>>([])
    const [newFrom, setNewFrom] = useState('')
    const [newTo, setNewTo] = useState('')

    const load = useCallback(async () => {
      setLoading(true)
      try {
        const next = await api.state()
        setState(next)
        setMappingRows(Object.entries(next.config.providerMap).map(([from, to]) => ({ from, to })))
        setError(null)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setLoading(false)
      }
    }, [])

    useEffect(() => {
      void load()
    }, [load])

    const patchConfig = useCallback(async (patch: Partial<ModelParametersConfig>) => {
      setSaving(true)
      try {
        const next = await api.setConfig(patch)
        setState(next)
        setMappingRows(Object.entries(next.config.providerMap).map(([from, to]) => ({ from, to })))
        setError(null)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setSaving(false)
      }
    }, [])

    const refresh = useCallback(async () => {
      setBusy(true)
      try {
        setState(await api.refresh())
        setError(null)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    }, [])

    const reconcileNow = useCallback(async () => {
      setBusy(true)
      try {
        setState(await api.reconcile())
        setError(null)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    }, [])

    const applyMappings = useCallback(async () => {
      const providerMap: Record<string, string> = {}
      for (const row of mappingRows) {
        const from = row.from.trim()
        const to = row.to.trim()
        if (from.length > 0 && to.length > 0) providerMap[from] = to
      }
      await patchConfig({ providerMap })
    }, [mappingRows, patchConfig])

    const title = t('settingsTitle')

    return (
      <li className="mp-card" data-open={open ? '' : undefined}>
        <button type="button" className="mp-card-head" aria-expanded={open}
          aria-label={(open ? t('collapse') : t('expand')) + '：' + title}
          onClick={() => setOpen(!open)}>
          <span className="mp-card-headText">
            <span className="mp-card-title">{title}</span>
            <span className="mp-card-sub">{t('cardSub')}</span>
          </span>
          <span className="mp-card-chevron" data-open={open ? '' : undefined} aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3.5 5.25L7 8.75L10.5 5.25" stroke="currentColor" strokeWidth="1.5"
                strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>
        {open && (
          <div className="mp-card-body">
            {error !== null && state === null ? (
              <p className="mp-error">{t('error')}: {error}</p>
            ) : loading || state === null ? (
              <p className="mp-muted">{t('saving')}</p>
            ) : (
              <ModelParametersCardBody
                t={t}
                state={state}
                error={error}
                saving={saving}
                busy={busy}
                mappingRows={mappingRows}
                newFrom={newFrom}
                newTo={newTo}
                setNewFrom={setNewFrom}
                setNewTo={setNewTo}
                setMappingRows={setMappingRows}
                onPatchConfig={patchConfig}
                onRefresh={refresh}
                onReconcile={reconcileNow}
                onApplyMappings={applyMappings}
              />
            )}
          </div>
        )}
      </li>
    )
  }
}

/** The card body: divider-separated control groups, styled like the built-in cards. */
function ModelParametersCardBody(props: {
  t: Translate
  state: PluginState
  error: string | null
  saving: boolean
  busy: boolean
  mappingRows: Array<{ from: string; to: string }>
  newFrom: string
  newTo: string
  setNewFrom: (value: string) => void
  setNewTo: (value: string) => void
  setMappingRows: (rows: Array<{ from: string; to: string }>) => void
  onPatchConfig: (patch: Partial<ModelParametersConfig>) => Promise<void>
  onRefresh: () => Promise<void>
  onReconcile: () => Promise<void>
  onApplyMappings: () => Promise<void>
}): JSX.Element {
  const {
    t, state, error, saving, busy,
    mappingRows, newFrom, newTo,
    setNewFrom, setNewTo, setMappingRows,
    onPatchConfig, onRefresh, onReconcile, onApplyMappings,
  } = props

  const config = state.config
  const catalog = state.catalog
  const report = state.report

  return (
    <div className="mp-body">
      <section className="mp-group">
        <h4 className="mp-group-title">{t('fields')}</h4>
        <label className="mp-toggle">
          <input
            type="checkbox"
            checked={config.enabled}
            disabled={saving}
            onChange={(event) => void onPatchConfig({ enabled: event.target.checked })}
          />
          <span className="mp-toggle-body">
            <span className="mp-toggle-label">{t('master')}</span>
            <span className="mp-toggle-desc">{t('masterDesc')}</span>
          </span>
        </label>
        {([
          ['fillName', t('fillName'), t('fillNameDesc')],
          ['fillContext', t('fillContext'), t('fillContextDesc')],
          ['fillMaxTokens', t('fillMaxTokens'), t('fillMaxTokensDesc')],
          ['fillReasoning', t('fillReasoning'), t('fillReasoningDesc')],
          ['fillInput', t('fillInput'), t('fillInputDesc')],
        ] as const).map(([key, label, desc]) => (
          <label className="mp-toggle mp-toggle-sub" key={key}>
            <input
              type="checkbox"
              checked={config[key]}
              disabled={saving || !config.enabled}
              onChange={(event) => void onPatchConfig({ [key]: event.target.checked })}
            />
            <span className="mp-toggle-body">
              <span className="mp-toggle-label">{label}</span>
              <span className="mp-toggle-desc">{desc}</span>
            </span>
          </label>
        ))}
      </section>

      <hr className="mp-divider" />

      <section className="mp-group">
        <h4 className="mp-group-title">{t('catalog')}</h4>
        <div className="mp-meta">
          <span>{t('catalogEntries')}: <strong>{catalog.entries.toLocaleString()}</strong></span>
          <span>{t('catalogProviders')}: <strong>{catalog.providers.toLocaleString()}</strong></span>
          <span>
            {t('catalogFetched')}:{' '}
            <strong>{catalog.fetchedAt > 0 ? formatTime(catalog.fetchedAt) : t('catalogNever')}</strong>{' '}
            {catalog.fetchedAt > 0 && (
              <span className={catalog.fresh ? 'mp-badge mp-badge-ok' : 'mp-badge mp-badge-warn'}>
                {catalog.fresh ? t('catalogFresh') : t('catalogStale')}
              </span>
            )}
          </span>
          <label className="mp-ttl">
            {t('ttl')}
            <input
              className="mp-input mp-input-narrow"
              type="number"
              min={1}
              max={90}
              value={config.ttlDays}
              disabled={saving}
              onChange={(event) => {
                const days = Number(event.target.value)
                if (Number.isFinite(days) && days >= 1 && days <= 90) void onPatchConfig({ ttlDays: Math.round(days) })
              }}
            />
          </label>
        </div>
        <div className="mp-actions">
          <button className="mp-button" disabled={busy} onClick={() => void onRefresh()}>
            {busy ? t('refreshBusy') : t('refresh')}
          </button>
          <button className="mp-button mp-button-ghost" disabled={busy} onClick={() => void onReconcile()}>
            {t('reconcileNow')}
          </button>
        </div>
      </section>

      <hr className="mp-divider" />

      <section className="mp-group">
        <h4 className="mp-group-title">{t('providerMap')}</h4>
        <p className="mp-desc">{t('providerMapDesc')}</p>
        {mappingRows.map((row, index) => (
          <div className="mp-map-row" key={index}>
            <input
              className="mp-input"
              value={row.from}
              disabled={saving}
              onChange={(event) => {
                const next = [...mappingRows]
                next[index] = { ...row, from: event.target.value }
                setMappingRows(next)
              }}
            />
            <span className="mp-map-arrow">→</span>
            <input
              className="mp-input"
              value={row.to}
              disabled={saving}
              onChange={(event) => {
                const next = [...mappingRows]
                next[index] = { ...row, to: event.target.value }
                setMappingRows(next)
              }}
            />
            <button
              className="mp-button mp-button-ghost"
              disabled={saving}
              onClick={() => setMappingRows(mappingRows.filter((_, i) => i !== index))}
            >
              {t('removeMapping')}
            </button>
          </div>
        ))}
        <div className="mp-map-row">
          <input
            className="mp-input"
            placeholder="dsh provider"
            value={newFrom}
            onChange={(event) => setNewFrom(event.target.value)}
          />
          <span className="mp-map-arrow">→</span>
          <input
            className="mp-input"
            placeholder="models.dev provider"
            value={newTo}
            onChange={(event) => setNewTo(event.target.value)}
          />
          <button
            className="mp-button mp-button-ghost"
            disabled={newFrom.trim().length === 0 || newTo.trim().length === 0}
            onClick={() => {
              setMappingRows([...mappingRows, { from: newFrom.trim(), to: newTo.trim() }])
              setNewFrom('')
              setNewTo('')
            }}
          >
            {t('addMapping')}
          </button>
        </div>
        <div className="mp-actions">
          <button className="mp-button" disabled={saving} onClick={() => void onApplyMappings()}>
            {saving ? t('saving') : '✓ ' + t('providerMap')}
          </button>
        </div>
      </section>

      <hr className="mp-divider" />

      <section className="mp-group">
        <h4 className="mp-group-title">{t('report')}</h4>
        {report === null ? (
          <p className="mp-muted">{t('reportNever')}</p>
        ) : (
          <ul className="mp-report">
            <li>{t('reportAt')}: {formatTime(report.at)}</li>
            <li>{t('reportFilled')}: <strong>{report.filled}</strong></li>
            <li>{t('reportTouched')}: <strong>{report.touched}</strong></li>
            <li>
              {t('reportUnmatched')}:{' '}
              {report.unmatched.length === 0
                ? t('reportEmpty')
                : <code className="mp-code">{report.unmatched.join(', ')}</code>}
            </li>
          </ul>
        )}
      </section>

      {error !== null && <p className="mp-error">{error}</p>}
    </div>
  )
}
