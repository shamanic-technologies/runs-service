import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { S3Client } from "@aws-sdk/client-s3";
import {
  ARCHIVE_BUCKET_KEY,
  R2NotConfiguredError,
  loadArchiveR2Credentials,
  loadArchiveStore,
} from "../../src/services/archive-store.js";

// SECRETS-ROTATE-1127: the lifecycle archive (runs, costs, orgs) lives in the PRIVATE
// bucket named by key-service platform key `cloudflare-r2-private-bucket-name`. The
// platform key `cloudflare-r2-bucket-name` names the PUBLIC bucket (r2.dev serves every
// object): no archive path may ever read it.

const KEYS: Record<string, string> = {
  "cloudflare-r2-account-id": "acct",
  "cloudflare-r2-access-key-id": "akid",
  "cloudflare-r2-secret-access-key": "secret",
  "cloudflare-r2-private-bucket-name": "distribute-private",
  "cloudflare-r2-bucket-name": "PUBLIC-BUCKET",
};

let asked: string[] = [];

function mockKeyService(missing: string[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const provider = String(url).match(/\/keys\/platform\/([^/]+)\/decrypt/)![1];
      asked.push(provider);
      if (missing.includes(provider) || !(provider in KEYS)) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ key: KEYS[provider] }), { status: 200 });
    }),
  );
}

describe("archive store resolves the PRIVATE bucket (SECRETS-ROTATE-1127)", () => {
  beforeEach(() => {
    asked = [];
    process.env.KEY_SERVICE_URL = "http://key-service";
    process.env.KEY_SERVICE_API_KEY = "k";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reads the private bucket key, never the public one", async () => {
    mockKeyService();
    const creds = await loadArchiveR2Credentials("/test");
    expect(ARCHIVE_BUCKET_KEY).toBe("cloudflare-r2-private-bucket-name");
    expect(creds.bucketName).toBe("distribute-private");
    expect(asked).toContain("cloudflare-r2-private-bucket-name");
    expect(asked).not.toContain("cloudflare-r2-bucket-name");
  });

  it("fails loud when the private bucket key is missing, no fallback to the public bucket", async () => {
    mockKeyService(["cloudflare-r2-private-bucket-name"]);
    const err = await loadArchiveR2Credentials("/test").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    // Not the "R2 not configured" no-op class: the job surfaces it as an error every tick.
    expect(err).not.toBeInstanceOf(R2NotConfiguredError);
    expect(String((err as Error).message)).toMatch(/cloudflare-r2-private-bucket-name/);
    expect(asked).not.toContain("cloudflare-r2-bucket-name");
  });

  it("write, read-back and list (restore) all address the private bucket", async () => {
    mockKeyService();
    const buckets: Array<{ cmd: string; bucket: string }> = [];
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: any) => {
      buckets.push({ cmd: command.constructor.name, bucket: command.input.Bucket });
      if (command.constructor.name === "GetObjectCommand") {
        return { Body: { transformToByteArray: async () => new Uint8Array([1, 2]) }, Metadata: {} } as any;
      }
      if (command.constructor.name === "ListObjectsV2Command") {
        return { Contents: [{ Key: "runs-archive/x" }], IsTruncated: false } as any;
      }
      return {} as any;
    });
    const store = await loadArchiveStore("/test");
    expect(store.bucketName).toBe("distribute-private");
    await store.put("runs-archive/x", Buffer.from([1, 2]), {});
    await store.get("runs-archive/x");
    await store.list("runs-archive/");
    expect(buckets.map((b) => b.cmd)).toEqual(["PutObjectCommand", "GetObjectCommand", "ListObjectsV2Command"]);
    expect(buckets.every((b) => b.bucket === "distribute-private")).toBe(true);
  });

  it("the job and the restore script build their store only through loadArchiveStore", () => {
    for (const path of ["src/services/lifecycle-archive.ts", "scripts/restore-lifecycle-archive.ts"]) {
      const src = readFileSync(path, "utf8");
      expect(src).toContain("loadArchiveStore(");
      expect(src).not.toContain("new R2ArchiveStore(");
      expect(src).not.toContain("cloudflare-r2-bucket-name");
    }
  });
});
