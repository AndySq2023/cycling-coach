// Team roster — up to MAX_MEMBERS athletes plus the master user (the coach/owner).
// Stored as one KV blob `team_roster`: { members: [{ id, name, salt, pwHash, createdAt }] }.
// Member passwords are generated server-side, shown ONCE to the master when created,
// and stored only as salted sha256 hashes. The master's own credential stays the
// APP_PASSWORD env var, so existing single-user deployments keep working unchanged.
import crypto from 'node:crypto';
import { kvGet, kvSet } from './_kv.js';

const ROSTER_KEY = 'team_roster';
export const MAX_MEMBERS = 6;

export function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex');
}

// Constant-time equality that tolerates different lengths (hash both sides first —
// timingSafeEqual throws on length mismatch, which would itself leak length).
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Readable one-time login like "velo-k4mt-7xqp" — unambiguous alphabet (no 0/O/1/l/i).
export function generatePassword() {
  const alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
  const group = (n) => Array.from(crypto.randomBytes(n), b => alphabet[b % alphabet.length]).join('');
  return `velo-${group(4)}-${group(4)}`;
}

export async function getRoster() {
  const r = await kvGet(ROSTER_KEY);
  return { members: Array.isArray(r?.members) ? r.members : [] };
}

export async function saveRoster(roster) {
  await kvSet(ROSTER_KEY, { members: roster.members || [] });
}

export function findMemberByPassword(roster, password) {
  if (!password) return null;
  let found = null; // check every member (no early exit) to keep timing flat
  for (const m of roster.members) {
    if (m?.salt && m?.pwHash && safeEqual(hashPassword(password, m.salt), m.pwHash)) found = m;
  }
  return found;
}

export async function addMember(name) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) throw new Error('Member needs a name.');
  const roster = await getRoster();
  if (roster.members.length >= MAX_MEMBERS) throw new Error(`Team is full (${MAX_MEMBERS} members max).`);
  if (roster.members.some(m => m.name.toLowerCase() === clean.toLowerCase())) {
    throw new Error(`There is already a member called "${clean}".`);
  }
  const password = generatePassword();
  const salt = crypto.randomBytes(8).toString('hex');
  const member = {
    id: `m_${crypto.randomBytes(4).toString('hex')}`,
    name: clean,
    salt,
    pwHash: hashPassword(password, salt),
    createdAt: new Date().toISOString(),
  };
  roster.members.push(member);
  await saveRoster(roster);
  return { member, password }; // the clear-text password exists only in this response
}

export async function removeMember(id) {
  const roster = await getRoster();
  const before = roster.members.length;
  roster.members = roster.members.filter(m => m.id !== id);
  if (roster.members.length === before) throw new Error('No such member.');
  await saveRoster(roster);
}

export async function resetPassword(id) {
  const roster = await getRoster();
  const m = roster.members.find(x => x.id === id);
  if (!m) throw new Error('No such member.');
  const password = generatePassword();
  m.salt = crypto.randomBytes(8).toString('hex');
  m.pwHash = hashPassword(password, m.salt);
  await saveRoster(roster);
  return { member: m, password };
}
