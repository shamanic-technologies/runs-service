/**
 * Stored answers for slow, repeated reads (DASH-SPEED-1110).
 *
 * A dashboard page polls the same read every 5-60 s; on the loaded box one answer costs 4-20 s
 * of random I/O (`/internal/runs/subtree-costs` for the busiest brand, 7,856 runs: ~26k cold page
 * reads). Here each answer is computed once and served from memory:
 *  - younger than `freshMs`: served as is;
 *  - older, up to `maxStaleMs`: served at once while ONE background refresh recomputes it;
 *  - older than that, or never computed: the caller waits for the computation (shared by every
 *    concurrent caller of the same key).
 * The figures are the read's own, as of its last computation: never mixed, never recomputed in JS.
 * A failed computation is never stored: the next caller computes again (and a waiting caller gets
 * the error). Bodies above `maxBytes` are not kept (a brand-wide 60 MB answer).
 *
 * Kill switch: `READ_CACHE=off` computes every call (the pre-1110 behaviour).
 */

export interface ReadCachePolicy {
  freshMs: number;
  maxStaleMs: number;
  maxBytes: number;
}

interface Entry {
  at: number;
  body: string | null;
  pending: Promise<string> | null;
}

/** Per cache: the box runs with little free memory. */
const TOTAL_MAX_BYTES = 64 * 1024 * 1024;

export class ReadCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;

  constructor(private readonly policy: ReadCachePolicy) {}

  /** The JSON body for `key`, computed by `compute` (which returns the serialized body). */
  async get(key: string, compute: () => Promise<string>): Promise<string> {
    if (process.env.READ_CACHE === "off") return compute();
    const now = Date.now();
    const e = this.entries.get(key);
    if (e?.body != null) {
      const age = now - e.at;
      // LRU order: a hit moves to the end.
      this.entries.delete(key);
      this.entries.set(key, e);
      if (age < this.policy.freshMs) return e.body;
      if (age < this.policy.maxStaleMs) {
        if (!e.pending) this.refresh(key, e, compute).catch((err) => console.error(`[Runs Service] read-cache background refresh failed for ${key}:`, err));
        return e.body;
      }
    }
    const entry = e ?? { at: 0, body: null, pending: null };
    if (!e) this.entries.set(key, entry);
    return entry.pending ?? this.refresh(key, entry, compute);
  }

  private refresh(key: string, e: Entry, compute: () => Promise<string>): Promise<string> {
    const p = compute().then(
      (body) => {
        if (this.entries.get(key) === e) {
          this.bytes -= e.body?.length ?? 0;
          if (body.length <= this.policy.maxBytes) {
            e.body = body;
            e.at = Date.now();
            this.bytes += body.length;
          } else {
            this.entries.delete(key);
          }
          this.evict();
        }
        e.pending = null;
        return body;
      },
      (err) => {
        e.pending = null;
        if (this.entries.get(key) === e && e.body == null) this.entries.delete(key);
        throw err;
      },
    );
    e.pending = p;
    return p;
  }

  private evict(): void {
    for (const [k, v] of this.entries) {
      if (this.bytes <= TOTAL_MAX_BYTES) return;
      if (v.pending) continue;
      this.bytes -= v.body?.length ?? 0;
      this.entries.delete(k);
    }
  }

  /** Test seam. */
  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}
