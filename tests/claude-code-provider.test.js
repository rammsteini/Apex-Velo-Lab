#!/usr/bin/env node
/**
 * Runs server.js with a fake Claude Code CLI (a small Node script set as APEX_CLAUDE_CODE_PATH) and checks the
 * "claude-code" provider: detection, that it becomes the default without API keys, the headless arguments
 * (no tools, no MCP, no settings), the prompt on stdin, that ANTHROPIC_API_KEY never reaches the CLI,
 * /api/coach and /api/ask replies, CLI errors, and that a cancelled request kills the CLI.
 *
 * Nothing leaves this machine and the real `claude` is never started.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { buildClaudeCodeArgs, buildClaudeCodeAskPrompt } = require('../server.js');

const ROOT = path.resolve(__dirname, '..');

const FAKE_CLI = `
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ args, input, apiKey: process.env.ANTHROPIC_API_KEY || null, cwd: process.cwd() }));
  if (/HANG/.test(input)) { fs.writeFileSync(process.env.FAKE_LOG + '.hang', String(process.pid)); setInterval(() => {}, 1000); return; }
  if (/FAIL/.test(input)) { console.log(JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in - Please run /login' })); process.exit(1); }
  console.log(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'Answer from the fake CLI.',
    usage: { input_tokens: 5, cache_creation_input_tokens: 600, cache_read_input_tokens: 0, output_tokens: 7 },
    modelUsage: { 'claude-opus-5-5': { inputTokens: 5, outputTokens: 7 } }
  }));
});
`;

async function waitUp(port, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://localhost:${port}/api/coach/status`);
      if (r.ok) { const s = await r.json(); if (s.providers['claude-code'].configured) return s; }
    } catch (e) { /* not yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

test('buildClaudeCodeArgs: headless, JSON, no tools / MCP / settings, model alias and effort', () => {
  const a = buildClaudeCodeArgs('SYS', 'claude-code-sonnet', 'medium');
  assert.deepStrictEqual(a.slice(0, 7), ['-p', '--output-format', 'json', '--model', 'sonnet', '--system-prompt', 'SYS']);
  assert.strictEqual(a[a.indexOf('--tools') + 1], '');
  assert.strictEqual(a[a.indexOf('--setting-sources') + 1], '');
  for (const f of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(a.includes(f), f);
  assert.strictEqual(a[a.indexOf('--effort') + 1], 'medium');
  assert.ok(!a.includes('--bare'), '--bare would ignore the subscription login');
});

test('buildClaudeCodeAskPrompt: data, earlier turns, then the new question', () => {
  const p = buildClaudeCodeAskPrompt([
    { role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }, { role: 'user', content: 'Q2' }
  ], 'CTX');
  assert.ok(p.startsWith('TRAINING DATA\nCTX'));
  assert.ok(p.indexOf('RIDER:\nQ1') < p.indexOf('ANALYST (you):\nA1'));
  assert.ok(p.trim().endsWith("RIDER'S QUESTION (answer this)\nQ2"));
  assert.ok(!buildClaudeCodeAskPrompt([{ role: 'user', content: 'Only' }], '').includes('CONVERSATION SO FAR'));
});

test('server.js answers coach and ask requests through Claude Code', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-cc-'));
  const port = 18761;
  const cli = path.join(dir, 'fake-claude.cjs');
  const log = path.join(dir, 'cli-log.json');
  fs.writeFileSync(cli, FAKE_CLI);
  fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(dir, 'server.js'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>test</title>');
  fs.writeFileSync(path.join(dir, '.env'), [`APEX_PORT=${port}`, `APEX_CLAUDE_CODE_PATH=${cli}`, 'APEX_COACH_EFFORT=low', ''].join('\n'));
  const env = { ...process.env, APEX_NO_BROWSER: '1', FAKE_LOG: log };
  delete env.ANTHROPIC_API_KEY; delete env.GEMINI_API_KEY; delete env.OPENAI_API_KEY; delete env.APEX_COACH_PROVIDER;
  const proc = spawn(process.execPath, [path.join(dir, 'server.js')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', d => { out += d; }); proc.stderr.on('data', d => { out += d; });
  const post = async (url, body, signal) => {
    const r = await fetch(`http://localhost:${port}${url}`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try {
    const st = await waitUp(port);
    assert.ok(st, `server with fake CLI did not come up: ${out.slice(-600)}`);
    assert.strictEqual(st.provider, 'claude-code', 'no API keys: Claude Code is the default');
    assert.strictEqual(st.model, 'claude-code-opus');

    // Coach: system prompt as an argument, the prompt on stdin.
    let r = await post('/api/coach', { prompt: 'Build me a session.', provider: 'claude-code', effort: 'high' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.text, 'Answer from the fake CLI.');
    assert.strictEqual(r.body.provider, 'claude-code');
    assert.strictEqual(r.body.model, 'claude-opus-5-5');
    let seen = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.strictEqual(seen.input, 'Build me a session.');
    assert.strictEqual(seen.args[seen.args.indexOf('--model') + 1], 'opus');
    assert.strictEqual(seen.args[seen.args.indexOf('--effort') + 1], 'high');
    assert.match(seen.args[seen.args.indexOf('--system-prompt') + 1], /sport scientist/);
    assert.strictEqual(seen.apiKey, null);

    // Ask with a model id: the conversation and data go on stdin.
    r = await post('/api/ask', { messages: [{ role: 'user', content: 'How was my week?' }], context: 'FTP 250 W', model: 'claude-code-haiku' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    seen = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.strictEqual(seen.args[seen.args.indexOf('--model') + 1], 'haiku');
    assert.match(seen.args[seen.args.indexOf('--system-prompt') + 1], /data analyst/);
    assert.match(seen.input, /TRAINING DATA\nFTP 250 W/);
    assert.match(seen.input, /How was my week\?$/);

    // A CLI error comes back as a 502 with a sign-in hint.
    r = await post('/api/coach', { prompt: 'FAIL please', provider: 'claude-code' });
    assert.strictEqual(r.status, 502);
    assert.match(r.body.error, /Not logged in/);
    assert.match(r.body.error, /sign in/);

    // Cancelling the request in the app kills the CLI process.
    const ac = new AbortController();
    const pending = post('/api/coach', { prompt: 'HANG', provider: 'claude-code' }, ac.signal).catch(() => null);
    const hang = log + '.hang';
    for (let i = 0; i < 100 && !fs.existsSync(hang); i++) await new Promise(res => setTimeout(res, 50));
    assert.ok(fs.existsSync(hang), 'fake CLI did not start');
    const pid = Number(fs.readFileSync(hang, 'utf8'));
    ac.abort(); await pending;
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try { process.kill(pid, 0); await new Promise(res => setTimeout(res, 50)); } catch (e) { alive = false; }
    }
    assert.strictEqual(alive, false, 'the CLI kept running after the app cancelled');
  } finally {
    proc.kill();
    await new Promise(res => setTimeout(res, 200));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp */ }
  }
});
