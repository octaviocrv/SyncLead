import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readHostReport, storageLevel } from './storage.js';

test('storage level: nothing up to 70%, warning from 70% to 85%, critical above 85%', () => {
  assert.equal(storageLevel(0, 70, 85), 'ok');
  assert.equal(storageLevel(69.9, 70, 85), 'ok');
  assert.equal(storageLevel(70, 70, 85), 'warning');
  assert.equal(storageLevel(78, 70, 85), 'warning');
  assert.equal(storageLevel(85, 70, 85), 'warning');
  assert.equal(storageLevel(85.1, 70, 85), 'critical');
  assert.equal(storageLevel(100, 70, 85), 'critical');
});

test('host report is used only when fresh and well formed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'synclead-storage-'));
  const file = join(dir, 'report.json');
  const now = Date.parse('2026-11-24T12:00:00Z');
  const body = (generatedAt: string, extra: object = {}) => JSON.stringify({
    generatedAt, backupsBytes: 100, dockerLogsBytes: 200, dockerImagesBytes: 300, dockerVolumesBytes: 400, dockerBuildCacheBytes: 500, ...extra,
  });

  assert.equal(await readHostReport(join(dir, 'missing.json'), now), undefined);

  await writeFile(file, body('2026-11-24T11:50:00Z'));
  assert.deepEqual(await readHostReport(file, now), {
    generatedAt: '2026-11-24T11:50:00Z', backupsBytes: 100, dockerLogsBytes: 200, dockerImagesBytes: 300, dockerVolumesBytes: 400, dockerBuildCacheBytes: 500,
  });

  await writeFile(file, body('2026-11-24T08:00:00Z'));
  assert.equal(await readHostReport(file, now), undefined, 'stale report is ignored');

  await writeFile(file, body('2026-11-24T11:50:00Z', { backupsBytes: 'x', dockerLogsBytes: -1 }));
  const partial = await readHostReport(file, now);
  assert.equal(partial?.backupsBytes, null);
  assert.equal(partial?.dockerLogsBytes, null);

  await writeFile(file, 'not json');
  assert.equal(await readHostReport(file, now), undefined);
});
