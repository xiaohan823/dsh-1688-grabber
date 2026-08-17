/**
 * Download helpers: fetch one image binary to disk with a stable filename,
 * and extract <img> URLs from a 1688 detail-page HTML document.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { absoluteImageUrl } from './mtop.ts'

const UA = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'AppleWebKit/537.36 (KHTML, like Gecko)',
  'Chrome/125.0.0.0 Safari/537.36',
].join(' ')

/** Pick a filename extension for an image URL; unknown types fall back to .jpg. */
export function extensionFor(url: string): string {
  const path = url.split('?', 1)[0] ?? url
  const ext = extname(path).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.gif' || ext === '.webp') return ext
  return '.jpg'
}

/**
 * Download one image URL into `dir` as `NNNN<ext>` (zero-padded, 1-based).
 * @returns the absolute saved path, or `undefined` when the fetch failed.
 */
export async function downloadImage(
  url: string,
  dir: string,
  index: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const target = join(dir, String(index).padStart(4, '0') + extensionFor(url))
  try {
    const res = await fetchImpl(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        Referer: 'https://detail.1688.com/',
      },
    })
    if (!res.ok) return undefined
    const bytes = await res.arrayBuffer()
    await mkdir(dir, { recursive: true })
    await writeFile(target, new Uint8Array(bytes))
    return target
  } catch {
    return undefined
  }
}

/**
 * Extract image URLs from a 1688 detail-page HTML document. Handles plain
 * `<img src>` plus lazy-loaded `data-src`/`data-lazyload` attributes, and
 * skips obvious non-product trackers. Deduplicates in first-seen order.
 */
export function extractHtmlImages(html: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (value: string | undefined): void => {
    if (value === undefined) return
    const abs = absoluteImageUrl(value)
    if (abs.length === 0 || !/\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(abs.split('?', 1)[0]!)) return
    if (seen.has(abs)) return
    seen.add(abs)
    out.push(abs)
  }
  const imgRe = /<img\b[^>]*>/gi
  // Match src (and lazy variants) with plain or JSON-escaped quotes around the
  // URL; tolerate trailing escape backslashes that some CDN payloads carry.
  const attrRe = /\b(src|data-src|data-lazyload|data-original|data-ks-lazyload)\s*=\s*(?:\\\\)*(?:\\|)("([^"]*)"|'([^']*)'|([^\s>]+))/gi
  for (const match of html.matchAll(imgRe)) {
    const tag = match[0]!
    for (const attr of tag.matchAll(attrRe)) {
      const raw = attr[3] ?? attr[4] ?? attr[5]
      push(raw === undefined ? undefined : raw.replace(/\\+$/g, ''))
    }
  }
  return out
}

/** Strip a tiny 1x1 GIF (common anti-hotlink placeholder) from results. */
export function isPlaceholderImage(url: string): boolean {
  return /\.gif(\?|$)/i.test(url.split('?', 1)[0] ?? url)
}

/**
 * Unwrap a 1688 detail-page payload that arrives as a JS variable holding a
 * JSON string, e.g. `var offer_details={"content":"<div>...<img src=\"...\">..."};`.
 * Returns the decoded HTML, or the raw text when the shape is not recognized.
 */
export function unwrapOfferDetails(text: string): string {
  const m = /=\s*(\{[\s\S]*\})\s*;?\s*$/i.exec(text.trim())
  if (m === null || m[1] === undefined) return text
  try {
    const parsed = JSON.parse(m[1]) as { content?: unknown }
    if (typeof parsed.content === 'string') return parsed.content
  } catch {
    // Not JSON after all — fall through to the raw text.
  }
  return text
}
