// Run with Node 22.13+; SQLite transactions match the Durable Object's synchronous storage interface.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import worker, { LendingPool } from './worker.mjs';
import { lentThought } from '../council/llm.mjs';

const db = new DatabaseSync(':memory:');
const storage = {
  sql: { exec(query, ...args) {
    if (!args.length && query.includes('CREATE TABLE')) { db.exec(query); return []; }
    return db.prepare(query).all(...args);
  } },
  transactionSync(fn) {
    db.exec('BEGIN');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (err) { db.exec('ROLLBACK'); throw err; }
  },
};
const env = { ENC_KEY: randomBytes(32).toString('base64'), ROBOT_TOKEN: randomBytes(32).toString('hex') };
const pool = new LendingPool({ storage }, env);
env.POOL = { idFromName: () => 'test', get: () => pool };
const call = (path, data, headers = {}, bindings = env) => worker.fetch(new Request('https://local.test' + path, {
  method: data === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: data === undefined ? undefined : JSON.stringify(data),
}), bindings);
const token = { authorization: 'Bearer ' + env.ROBOT_TOKEN };
const authorized = new Set();
const calls = [];
let failInference = false;
const previousFetch = globalThis.fetch;
const messages = [{ role: 'user', content: 'Reply with OK.' }];
const think = run => call('/think', { run, messages, max_tokens: 8000 }, token);
async function lend(effort = 'light') {
  const key = randomBytes(24).toString('hex');
  authorized.add('Bearer ' + key);
  const data = { provider: 'groq', key, effort };
  const headers = { 'cf-connecting-ip': randomBytes(16).toString('hex') };
  const reply = await call('/lend', data, headers);
  assert.equal(reply.status, 200);
  const receipt = await reply.json();
  assert.deepEqual(Object.keys(receipt).sort(), ['effort', 'limits', 'revoke']);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM loans').all()).includes(key), false);
  return { receipt, data, headers };
}

try {
  globalThis.fetch = async (url, opts) => {
    if (String(url) === 'https://local.test/think') return worker.fetch(new Request(url, opts), env);
    assert.equal(new URL(url).host, 'api.groq.com');
    assert.equal(opts.redirect, 'manual');
    if (!authorized.has(opts.headers.authorization)) return new Response(null, { status: 401 });
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'test-chat' }] });
    assert.equal(new URL(url).pathname, '/openai/v1/chat/completions');
    const body = JSON.parse(opts.body);
    assert.deepEqual(body.messages, messages);
    calls.push(body.max_tokens);
    if (failInference) return new Response(null, { status: 503 });
    return Response.json({ choices: [{ message: { content: 'OK' } }] });
  };
  assert.equal((await call('/lend', { provider: 'groq', key: 'invalid-test-fixture', effort: 'light' })).status, 400);
  assert.equal((await call('/take', {}, token)).status, 404);
  assert.equal((await call('/think', {})).status, 401);
  assert.equal((await call('/think', {}, {}, { ...env, ROBOT_TOKEN: '' })).status, 503);
  assert.deepEqual(await (await call('/stats')).json(), { lent: 0, by: {} });
  const { receipt, data, headers } = await lend();
  assert.equal((await call('/lend', data, headers)).status, 409);
  assert.deepEqual(await (await call('/stats')).json(), { lent: 1, by: { groq: 1 } });

  process.env.LEND_URL = 'https://local.test';
  process.env.ROBOT_TOKEN = env.ROBOT_TOKEN;
  process.env.GITHUB_RUN_ID = 'robot-test';
  assert.deepEqual(await lentThought(messages, 8000), { text: 'OK', used: 'lent:groq' });
  assert.equal(await lentThought(messages, 8000), null);
  await Promise.all(Array.from({ length: 20 }, (_, i) => think('parallel-' + i)));
  assert.deepEqual(calls, Array(5).fill(400));
  db.exec("UPDATE loans SET day='2000-01-01'");
  assert.equal((await (await think('next-day')).json()).text, 'OK');

  const wrong = await call('/revoke', { revoke: 'wrong' });
  assert.equal(wrong.status, 403);
  const right = await call('/revoke', { revoke: receipt.revoke });
  assert.equal(right.status, 200);
  assert.equal(await lentThought(messages, 8000), null);
  const extra = [];
  for (const [effort, n, tokens] of [['medium', 25, 900], ['heavy', 100, 2000]]) {
    const loan = await lend(effort);
    const start = calls.length;
    for (let i = 0; i < n + 1; i++) await think(effort + i);
    assert.deepEqual(calls.slice(start), Array(n).fill(tokens));
    await call('/revoke', { revoke: loan.receipt.revoke });
  }
  for (let i = 0; i < 5; i++) extra.push(await lend());
  const start = calls.length;
  failInference = true;
  await Promise.all(Array.from({ length: 8 }, () => think('same-run')));
  assert.equal(calls.length - start, 3);
  for (const loan of extra) await call('/revoke', { revoke: loan.receipt.revoke });
  for (let i = 0; i < 5; i++) await call('/lend', {}, { 'cf-connecting-ip': 'rate-test' });
  assert.equal((await call('/lend', {}, { 'cf-connecting-ip': 'rate-test' })).status, 429);
  const left = (await (await call('/stats')).json()).lent;
  assert.equal(left, 0);
  console.log('Robot completion, encryption, parallel budgets 5/25/100, token limits 400/900/2000 and three loans per run passed.');
  console.log('revoke wrong', wrong.status, 'right', right.status, 'left', left);
} finally { globalThis.fetch = previousFetch; db.close(); }
