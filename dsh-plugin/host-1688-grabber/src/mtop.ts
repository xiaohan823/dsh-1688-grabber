/**
 * 1688 MTOP protocol client: anonymous token acquisition plus signed API
 * calls, and the offer-detail data model extraction helpers.
 *
 * The protocol (reverse-engineered from lib-mtop.js v2.7.4):
 *   sign = MD5(token + "&" + ts + "&" + appKey + "&" + data)
 *   gateway = https://h5api.m.1688.com/h5/{api}/{version}/
 *
 * Token acquisition needs no cookie: calling any API with the literal token
 * "undefined" in the signature makes the server answer a Set-Cookie with a
 * real `_m_h5_tk`, whose first underscore-segment is the signing token.
 */

import { createHash } from 'node:crypto'

const APP_KEY = '12574478'
const BASE_URL = 'https://h5api.m.1688.com/h5'
const USER_AGENT = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'AppleWebKit/537.36 (KHTML, like Gecko)',
  'Chrome/125.0.0.0 Safari/537.36',
].join(' ')

const TOKEN_RE = /_m_h5_tk=([^;]+)/

/** A business failure carrying the server's ret code(s). */
export class MtopError extends Error {
  constructor(
    message: string,
    readonly ret: readonly string[] = [],
  ) {
    super(message)
    this.name = 'MtopError'
  }
}

interface MtopResponse {
  readonly api: string
  readonly v: string
  readonly data: unknown
  readonly ret: readonly string[]
  readonly traceId?: string
}

/** One signed MTOP call. */
export class MtopSession {
  private token: string | undefined
  private cookies: string[] = []
  private readonly headers: Record<string, string>

  constructor(cookie?: string, fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl
    this.headers = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://detail.1688.com',
      Referer: 'https://detail.1688.com/',
    }
    if (cookie !== undefined && cookie.length > 0) {
      const m = TOKEN_RE.exec(cookie)
      if (m !== null && m[1] !== undefined) this.token = m[1].split('_')[0]!
      this.cookies.push(cookie.split(';').map(part => part.trim()).filter(Boolean).join('; '))
    }
  }

  private readonly fetchImpl: typeof fetch

  /** Whether a signing token is available (own cookie or anonymous login). */
  hasToken(): boolean {
    return this.token !== undefined
  }

  /**
   * Acquire a signing token anonymously. No cookie required: the server
   * hands back a real `_m_h5_tk` in Set-Cookie when the request is signed
   * with the literal token "undefined".
   * @returns whether a token is now available.
   */
  async login(): Promise<boolean> {
    if (this.token !== undefined) return true
    try {
      const ts = String(Date.now())
      const raw = `undefined&${ts}&${APP_KEY}&{}`
      const sign = createHash('md5').update(raw).digest('hex')
      const url = `${BASE_URL}/mtop.1688.moga.pc.shopcard/1.0/`
        + `?jsv=2.7.4&appKey=${APP_KEY}&t=${ts}&sign=${sign}`
        + '&api=mtop.1688.moga.pc.shopcard&v=1.0&type=originaljson&dataType=jsonp&timeout=20000'
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.headers,
        body: 'data={}',
      })
      const setCookie = res.headers.get('set-cookie') ?? ''
      const m = TOKEN_RE.exec(setCookie)
      if (m !== null) this.token = m[1]!.split('_')[0]
      for (const part of setCookie.split(',')) {
        const kv = part.split(';')[0]!.trim()
        if (kv.includes('=') && !this.cookies.includes(kv)) this.cookies.push(kv)
      }
      return this.token !== undefined
    } catch {
      return false
    }
  }

  /**
   * Perform one signed MTOP call.
   * @param api - API name, e.g. `mtop.1688.laputa.miniod`.
   * @param data - business payload object.
   * @param version - API version.
   * @returns the parsed MTOP response envelope.
   */
  async call(api: string, data: Record<string, unknown>, version = '1.0'): Promise<MtopResponse> {
    if (this.token === undefined) {
      if (!(await this.login())) {
        throw new MtopError('MTOP token acquisition failed (network or risk control)', [])
      }
    }
    const ts = String(Date.now())
    const ds = JSON.stringify(data ?? {})
    const sign = createHash('md5').update(`${this.token}&${ts}&${APP_KEY}&${ds}`).digest('hex')
    const params = new URLSearchParams({
      jsv: '2.7.4',
      appKey: APP_KEY,
      t: ts,
      sign,
      api,
      v: version,
      type: 'originaljson',
      dataType: 'jsonp',
      timeout: '20000',
      '_bx-login': 'new',
    })
    const url = `${BASE_URL}/${api.toLowerCase()}/${version.toLowerCase()}/?${params.toString()}`
    const headers = { ...this.headers }
    if (this.cookies.length > 0) headers['Cookie'] = this.cookies.join('; ')
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: `data=${encodeURIComponent(ds)}`,
    })
    const setCookie = res.headers.get('set-cookie')
    if (setCookie !== null) {
      const m = TOKEN_RE.exec(setCookie)
      if (m !== null) this.token = m[1]!.split('_')[0]
    }
    let envelope: {
      ret?: unknown
      data?: unknown
      api?: unknown
      v?: unknown
      traceId?: unknown
    }
    try {
      envelope = JSON.parse(await res.text()) as typeof envelope
    } catch {
      throw new MtopError(`MTOP ${api} returned a non-JSON response (HTTP ${res.status})`, [])
    }
    const ret = Array.isArray(envelope.ret)
      ? (envelope.ret as string[])
      : typeof envelope.ret === 'string'
        ? [envelope.ret]
        : []
    if (!ret.some(line => line.startsWith('SUCCESS'))) {
      throw new MtopError(`MTOP ${api} failed: ${ret.join(' | ') || 'unknown'}`, ret)
    }
    return {
      api: typeof envelope.api === 'string' ? envelope.api : api,
      v: typeof envelope.v === 'string' ? envelope.v : version,
      data: envelope.data,
      ret,
      ...(typeof envelope.traceId === 'string' ? { traceId: envelope.traceId } : {}),
    }
  }
}

// ── data-model extraction ──────────────────────────────────────────────────

/** One image URL as found inside the miniod detail model. */
export interface ExtractedImage {
  readonly url: string
}

/** Normalize a possibly-relative alicdn URL to an absolute https URL. */
export function absoluteImageUrl(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) return trimmed
  if (trimmed.startsWith('//')) return `https:${trimmed}`
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed
  // Relative path against the alicdn image CDN.
  return `https:${trimmed.startsWith('/') ? trimmed : `/${trimmed}`}`
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Extract main-image URLs from the miniod detail model. Real field shapes:
 * `offerDetail.imageList` / `mainImageList` are arrays of objects carrying
 * `imageURI` / `fullPathImageURI` (plus `summImageURI` etc.); the gallery
 * fields carry `offerImgList`. Deduplicates in first-seen order, preferring
 * the full-size URI.
 */
export function extractMainImages(model: Record<string, unknown>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (value: unknown): void => {
    const url = imageUrlFromEntry(value)
    if (url === undefined) return
    const abs = absoluteImageUrl(url)
    if (!seen.has(abs)) {
      seen.add(abs)
      out.push(abs)
    }
  }
  const offerDetail = asRecord(asRecord(model.offerModel)?.offerDetail)
  const dataModel = asRecord(model.dataModel)
  const gallery = asRecord(dataModel?.gallery)
  const galleryFields = asRecord(gallery?.fields)
  const candidates: unknown[] = [
    asRecord(offerDetail)?.imageList,
    asRecord(offerDetail)?.mainImageList,
    galleryFields?.offerImgList,
    galleryFields?.mainImage,
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) candidate.forEach(push)
    else push(candidate)
  }
  return out
}

/**
 * Extract the detail-page content from the miniod detail model. The real
 * shape is `offerModel.detailDescription.images` (array of objects with
 * `fullPathImageURI`) plus `urls` (array of URL strings). Falls back to the
 * legacy `dataModel.description`/`offerDetail.descUrl` shapes.
 */
export function extractDetailImages(model: Record<string, unknown>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (value: unknown): void => {
    const url = imageUrlFromEntry(value)
    if (url === undefined) return
    const abs = absoluteImageUrl(url)
    if (!seen.has(abs)) {
      seen.add(abs)
      out.push(abs)
    }
  }
  const offerModel = asRecord(model.offerModel)
  const detailDescription = asRecord(offerModel?.detailDescription)
  const images = detailDescription?.images
  const urls = detailDescription?.urls
  if (Array.isArray(images)) images.forEach(push)
  if (Array.isArray(urls)) urls.forEach(push)
  // Legacy fallbacks.
  const dataModel = asRecord(model.dataModel)
  const description = asRecord(dataModel?.description)
  const legacy = description?.url ?? description?.descUrl
  if (typeof legacy === 'string' && legacy.length > 0) push(legacy)
  return out
}

/**
 * Extract the detail-page URL from the miniod detail model. The real shape
 * is `offerDetail.detailUrl` — a link to the itemcdn HTML carrying the
 * detail-page images. Falls back to the legacy
 * `dataModel.description.url` / `offerDetail.descUrl` shapes.
 */
export function extractDescriptionUrl(model: Record<string, unknown>): string | undefined {
  const offerDetail = asRecord(asRecord(model.offerModel)?.offerDetail)
  const detailUrl = offerDetail?.detailUrl
  if (typeof detailUrl === 'string' && detailUrl.length > 0) return detailUrl
  const dataModel = asRecord(model.dataModel)
  const description = dataModel?.description
  if (description !== undefined) {
    const asObj = asRecord(description)
    const url = asObj?.url ?? asObj?.descUrl ?? asObj?.desc_url
    const resolved = stringOrUndefined(url) ?? stringOrUndefined(description)
    if (resolved !== undefined && resolved.length > 0) return resolved
  }
  const descUrl = offerDetail?.descUrl ?? offerDetail?.desc_url
  return stringOrUndefined(descUrl)
}

/** Product title from the detail model (best-effort). */
export function extractSubject(model: Record<string, unknown>): string | undefined {
  const offerDetail = asRecord(asRecord(model.offerModel)?.offerDetail)
  const dataModel = asRecord(model.dataModel)
  return stringOrUndefined(offerDetail?.subject)
    ?? stringOrUndefined(dataModel?.productTitle)
    ?? stringOrUndefined(dataModel?.title)
}

function imageUrlFromEntry(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry
  const record = asRecord(entry)
  if (record === undefined) return undefined
  return stringOrUndefined(record.fullPathImageURI)
    ?? stringOrUndefined(record.imageURI)
    ?? stringOrUndefined(record.imageUrl)
    ?? stringOrUndefined(record.image)
    ?? stringOrUndefined(record.url)
    ?? stringOrUndefined(record.src)
}

// ── HTML-based fallback extraction ─────────────────────────────────────────

/**
 * Parse `window.context = {...}` out of a detail.1688.com SSR page and
 * project it onto the same model shape the miniod path consumes.
 *
 * Known SSR shape (ai-reverse precedent):
 *   window.context = { result: { data: { offerDetail: ..., dataModel: ... } } }
 */
export function extractContextModel(html: string): Record<string, unknown> | undefined {
  const m = /window\.context\s*=\s*(\{[\s\S]*?\});/i.exec(html)
  if (m === null || m[1] === undefined) return undefined
  try {
    const context = JSON.parse(m[1]) as Record<string, unknown>
    const data = asRecord(asRecord(context.result)?.data)
    if (data === undefined) return undefined
    const model: Record<string, unknown> = {}
    if (data.offerDetail !== undefined) model.offerModel = { offerDetail: data.offerDetail }
    if (data.dataModel !== undefined) model.dataModel = data.dataModel
    // Some SSR variants put the detail under `offerDetail` / `dataModel` directly.
    if (data.imageList !== undefined || data.mainImageList !== undefined) {
      model.offerModel = { offerDetail: data }
    }
    if (Object.keys(model).length === 0) return undefined
    return model
  } catch {
    return undefined
  }
}

/**
 * Parse a m.1688.com mobile page for embedded offer data. The mobile shell
 * usually renders client-side, so this only helps when the page carries
 * inline JSON (`@page/data` define blocks or a `window.context`-style blob).
 */
export function extractMobileModel(html: string): Record<string, unknown> | undefined {
  // The mobile page embeds `define("@page/data", function(n,i,e){e.exports={...}})`.
  const m = /define\("@page\/data",function\([^)]*\)\{e\.exports=(\{[\s\S]*?\})\}\);/i.exec(html)
  if (m === null || m[1] === undefined) return undefined
  try {
    const data = JSON.parse(m[1]) as Record<string, unknown>
    const model: Record<string, unknown> = {}
    if (data.offerDetail !== undefined) model.offerModel = { offerDetail: data.offerDetail }
    if (data.dataModel !== undefined) model.dataModel = data.dataModel
    if (Object.keys(model).length === 0) return undefined
    return model
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
