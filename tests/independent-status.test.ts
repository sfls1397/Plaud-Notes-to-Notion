import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig, saveConfig } from '../src/config.js';
import { MemorySecretStore } from '../src/secrets.js';
import { loadState } from '../src/state.js';
import { FakeNotion, FakePlaud } from './fakes.js';
const mocks = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock('../src/runtime.js', async (original) => ({ ...await original<object>(), buildProfileRuntime: mocks.build }));
import { readStatus } from '../src/runtime.js';
import { runDaemon } from '../src/daemon.js';

it('exposes retained no-fallback failures in daemon pending/error status', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-side-effects-status-'));
  const env = { ...process.env, PLAUD_NOTES_HOME: root, TOOLBOX_SERVICE_ENGINE_FILE: path.join(root, 'policy.json') };
  const controller = new AbortController();
  const termListeners = new Set(process.listeners('SIGTERM'));
  const intListeners = new Set(process.listeners('SIGINT'));
  vi.useFakeTimers();
  try {
    saveConfig(parseConfig({ profiles: { fixture: { enabled: true, ingest: true, syncTranscripts: false,
      owner: 'Alex Example', notionDataSourceId: '0'.repeat(32), startAfter: '2026-01-01T00:00:00Z' } } }), env);
    fs.writeFileSync(env.TOOLBOX_SERVICE_ENGINE_FILE, JSON.stringify({ version: 1, engine: 'sol', generation: 'fixture', updated_at: '2026-11-03T00:00:00Z' }));
    const notion = new FakeNotion();
    const plaud = new FakePlaud();
    plaud.add({ id: 'synthetic' });
    mocks.build.mockResolvedValue({ notion, plaud, labeler: { allowFallback: false,
      label: async () => { throw new Error('Synthetic subscription failure'); } } });
    const running = runDaemon({ store: new MemorySecretStore(), env, signal: controller.signal,
      log: { info: () => {}, warn: () => {}, error: () => { controller.abort(); } } });
    await vi.advanceTimersByTimeAsync(1100);
    expect(await running).toBe(0);
    const record = loadState('fixture', env).files.synthetic;
    const status = readStatus(env).fixture;
    console.log(JSON.stringify({ record, status, createdRows: notion.rows.length }));
    expect(record.status).toBe('pending');
    expect(notion.rows).toHaveLength(0);
    expect(status.pending).toBe(1);
    expect(status.lastError).toContain('Synthetic subscription failure');
  } finally {
    controller.abort();
    vi.useRealTimers();
    for (const listener of process.listeners('SIGTERM')) if (!termListeners.has(listener)) process.removeListener('SIGTERM', listener);
    for (const listener of process.listeners('SIGINT')) if (!intListeners.has(listener)) process.removeListener('SIGINT', listener);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
