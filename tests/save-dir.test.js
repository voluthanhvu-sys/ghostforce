import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createSaveDirStore } from '../server/save-dir.js';

test('save-dir store persists an existing directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-'));
  const file = path.join(dir, 'save-dir.json');
  const store = createSaveDirStore(file);
  store.write(dir);
  assert.equal(store.read(), dir);
  fs.rmSync(dir, { recursive: true, force: true });
});
