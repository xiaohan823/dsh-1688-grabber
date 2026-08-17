/** Package-owned invariant companion. @module @deepseek-ai/dsh-host-1688-grabber/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-1688-grabber'

/** Cordis companion plugin name. */
export const name = 'host-1688-grabber-invariant'
/** Services required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: grabber tasks are process-local and never persisted. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
