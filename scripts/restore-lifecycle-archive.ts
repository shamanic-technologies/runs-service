// Restore archived lifecycle events (BOX-DISK-1101) from R2.
//
//   RUNS_SERVICE_DATABASE_URL=postgres://... KEY_SERVICE_URL=... KEY_SERVICE_API_KEY=... \
//     npx tsx scripts/restore-lifecycle-archive.ts <table> <key-or-prefix> [--target <table>] [--allow-live]
//
//   <table>          run_lifecycle_events | cost_lifecycle_events
//   <key-or-prefix>  runs-archive/<table>/2026/05/14.ndjson.gz  or  runs-archive/<table>/2026/05/
//
// Downloads each object, verifies its sha256 (lifecycle_archive_objects, else the
// object metadata) and row count, then INSERTs every row back byte-equal
// (`ON CONFLICT (id) DO NOTHING`). Default destination: `<table>_restored`, a
// trigger-less copy, because the live tables' AFTER INSERT triggers would replay old
// events out of order onto silver (see src/services/lifecycle-archive-restore.ts).
// `--allow-live` with `--target <table>` writes into the live bronze table anyway.

import { R2ArchiveStore, loadR2CredentialsFromKeyService } from "../src/services/archive-store.js";
import { restoreLifecycleArchive } from "../src/services/lifecycle-archive-restore.js";
import { sql } from "../src/db/index.js";

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    if (i === -1) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const allowLive = args.includes("--allow-live");
  if (allowLive) args.splice(args.indexOf("--allow-live"), 1);
  const target = flag("--target");
  const [table, keyOrPrefix] = args;
  if (!table || !keyOrPrefix) {
    console.error("usage: restore-lifecycle-archive.ts <table> <key-or-prefix> [--target <table>] [--allow-live]");
    process.exit(2);
  }
  const store = new R2ArchiveStore(await loadR2CredentialsFromKeyService("/scripts/restore-lifecycle-archive"));
  const res = await restoreLifecycleArchive(store, table, { keyOrPrefix, target, allowLive });
  console.log(`done: objects=${res.objects} rows=${res.rows} inserted=${res.inserted} into ${res.target}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
