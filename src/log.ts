export function log(event: string, fields: Record<string, string | number | boolean | undefined> = {}): void {
  process.stdout.write(JSON.stringify({ ...fields, ts: new Date().toISOString(), event }) + '\n');
}
