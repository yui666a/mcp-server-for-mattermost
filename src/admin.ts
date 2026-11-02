import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import { Store } from './store.ts';

const USAGE = `Usage: node src/admin.ts <command>
  purge-credentials
  invalidate-scheduled
  list-clients [--unauthorized]
  delete-client <client_id>`;

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

export function runAdmin(argv: string[], db: DatabaseSync, io: Io): number {
  // A zero key is safe only because none of these commands seals or opens a secret; the CLI must not need TOKEN_ENC_KEY.
  const store = new Store(db, Buffer.alloc(32));
  const [cmd, ...args] = argv;
  if (cmd === 'purge-credentials' && args.length === 0) {
    io.out(`purged ${store.purgeCredentials()} rows\n`);
    return 0;
  }
  if (cmd === 'invalidate-scheduled' && args.length === 0) {
    const n = store.invalidateScheduled(Date.now(), {
      unattempted: 'サーバーを復元したため無効にしました。予約を入れ直してください。',
      unknown: 'サーバーを復元したため無効にしました。投稿されたか不明なので、Mattermost の画面で確かめてください。',
    });
    io.out(`invalidated ${n} scheduled posts\n`);
    return 0;
  }
  if (cmd === 'list-clients' && args.every((a) => a === '--unauthorized') && args.length <= 1) {
    for (const c of store.listClients(args.length === 1)) {
      const authorized = c.authorizedAt === null ? 'unauthorized' : 'authorized';
      io.out(`${c.clientId}\t${c.clientName}\t${new Date(c.createdAt).toISOString()}\t${authorized}\n`);
    }
    return 0;
  }
  if (cmd === 'delete-client' && args.length === 1) {
    if (!store.deleteClient(args[0]!)) {
      io.err(`client not found: ${args[0]}\n`);
      return 1;
    }
    io.out(`deleted ${args[0]}\n`);
    return 0;
  }
  io.err(`${USAGE}\n`);
  return 2;
}

if (import.meta.main) {
  const io = { out: (s: string) => process.stdout.write(s), err: (s: string) => process.stderr.write(s) };
  const path = process.env.DB_PATH || '/data/mcp.sqlite';
  try {
    // openDb would silently create an empty DB on a wrong path, making "purged 0 rows" look like success.
    if (!existsSync(path)) throw new Error(`database not found: ${path}`);
    process.exitCode = runAdmin(process.argv.slice(2), openDb(path), io);
  } catch (e) {
    io.err(`error: ${(e as Error).message}\n`);
    process.exitCode = 1;
  }
}
