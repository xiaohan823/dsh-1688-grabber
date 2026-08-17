/**
 * 1688 image grabber, host half. A Remote service that downloads the main
 * gallery and detail-page images of 1688 offers into per-offer folders:
 *
 *   <outDir>/<offerId>/主图/0001.jpg ...
 *   <outDir>/<offerId>/详情页/0001.jpg ...
 *
 * The Remote surface is task-oriented (`start` returns immediately, `status`
 * is polled) because a batch download can run far longer than the RPC
 * transport's bounded-call timeout.
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Type-only: pulls the webServer Context merge (ctx.webServer) into this program.
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  downloadImage,
  extractHtmlImages,
  isPlaceholderImage,
  unwrapOfferDetails,
} from './download.ts'
import {
  MtopError,
  MtopSession,
  extractContextModel,
  extractDescriptionUrl,
  extractDetailImages,
  extractMainImages,
  extractMobileModel,
  extractSubject,
} from './mtop.ts'
import type {
  GrabCancelRequest,
  GrabOfferResult,
  GrabStartRequest,
  GrabStartValue,
  GrabStatusView,
  OfferRef,
} from './types.ts'

export type * from './types.ts'

/** Default concurrency for image downloads within one offer. */
const DEFAULT_CONCURRENCY = 4
/** Directory names per the product requirement. */
const MAIN_DIR = '主图'
const DETAIL_DIR = '详情页'

interface RunningTask {
  readonly taskId: string
  readonly startedAt: number
  readonly total: number
  cancelRequested: boolean
  readonly results: GrabOfferResult[]
}

/** Offer id extracted from a link, or undefined when the link is unrecognized. */
function offerIdFromLink(link: string): string | undefined {
  const trimmed = link.trim()
  if (trimmed.length === 0) return undefined
  // detail.1688.com/offer/<id>.html 鈥?also m.1688.com, item.1688.com.
  const offer = /(?:detail|m|item)\.1688\.com\/offer\/(\d+)/i.exec(trimmed)
  if (offer !== null) return offer[1]!
  // A bare numeric id is accepted as-is.
  if (/^\d{5,}$/.test(trimmed)) return trimmed
  return undefined
}

function parseLinks(links: readonly string[]): OfferRef[] {
  const refs: OfferRef[] = []
  const seen = new Set<string>()
  for (const line of links) {
    const offerId = offerIdFromLink(line)
    if (offerId === undefined) continue
    if (seen.has(offerId)) continue
    seen.add(offerId)
    refs.push({ link: line.trim(), offerId })
  }
  return refs
}

/**
 * Grab one offer: fetch the detail model (miniod first, then HTML fallbacks),
 * save main images and detail-page images into their folders.
 */
async function grabOffer(
  offerId: string,
  outDir: string,
  concurrency: number,
  cookie: string | undefined,
  fetchImpl: typeof fetch,
): Promise<GrabOfferResult> {
  const mainDir = join(outDir, offerId, MAIN_DIR)
  const detailDir = join(outDir, offerId, DETAIL_DIR)
  await mkdir(mainDir, { recursive: true })
  await mkdir(detailDir, { recursive: true })

  const session = new MtopSession(cookie, fetchImpl)
  let model: Record<string, unknown> | undefined
  let primaryError: unknown
  try {
    model = await fetchOfferModel(session, offerId)
  } catch (error) {
    primaryError = error
    // Fall back to HTML sources when the MTOP API is blocked (risk control).
    model = await fetchHtmlModel(offerId, cookie, fetchImpl)
  }
  if (model === undefined) {
    return {
      offerId,
      mainDir,
      detailDir,
      mainCount: 0,
      detailCount: 0,
      error: primaryError instanceof Error ? primaryError.message : String(primaryError),
    }
  }

  try {
    const subject = extractSubject(model)
    const mainImages = extractMainImages(model).filter(url => !isPlaceholderImage(url))
    const mainCount = await downloadAll(mainImages, mainDir, concurrency, fetchImpl)

    // Detail-page images come straight from the model when available
    // (detailDescription.images); otherwise fall back to fetching the
    // description page HTML.
    const detailImages = extractDetailImages(model).filter(url => !isPlaceholderImage(url))
    let detailCount = 0
    if (detailImages.length > 0) {
      detailCount = await downloadAll(detailImages, detailDir, concurrency, fetchImpl)
    } else {
      const descriptionUrl = extractDescriptionUrl(model)
      if (descriptionUrl !== undefined) {
        detailCount = await grabDetailImages(descriptionUrl, detailDir, concurrency, fetchImpl)
      }
    }

    const empty = mainCount === 0 && detailCount === 0
    const result: GrabOfferResult = {
      offerId,
      ...(subject === undefined ? {} : { subject }),
      mainDir,
      detailDir,
      mainCount,
      detailCount,
      ...(empty
        ? { error: 'no images were found or downloaded (risk control or removed offer)' }
        : {}),
    }
    return result
  } catch (error) {
    return {
      offerId,
      mainDir,
      detailDir,
      mainCount: 0,
      detailCount: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Fetch and unwrap the miniod detail model for one offer. */
async function fetchOfferModel(
  session: MtopSession,
  offerId: string,
): Promise<Record<string, unknown>> {
  const response = await session.call('mtop.1688.laputa.miniod', {
    sk: '',
    offerId: Number(offerId),
    parametersMap: JSON.stringify({ fromPC: true }),
  })
  const data = response.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new MtopError(`MTOP miniod returned no data model for offer ${offerId}`, response.ret)
  }
  const model = (data as Record<string, unknown>).model
  if (model === null || typeof model !== 'object' || Array.isArray(model)) {
    throw new MtopError(`MTOP miniod returned no model for offer ${offerId}`, response.ret)
  }
  return model as Record<string, unknown>
}

/**
 * HTML fallback chain for one offer, used when the MTOP API is blocked.
 * Tries the desktop SSR page (detail.1688.com, works best with a cookie),
 * then the mobile page (m.1688.com). Returns the first parseable model, or
 * undefined when every source is blocked or carries no data.
 */
async function fetchHtmlModel(
  offerId: string,
  cookie: string | undefined,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown> | undefined> {
  const headers: Record<string, string> = {
    'User-Agent': [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'AppleWebKit/537.36 (KHTML, like Gecko)',
      'Chrome/125.0.0.0 Safari/537.36',
    ].join(' '),
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Referer: 'https://www.1688.com/',
  }
  if (cookie !== undefined && cookie.length > 0) headers['Cookie'] = cookie

  // 1. Desktop SSR page: richest source, usually requires the logged-in cookie.
  try {
    const desktop = await fetchImpl(`https://detail.1688.com/offer/${offerId}.html`, { headers })
    if (desktop.ok) {
      const html = await desktop.text()
      if (!html.includes('_____tmd_____')) {
        const model = extractContextModel(html)
        if (model !== undefined) return model
      }
    }
  } catch {
    // Fall through to the mobile source.
  }

  // 2. Mobile page.
  try {
    const mobile = await fetchImpl(`https://m.1688.com/offer/${offerId}.html`, {
      headers: {
        ...headers,
        'User-Agent': [
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
          'AppleWebKit/605.1.15 (KHTML, like Gecko)',
          'Version/17.0 Mobile/15E148 Safari/604.1',
        ].join(' '),
      },
    })
    if (mobile.ok) {
      const html = await mobile.text()
      if (!html.includes('_____tmd_____')) {
        const model = extractMobileModel(html)
        if (model !== undefined) return model
      }
    }
  } catch {
    // No usable HTML source.
  }
  return undefined
}

/** Fetch one detail-page URL and save every extracted image. */
async function grabDetailImages(
  url: string,
  detailDir: string,
  concurrency: number,
  fetchImpl: typeof fetch,
): Promise<number> {
  const absolute = url.startsWith('//') ? `https:${url}` : url
  const res = await fetchImpl(absolute, {
    headers: {
      'User-Agent': [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'AppleWebKit/537.36 (KHTML, like Gecko)',
        'Chrome/125.0.0.0 Safari/537.36',
      ].join(' '),
      Accept: 'text/html,application/xhtml+xml',
      Referer: 'https://detail.1688.com/',
    },
  })
  if (!res.ok) return 0
  const raw = await res.text()
  const html = unwrapOfferDetails(raw)
  const images = extractHtmlImages(html).filter(url => !isPlaceholderImage(url))
  return downloadAll(images, detailDir, concurrency, fetchImpl)
}

/** Download a list of image URLs with bounded concurrency; returns the saved count. */
async function downloadAll(
  urls: readonly string[],
  dir: string,
  concurrency: number,
  fetchImpl: typeof fetch,
): Promise<number> {
  let saved = 0
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, urls.length)) }, async () => {
    while (true) {
      const index = next++
      if (index >= urls.length) return
      const path = await downloadImage(urls[index]!, dir, index + 1, fetchImpl)
      if (path !== undefined) saved++
    }
  })
  await Promise.all(workers)
  return saved
}

/**
 * The 1688 grabber Remote service. One instance per host process; tasks are
 * tracked in memory and are gone on restart.
 *
 * Besides the Remote surface it exposes one plain HTTP route,
 * `/api/grab1688/browser-cookie`, which the companion browser extension
 * POSTs the user's logged-in 1688 cookie to. The stored cookie is used as a
 * fallback when a grab request does not carry its own.
 */
export class GrabberService extends TypertRemoteService {
  static inject = ['webServer']

  private readonly tasks = new Map<string, RunningTask>()
  private browserCookie: string | undefined

  constructor(ctx: Context) {
    super(ctx, 'grab1688')
    this.loadPersistedCookie()
  }

  /** Register the browser-extension cookie route once webServer is ready. */
  protected [Service.init](): void {
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'exact',
      path: '/api/grab1688/browser-cookie',
      handler: (req, res) => void this.receiveBrowserCookie(req, res),
    }), 'grab1688: browser-cookie route')
  }

  /**
   * Persist the browser cookie to the host home directory so a restart keeps
   * it. Returns the file path, or undefined when the home directory is
   * unavailable.
   */
  private cookieStorePath(): string | undefined {
    const home = process.env.DSH_HOME ?? process.env.HOME ?? process.env.USERPROFILE
    if (home === undefined || home.length === 0) return undefined
    return join(home, '.dsh', 'grab1688-cookie.json')
  }

  /** Load the persisted browser cookie, if any. */
  private loadPersistedCookie(): void {
    const path = this.cookieStorePath()
    if (path === undefined) return
    try {
      const { readFileSync } = require('node:fs') as typeof import('node:fs')
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { cookie?: unknown }
      if (typeof parsed.cookie === 'string' && parsed.cookie.length > 0) {
        this.browserCookie = parsed.cookie
      }
    } catch {
      // No persisted cookie yet (or unreadable) 鈥?fine.
    }
  }

  /** Persist the current browser cookie to disk (best-effort). */
  private persistCookie(cookie: string): void {
    const path = this.cookieStorePath()
    if (path === undefined) return
    try {
      const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, JSON.stringify({ cookie }), 'utf8')
    } catch {
      // Persistence is best-effort; an in-memory cookie still works this run.
    }
  }

  /** Handle the browser-extension cookie handoff (plain JSON body). */
  private async receiveBrowserCookie(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 1_000_000) break
    }
    let parsed: { cookie?: unknown } = {}
    try {
      parsed = JSON.parse(body) as { cookie?: unknown }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }))
      return
    }
    if (typeof parsed.cookie !== 'string' || parsed.cookie.trim().length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'missing cookie string' }))
      return
    }
    this.browserCookie = parsed.cookie.trim()
    this.persistCookie(this.browserCookie)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  }

  /**
   * Whether a browser-extension cookie is currently stored on the host.
   * The GUI uses this to show the one-click handoff state.
   */
  @Remote('cookieState')
  cookieState(): { browserCookieReady: boolean } {
    return { browserCookieReady: this.browserCookie !== undefined }
  }

  /**
   * Start a batch grab. The task runs in the background; poll {@link status}
   * with the returned task id for progress.
   * @param request - offer links plus output options.
   * @returns a stable task id.
   */
  @Remote('start')
  async start(request: GrabStartRequest): Promise<GrabStartValue> {
    const refs = parseLinks(request.links)
    if (refs.length === 0) {
      throw new Error('1688-grabber: no recognizable offer links (expected detail.1688.com/offer/<id>.html)')
    }
    if (request.outDir.trim().length === 0) {
      throw new Error('1688-grabber: outDir is required')
    }
    const taskId = randomUUID()
    const task: RunningTask = {
      taskId,
      startedAt: Date.now(),
      total: refs.length,
      cancelRequested: false,
      results: [],
    }
    this.tasks.set(taskId, task)
    const concurrency = Number.isSafeInteger(request.concurrency) && (request.concurrency ?? 0) > 0
      ? request.concurrency!
      : DEFAULT_CONCURRENCY
    // Explicit per-request cookie wins; otherwise fall back to the browser
    // extension's stored cookie.
    const cookie = request.cookie !== undefined && request.cookie.trim().length > 0
      ? request.cookie.trim()
      : this.browserCookie
    void this.run(task, refs, request.outDir, concurrency, cookie)
    return { taskId }
  }

  /** Run the batch to completion, appending results in input order. */
  private async run(
    task: RunningTask,
    refs: readonly OfferRef[],
    outDir: string,
    concurrency: number,
    cookie: string | undefined,
  ): Promise<void> {
    for (const ref of refs) {
      if (task.cancelRequested) break
      const result = await grabOffer(ref.offerId, outDir, concurrency, cookie, fetch)
      task.results.push(result)
    }
    // Keep the task row so status() can still answer 'done' with all results.
    // A stale-task sweep is unnecessary: tasks are bounded by user batches.
  }

  /**
   * Read the current view of one task.
   * @param request - task id.
   * @returns phase, progress, and per-offer results.
   */
  @Remote('status')
  status(request: { taskId: string }): GrabStatusView {
    const task = this.tasks.get(request.taskId)
    if (task === undefined) {
      throw new Error(`1688-grabber: unknown task "${request.taskId}"`)
    }
    const phase: 'running' | 'done' = task.results.length < task.total ? 'running' : 'done'
    return {
      taskId: task.taskId,
      phase,
      completed: task.results.length,
      total: task.total,
      results: [...task.results],
    }
  }

  /**
   * Request cancellation of a running task. Settled tasks ignore the call.
   * @param request - task id.
   */
  @Remote('cancel')
  cancel(request: GrabCancelRequest): void {
    const task = this.tasks.get(request.taskId)
    if (task !== undefined) task.cancelRequested = true
  }
}

export default GrabberService
