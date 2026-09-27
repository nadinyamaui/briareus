import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../lib/db.js', () => ({
  loadAppSetting: vi.fn(async () => ({})),
  saveAppSetting: vi.fn(async () => {}),
}));
import {
  initMemorySelection,
  selectMemories,
  memoryPolicy,
  setMemoryPolicy,
  memoryHealth,
} from '../lib/memory-selection.js';
beforeEach(initMemorySelection);
const memory = (name, body, type = 'project') => ({
  id: name,
  repo: 'owner/repo',
  name,
  body,
  description: name,
  type,
  updatedAt: '2026-01-01',
});
it('ranks relevant knowledge before recent unrelated facts and always prioritizes user feedback', () => {
  const voice = memory('voice', 'MediaRecorder microphone QA');
  const deploy = { ...memory('deploy', 'systemd deployment'), updatedAt: '2026-09-26' };
  const feedback = memory('preferences', 'Ask only when blocked', 'feedback');
  expect(selectMemories([deploy, voice, feedback], 'microphone MediaRecorder')).toEqual([
    feedback,
    voice,
    deploy,
  ]);
});
it('archives reversibly, verifies exact content, and invalidates verification after an edit', async () => {
  const m = memory('voice', 'one fact');
  await setMemoryPolicy(m, 'verify');
  expect(memoryPolicy(m).verifiedAt).toBeTruthy();
  expect(memoryPolicy({ ...m, body: 'changed' }).verifiedAt).toBeNull();
  await setMemoryPolicy(m, 'archive');
  expect(selectMemories([m])).toEqual([]);
  await setMemoryPolicy(m, 'restore');
  expect(selectMemories([m])).toEqual([m]);
});
it('suggests duplicates only within a project and never deletes them', () => {
  const a = memory('a', 'same text'),
    b = memory('b', 'same text');
  expect(memoryHealth([a, b, { ...a, repo: 'other/repo' }]).duplicates).toHaveLength(1);
});
