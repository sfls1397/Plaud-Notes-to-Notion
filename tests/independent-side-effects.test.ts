import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig, saveConfig } from '../src/config.js';
import { MemorySecretStore } from '../src/secrets.js';

const mocks = vi.hoisted(() => ({ build: vi.fn(), ingest: vi.fn(), sync: vi.fn(), deletionSync: vi.fn() }));
vi.mock('../src/runtime.js', async (original) => ({ ...await original<object>(), buildProfileRuntime: mocks.build }));
vi.mock('../src/ingest.js', () => ({ runIngest: mocks.ingest }));
vi.mock('../src/sync.js', () => ({ runSync: mocks.sync, runDeletionSync: mocks.deletionSync }));
import { runDaemon } from '../src/daemon.js';

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it.each([false, true])('mixed-profile sync remains available when policy becomes invalid, warm runtime=%s', async (warm) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-side-effects-loop-'));
  const env = { ...process.env, PLAUD_NOTES_HOME: root, TOOLBOX_SERVICE_ENGINE_FILE: path.join(root, 'policy.json') };
  const controller = new AbortController();
  const termListeners = new Set(process.listeners('SIGTERM'));
  const intListeners = new Set(process.listeners('SIGINT'));
  const errors: string[] = [];
  vi.useFakeTimers();
  try {
    saveConfig(parseConfig({ pollSeconds: 10, syncSeconds: 60, profiles: { fixture: { enabled: true,
      ingest: true, syncTranscripts: true, owner: 'Alex Example', notionDataSourceId: '0'.repeat(32),
      startAfter: '2026-01-01T00:00:00Z' } } }), env);
    fs.writeFileSync(env.TOOLBOX_SERVICE_ENGINE_FILE, warm ? JSON.stringify({ version: 1, engine: 'claude', generation: 'fixture', updated_at: '2026-11-03T00:00:00Z' }) : '{');
    mocks.build.mockResolvedValue({ notion: {}, plaud: {}, labeler: {} });
    mocks.ingest.mockResolvedValue({ pending: 0, written: [], errors: [] });
    mocks.sync.mockResolvedValue(undefined);
    mocks.deletionSync.mockResolvedValue(undefined);
    const running = runDaemon({ store: new MemorySecretStore(), env, signal: controller.signal,
      log: { info: () => {}, warn: () => {}, error: (message) => errors.push(message) } });
    await vi.advanceTimersByTimeAsync(0);
    if (warm) {
      expect(mocks.sync).toHaveBeenCalledOnce();
      fs.writeFileSync(env.TOOLBOX_SERVICE_ENGINE_FILE, '{');
      mocks.sync.mockClear();
      mocks.deletionSync.mockClear();
      mocks.ingest.mockClear();
    }
    await vi.advanceTimersByTimeAsync(61000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1100);
    expect(await running).toBe(0);
    console.log(JSON.stringify({ warm, syncCalls: mocks.sync.mock.calls.length,
      deletionSyncCalls: mocks.deletionSync.mock.calls.length, ingestCalls: mocks.ingest.mock.calls.length,
      errorCount: errors.length, firstError: errors[0] }));
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(mocks.sync.mock.calls.length).toBeGreaterThan(0);
    expect(mocks.deletionSync.mock.calls.length).toBeGreaterThan(0);
  } finally {
    controller.abort();
    for (const listener of process.listeners('SIGTERM')) if (!termListeners.has(listener)) process.removeListener('SIGTERM', listener);
    for (const listener of process.listeners('SIGINT')) if (!intListeners.has(listener)) process.removeListener('SIGINT', listener);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
