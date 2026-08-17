/**
 * 1688 image grabber, browser half. Registers a sidebar-footer action that
 * opens the grab panel; the panel drives the host's `grab1688` Remote
 * namespace (start/status/cancel) plus the host `openPath` surface.
 */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the sidebar footer-action slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { GrabberPanel, type GrabberInjected } from './GrabberPanel.tsx'
import { en, zh, type GrabberLocaleKey } from './locales.ts'

export type { GrabberInjected, GrabberPanelProps } from './GrabberPanel.tsx'
export type { GrabberLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 1688 grabber panel copy. */
    'grabber1688': GrabberLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'grabber1688'

/** Services required: the slot ledger, locale registry, workspaces (openPath), and the grab Remote face. */
export const inject = ['slots', 'locale', 'workspaces', 'remote', 'remote.grab1688']

/** Throw the Remote failure payload as a plain Error with its code. */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}

/**
 * Register the grabber trigger at the sidebar foot.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-1688-grabber: dictionaries')

  const injected = (): GrabberInjected => ({
    start: async (links, outDir, concurrency) => {
      const result = await ctx.remote.grab1688.start({ links, outDir, concurrency })
      return unwrap(result).taskId
    },
    status: async (taskId) => {
      const result = await ctx.remote.grab1688.status({ taskId })
      return unwrap(result)
    },
    cancel: async (taskId) => {
      const result = await ctx.remote.grab1688.cancel({ taskId })
      unwrap(result)
    },
    cookieState: async () => {
      const result = await ctx.remote.grab1688.cookieState()
      return unwrap(result)
    },
    pickDirectory: async () => {
      return ctx.workspaces.pickDirectory()
    },
    openPath: async (path) => {
      await ctx.workspaces.openPath(path)
    },
  })

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'grabber1688',
    order: 30,
    locale: NS,
    inject: injected,
  }, GrabberPanel))
}
