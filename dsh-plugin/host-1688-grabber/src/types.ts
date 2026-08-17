/** Wire types for the 1688 grabber Remote service. */

/** One 1688 offer link, normalized to its offer id. */
export interface OfferRef {
  /** The raw link as the user pasted it. */
  readonly link: string
  /** Parsed numeric offer id, when the link is recognizable. */
  readonly offerId: string
}

/** Request to start a grab task over a batch of offer links. */
export interface GrabStartRequest {
  /** Offer links, one per line. */
  readonly links: readonly string[]
  /** Absolute output directory; per-offer subfolders are created beneath it. */
  readonly outDir: string
  /**
   * Optional browser cookie string (from 1688.com). When absent the MTOP
   * anonymous token flow is used. Supplying a logged-in cookie improves
   * resilience against 1688's risk control.
   */
  readonly cookie?: string
  /** Maximum concurrent image downloads per offer. Defaults to 4. */
  readonly concurrency?: number
}

/** One offer's grab outcome. */
export interface GrabOfferResult {
  /** Parsed offer id. */
  readonly offerId: string
  /** Product title when the detail fetch succeeded. */
  readonly subject?: string
  /** Absolute directory holding the main images. */
  readonly mainDir?: string
  /** Absolute directory holding the detail-page images. */
  readonly detailDir?: string
  /** Number of main images saved. */
  readonly mainCount: number
  /** Number of detail images saved. */
  readonly detailCount: number
  /** Present when this offer failed; the message explains why. */
  readonly error?: string
}

/** Point-in-time view of one grab task. */
export interface GrabStatusView {
  readonly taskId: string
  /** 'running' while the batch is in flight; 'done' after every offer settled. */
  readonly phase: 'running' | 'done'
  /** Offers processed so far (each either succeeded or failed). */
  readonly completed: number
  /** Total offers in the batch. */
  readonly total: number
  /** Per-offer outcomes in input order; failed rows carry `error`. */
  readonly results: readonly GrabOfferResult[]
}

/** Response of starting a task: the stable task id for status polling. */
export interface GrabStartValue {
  readonly taskId: string
}

/** Cancellation request; a settled task ignores it. */
export interface GrabCancelRequest {
  readonly taskId: string
}
