import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const MM = process.env.MM_URL ?? 'http://localhost:8065';
const CALLBACK = parseArgs({ options: { callback: { type: 'string', default: 'http://localhost:3000/mcp/oauth/callback' } } }).values.callback;
const PASSWORD = 'Passw0rd!dev123';
const STATE = new URL('./.state.json', import.meta.url);

type Json = Record<string, any>;

async function api(method: string, path: string, token: string | null, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; json: Json; token: string | null }> {
  const res = await fetch(`${MM}/api/v4${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok && !okStatuses.includes(res.status)) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return { status: res.status, json, token: res.headers.get('token') };
}

async function login(username: string): Promise<string> {
  const r = await api('POST', '/users/login', null, { login_id: username, password: PASSWORD });
  return r.token!;
}

async function ensureUser(adminToken: string, username: string) {
  const found = await api('GET', `/users/username/${username}`, adminToken, undefined, [404]);
  if (found.status === 200) return found.json;
  return (await api('POST', '/users', adminToken, { username, email: `${username}@example.com`, password: PASSWORD })).json;
}

async function ensureTeam(token: string, name: string) {
  const found = await api('GET', `/teams/name/${name}`, token, undefined, [404]);
  if (found.status === 200) return found.json;
  return (await api('POST', '/teams', token, { name, display_name: name, type: 'O' })).json;
}

async function ensureChannel(token: string, teamId: string, name: string, type: 'O' | 'P') {
  const found = await api('GET', `/teams/${teamId}/channels/name/${name}`, token, undefined, [404]);
  if (found.status === 200) return found.json;
  return (await api('POST', '/channels', token, { team_id: teamId, name, display_name: name, type })).json;
}

async function main() {
  await api('POST', '/users', null, { username: 'admin', email: "admin@example.com", password: PASSWORD }, [400, 403]);
  const adminToken = await login('admin');

  const alice = await ensureUser(adminToken, 'alice');
  const bob = await ensureUser(adminToken, 'bob');
  const teamA = await ensureTeam(adminToken, 'team-a');
  const teamB = await ensureTeam(adminToken, 'team-b');
  for (const t of [teamA, teamB]) {
    for (const u of [alice, bob]) await api('POST', `/teams/${t.id}/members`, adminToken, { team_id: t.id, user_id: u.id }, [400]);
  }

  const aliceToken = await login('alice');
  const channels: Json = {};
  for (const t of [teamA, teamB]) {
    const dup = await ensureChannel(adminToken, t.id, 'general-dup', 'O');
    for (const u of [alice, bob]) await api('POST', `/channels/${dup.id}/members`, adminToken, { user_id: u.id }, [400]);
    channels[t.name] = dup;
  }
  const priv = await ensureChannel(aliceToken, teamA.id, 'alice-private', 'P');

  const load: Json = {};
  for (let i = 1; i <= 6; i++) {
    const u = await ensureUser(adminToken, `load${i}`);
    await api('POST', `/teams/${teamA.id}/members`, adminToken, { team_id: teamA.id, user_id: u.id }, [400]);
    await api('POST', `/channels/${channels['team-a'].id}/members`, adminToken, { user_id: u.id }, [400]);
    load[`load${i}`] = { id: u.id, username: `load${i}`, password: PASSWORD };
  }

  const apps = (await api('GET', '/oauth/apps?per_page=200', adminToken)).json as Json[];
  let app = apps.find((a) => a.name === 'mcp-dev');
  if (!app) {
    app = (await api('POST', '/oauth/apps', adminToken, {
      name: 'mcp-dev', description: 'mcp dev', homepage: 'http://localhost:3000', is_trusted: true, is_public: false, callback_urls: [CALLBACK],
    })).json;
  }
  if (app.callback_urls?.length !== 1 || app.callback_urls[0] !== CALLBACK) {
    app = (await api('PUT', `/oauth/apps/${app.id}`, adminToken, { ...app, callback_urls: [CALLBACK] })).json;
  }
  if (!app!.client_secret) app = (await api('POST', `/oauth/apps/${app!.id}/regen_secret`, adminToken)).json;

  const state = {
    mmUrl: MM,
    adminToken,
    users: {
      alice: { id: alice.id, username: 'alice', password: PASSWORD },
      bob: { id: bob.id, username: 'bob', password: PASSWORD },
      ...load,
    },
    teams: {
      a: { id: teamA.id, name: 'team-a', dupChannelId: channels['team-a'].id, privateChannelId: priv.id },
      b: { id: teamB.id, name: 'team-b', dupChannelId: channels['team-b'].id },
    },
    oauth: { clientId: app!.id, clientSecret: app!.client_secret, callback: CALLBACK },
  };
  writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
  console.log(`wrote dev/.state.json (oauth client ${app!.id})`);
}

await main();
