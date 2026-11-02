import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

/**
 * Where the lifecycle archive lives (BOX-DISK-1101): Cloudflare R2 in prod, an
 * in-memory map in tests. The job only puts and gets (list is for the restore
 * script); nothing here deletes, and a verified object is never overwritten (the
 * job numbers parts from its own table, see lifecycle-archive.ts).
 */
export interface ArchivedObject {
  body: Buffer;
  metadata: Record<string, string>;
}

export interface ArchiveStore {
  put(key: string, body: Buffer, metadata: Record<string, string>): Promise<void>;
  get(key: string): Promise<ArchivedObject>;
  /** Every key under a prefix, sorted (restore only). */
  list(prefix: string): Promise<string[]>;
}

export class MemoryArchiveStore implements ArchiveStore {
  readonly objects = new Map<string, { body: Buffer; metadata: Record<string, string> }>();

  async put(key: string, body: Buffer, metadata: Record<string, string>): Promise<void> {
    this.objects.set(key, { body: Buffer.from(body), metadata: { ...metadata } });
  }

  async get(key: string): Promise<ArchivedObject> {
    const o = this.objects.get(key);
    if (!o) throw new Error(`archive object not found: ${key}`);
    return { body: Buffer.from(o.body), metadata: { ...o.metadata } };
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

export interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
}

export class R2ArchiveStore implements ArchiveStore {
  private readonly s3: S3Client;

  constructor(private readonly creds: R2Credentials) {
    this.s3 = new S3Client({
      region: "auto",
      endpoint: `https://${creds.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
    });
  }

  async put(key: string, body: Buffer, metadata: Record<string, string>): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.creds.bucketName,
        Key: key,
        Body: body,
        // No Content-Encoding header on purpose: an edge that transparently
        // decompresses on GET would hand back other bytes than the sha256 covers.
        ContentType: "application/gzip",
        Metadata: metadata,
      }),
    );
  }

  async get(key: string): Promise<ArchivedObject> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.creds.bucketName, Key: key }));
    if (!res.Body) throw new Error(`R2 returned no body for ${key}`);
    return { body: Buffer.from(await res.Body.transformToByteArray()), metadata: res.Metadata ?? {} };
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.creds.bucketName, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys.sort();
  }
}

/** Thrown when key-service has no R2 platform key: the job is a logged no-op, never a crash. */
export class R2NotConfiguredError extends Error {}

/**
 * R2 credentials from key-service PLATFORM keys, the same ones cloudflare-service's
 * pg-backup job reads (`cloudflare-r2-*`). No env var of our own: runs-service
 * already holds KEY_SERVICE_URL + KEY_SERVICE_API_KEY.
 */
export async function loadR2CredentialsFromKeyService(callerPath: string): Promise<R2Credentials> {
  const url = process.env.KEY_SERVICE_URL;
  const apiKey = process.env.KEY_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new R2NotConfiguredError("KEY_SERVICE_URL / KEY_SERVICE_API_KEY not set");
  }
  const read = async (provider: string): Promise<string> => {
    const res = await fetch(`${url}/keys/platform/${provider}/decrypt`, {
      headers: {
        "x-api-key": apiKey,
        "x-caller-service": "runs-service",
        "x-caller-method": "CRON",
        "x-caller-path": callerPath,
      },
    });
    if (res.status === 404) throw new R2NotConfiguredError(`key-service has no platform key ${provider}`);
    if (!res.ok) throw new Error(`key-service ${provider} decrypt failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { key?: string };
    if (!body.key) throw new Error(`key-service ${provider} decrypt returned no key`);
    return body.key;
  };
  const [accountId, accessKeyId, secretAccessKey, bucketName] = await Promise.all([
    read("cloudflare-r2-account-id"),
    read("cloudflare-r2-access-key-id"),
    read("cloudflare-r2-secret-access-key"),
    read("cloudflare-r2-bucket-name"),
  ]);
  return { accountId, accessKeyId, secretAccessKey, bucketName };
}
