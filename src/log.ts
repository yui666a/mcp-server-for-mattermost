export function log(event: string, fields: Record<string, string | number | boolean | undefined> = {}): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + '\n');
}
