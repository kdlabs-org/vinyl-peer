import type { DemandRecord } from "../types.js";

/**
 * DemandMonitor:
 * - Tracks how many times each CID is downloaded.
 * - Emits “hot” event when count reaches threshold.
 *
 * Production tweaks:
 *  - Batched persistence (optional)
 *  - In‐memory only, but could be linked to a LevelDB for crash recovery.
 */
export class DemandMonitor {
  private counts: Map<string, DemandRecord> = new Map();
  private hotThreshold: number;
  private listeners: ((cid: string) => void)[] = [];

  constructor(hotThreshold: number = 10) {
    this.hotThreshold = hotThreshold;
  }

  recordDownload(cid: string) {
    const now = new Date().toISOString();
    const rec = this.counts.get(cid) || { cid, count: 0, lastRequested: now };
    rec.count += 1;
    rec.lastRequested = now;
    this.counts.set(cid, rec);

    if (rec.count === this.hotThreshold) {
      this.emitHot(cid);
    }
  }

  private emitHot(cid: string) {
    for (const cb of this.listeners) {
      try {
        cb(cid);
      } catch (err) {
        console.error("[AutoReplication][monitor] listener error:", err);
      }
    }
  }

  onHot(callback: (cid: string) => void) {
    this.listeners.push(callback);
  }

  getDemand(cid: string): DemandRecord | undefined {
    return this.counts.get(cid);
  }
}
