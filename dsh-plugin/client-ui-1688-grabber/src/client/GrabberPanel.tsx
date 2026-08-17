/** The 1688 grabber modal panel: batch link input, options, live progress. */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconDownloadOutline16,
  IconFolderOpenOutline16,
  IconLoadingOutline16,
  IconPlayOutline16,
  IconWarningOutline16,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  GrabStatusView,
  GrabOfferResult,
} from '@deepseek-ai/dsh-host-1688-grabber/types'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './index.ts'
import css from './GrabberPanel.module.css'

/** Remote face injected by the plugin apply (bound to ctx.remote.grab1688). */
export interface GrabberInjected {
  /** Start a batch grab; resolves to the stable task id. */
  start: (links: readonly string[], outDir: string, concurrency: number) => Promise<string>
  /** Read one task's current progress. */
  status: (taskId: string) => Promise<GrabStatusView>
  /** Request cancellation of a running task. */
  cancel: (taskId: string) => Promise<void>
  /** Whether the browser extension has handed a cookie to the host. */
  cookieState: () => Promise<{ browserCookieReady: boolean }>
  /** Open the Host's native directory picker; resolves to the chosen path or null on cancel. */
  pickDirectory: () => Promise<string | null>
  /** Open a directory in the host's file manager. */
  openPath: (path: string) => Promise<void>
}

/** Full component props assembled by the slot renderer. */
export type GrabberPanelProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<typeof NS>
  & GrabberInjected

type TaskState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'starting' }
  | { readonly phase: 'running'; readonly view: GrabStatusView }
  | { readonly phase: 'done'; readonly view: GrabStatusView }
  | { readonly phase: 'error'; readonly message: string }

const POLL_MS = 1500

/** One offer row: folder names plus counts, or the failure message. */
function OfferRow({ result, t }: { result: GrabOfferResult; t: PropsLocale<typeof NS>['t'] }): ReactNode {
  const failed = result.error !== undefined
  return (
    <li className={css.offerRow} data-failed={failed ? 'true' : undefined}>
      <span className={css.offerId}>{result.offerId}</span>
      {result.subject !== undefined ? <span className={css.subject} title={result.subject}>{result.subject}</span> : null}
      {failed
        ? <span className={css.offerError} title={result.error}>{result.error}</span>
        : (
          <span className={css.offerStats}>
            <span>{t('mainDir')} × {result.mainCount}</span>
            <span>{t('detailDir')} × {result.detailCount}</span>
          </span>
        )}
    </li>
  )
}

/**
 * The grabber panel: link textarea, save-directory field, concurrency,
 * start/stop controls, and the live per-offer result list. Cookie handling
 * happens in the companion browser extension; this panel only shows whether
 * a cookie has been received and points the user to the extension.
 * @param props - sidebar action seat, locale translator, and the Remote face.
 * @returns the trigger button plus the modal when open.
 */
export function GrabberPanel({ wide, t, start, status, cancel, cookieState, pickDirectory, openPath }: GrabberPanelProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [links, setLinks] = useState('')
  const [outDir, setOutDir] = useState('')
  const [concurrency, setConcurrency] = useState(4)
  const [task, setTask] = useState<TaskState>({ phase: 'idle' })
  const [cookieReady, setCookieReady] = useState<boolean | undefined>(undefined)
  const [pickingDir, setPickingDir] = useState(false)
  const pollTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const stopPolling = useCallback(() => {
    if (pollTimer.current !== undefined) {
      clearInterval(pollTimer.current)
      pollTimer.current = undefined
    }
  }, [])

  // Refresh the browser-cookie handoff state whenever the panel opens, and
  // let the user re-check after they send the cookie from the extension.
  const refreshCookieState = useCallback(() => {
    let current = true
    void cookieState().then(
      state => { if (current) setCookieReady(state.browserCookieReady) },
      () => { if (current) setCookieReady(undefined) },
    )
    return () => { current = false }
  }, [cookieState])

  useEffect(() => {
    if (!open) return
    const cancel = refreshCookieState()
    return cancel
  }, [open, refreshCookieState])

  // Close clears transient state; a running task keeps running server-side
  // (the panel can reopen and poll again by id — but we do not persist ids
  // across reloads, so cancelling is the honest path).
  const close = useCallback(() => {
    stopPolling()
    setOpen(false)
    setTask({ phase: 'idle' })
  }, [stopPolling])

  useEffect(() => stopPolling, [stopPolling])

  const begin = useCallback(async () => {
    const parsed = links.split('\n').map(line => line.trim()).filter(line => line.length > 0)
    if (parsed.length === 0) {
      setTask({ phase: 'error', message: t('emptyLinks') })
      return
    }
    if (outDir.trim().length === 0) {
      setTask({ phase: 'error', message: t('missingOutDir') })
      return
    }
    setTask({ phase: 'starting' })
    try {
      const taskId = await start(parsed, outDir.trim(), concurrency)
      setTask({ phase: 'running', view: { taskId, phase: 'running', completed: 0, total: parsed.length, results: [] } })
      const poll = async (): Promise<void> => {
        try {
          const view = await status(taskId)
          setTask(previous => previous.phase === 'running' || previous.phase === 'done'
            ? { phase: view.phase === 'done' ? 'done' : 'running', view }
            : previous)
          if (view.phase === 'done') stopPolling()
        } catch (error) {
          setTask({ phase: 'error', message: `${t('pollFailed')}${error instanceof Error ? error.message : String(error)}` })
          stopPolling()
        }
      }
      await poll()
      pollTimer.current = setInterval(poll, POLL_MS)
    } catch (error) {
      setTask({ phase: 'error', message: `${t('startFailed')}${error instanceof Error ? error.message : String(error)}` })
    }
  }, [links, outDir, concurrency, start, status, stopPolling, t])

  const stop = useCallback(async () => {
    if (task.phase !== 'running') return
    try {
      await cancel(task.view.taskId)
    } catch {
      // The host may have settled already; polling will reflect it.
    }
  }, [task, cancel])

  const pickDir = useCallback(async () => {
    setPickingDir(true)
    try {
      const path = await pickDirectory()
      if (path !== null) setOutDir(path)
    } catch (error) {
      setTask({ phase: 'error', message: `${t('pickDirFailed')}${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setPickingDir(false)
    }
  }, [pickDirectory, t])

  const view = task.phase === 'running' || task.phase === 'done' ? task.view : undefined
  const running = task.phase === 'starting' || task.phase === 'running'

  return (
    <>
      <button
        type="button"
        className={css.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('trigger')}
        onClick={() => { setOpen(true) }}
      >
        <IconDownloadOutline16 size={16} aria-hidden="true" />
        {wide ? <span className={css.triggerLabel}>{t('trigger')}</span> : null}
      </button>
      <Modal
        open={open}
        onClose={close}
        title={t('panelTitle')}
        description={t('panelDescription')}
        closeLabel={t('close')}
      >
        <div className={css.form}>
          <label className={css.field}>
            <span className={css.label}>{t('linksLabel')}</span>
            <textarea
              className={css.links}
              value={links}
              placeholder={t('linksPlaceholder')}
              rows={6}
              spellCheck={false}
              onChange={(event) => { setLinks(event.currentTarget.value) }}
            />
          </label>
          <div className={css.field}>
            <span className={css.label}>{t('outDirLabel')}</span>
            <div className={css.dirRow}>
              <span className={css.dirPath} data-set={outDir.length > 0 ? 'true' : undefined} title={outDir}>{outDir.length > 0 ? outDir : t('outDirEmpty')}</span>
              <button
                type="button"
                className={css.dirButton}
                onClick={pickDir}
                disabled={pickingDir}
              >
                <IconFolderOpenOutline16 size={14} aria-hidden="true" />
                {pickingDir ? t('pickingDir') : t('chooseDir')}
              </button>
            </div>
          </div>
          <label className={css.field}>
            <span className={css.label}>{t('concurrencyLabel')}</span>
            <input
              className={css.input}
              type="number"
              min={1}
              max={16}
              value={concurrency}
              onChange={(event) => { setConcurrency(Math.max(1, Math.min(16, Number(event.currentTarget.value) || 4))) }}
            />
          </label>

          <div className={css.cookieRow}>
            <div className={css.cookieState}>
              {cookieReady === true
                ? <span className={css.cookieBadge} data-state="ready">{t('cookieReady')}</span>
                : cookieReady === false
                  ? <span className={css.cookieBadge} data-state="empty">{t('cookieEmpty')}</span>
                  : <span className={css.cookieBadge} data-state="unknown">{t('cookieCheckFailed')}</span>}
            </div>
            <button
              type="button"
              className={css.cookieButton}
              onClick={() => {
                // Re-check whether the extension has delivered a cookie.
                refreshCookieState()
                // Open 1688 so the user can click the extension icon there.
                window.open('https://www.1688.com/', '_blank', 'noopener')
              }}
            >
              {t('goExtension')}
            </button>
          </div>
        </div>

        <div className={css.actions}>
          {running
            ? (
              <button type="button" className={css.stopButton} onClick={stop}>
                <IconWarningOutline16 size={14} aria-hidden="true" />
                {t('cancel')}
              </button>
            )
            : (
              <button type="button" className={css.startButton} onClick={begin}>
                <IconPlayOutline16 size={14} aria-hidden="true" />
                {t('start')}
              </button>
            )}
        </div>

        {task.phase === 'error' ? <p className={css.error} role="alert">{task.message}</p> : null}

        {view !== undefined ? (
          <section className={css.progress} aria-label={t('progress')}>
            <div className={css.progressHead}>
              <span className={css.taskId} title={`${t('taskIdLabel')}: ${view.taskId}`}>
                {view.taskId.slice(0, 8)}
              </span>
              {running
                ? <span className={css.runningBadge}><IconLoadingOutline16 size={12} aria-hidden="true" />{t('running')}</span>
                : <span className={css.doneBadge}>{t('done')}</span>}
              <span className={css.progressCount}>{view.completed}/{view.total} {t('offers')}</span>
            </div>
            <ul className={css.offerList}>
              {view.results.map(result => <OfferRow key={result.offerId} result={result} t={t} />)}
            </ul>
            {view.phase === 'done' && view.results.some(result => result.error === undefined) ? (
              <div className={css.openRow}>
                <button
                  type="button"
                  className={css.openButton}
                  onClick={() => {
                    const first = view.results.find(result => result.error === undefined)
                    if (first?.mainDir !== undefined) void openPath(first.mainDir.replace(/[\\/]主图$/, ''))
                  }}
                >
                  {t('openDir')}
                </button>
              </div>
            ) : null}
          </section>
        ) : null}
      </Modal>
    </>
  )
}
