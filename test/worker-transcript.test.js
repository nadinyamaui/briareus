import { describe, it, expect, vi } from 'vitest';
import { workerTranscript } from '../lib/worker-transcript.js';

const proposal = 'Proposal\n'.repeat(600) + 'app-modules/orders/src/Mcp/Orders — final acceptance criterion.';

describe('workerTranscript', () => {
  it('clips long text by default, marks it, and never mutates the stored proposal', async () => {
    const event = { kind: 'text', text: proposal };
    const read = vi.fn().mockResolvedValue([event]);
    for (const tail of [12, 200]) {
      const events = await workerTranscript({ seq: 9000 }, { tail }, read);
      expect(events).toEqual([{ kind: 'text', text: proposal.slice(0, 2000) + '…', textTruncated: true }]);
    }
    expect(event.text).toBe(proposal);
    expect(event).not.toHaveProperty('textTruncated');
    expect(read).toHaveBeenCalledWith({ seq: 9000 }, 5000);
  });

  it('returns the entire final proposal only for an explicit full-text request', async () => {
    const event = { kind: 'text', text: proposal };
    const read = vi.fn().mockResolvedValue([event, { kind: 'result' }]);
    expect(await workerTranscript({}, { tail: 12, full_text: 'true' }, read)).toEqual([
      event,
      { kind: 'result' },
    ]);
    expect(read).toHaveBeenCalledWith({}, 0);
    for (const full_text of ['false', '1', ['true']]) {
      expect((await workerTranscript({}, { full_text }, read))[0].textTruncated).toBe(true);
    }
  });

  it.each([{}, { full_text: 'true' }])(
    'preserves filtering, default tail and hard bounds in mode %j',
    async (mode) => {
      const events = Array.from({ length: 600 }, (_, seq) => ({ kind: 'text', text: `entry ${seq}` }));
      const read = vi.fn().mockResolvedValue([...events, { kind: 'tool', text: 'noise' }]);
      expect(await workerTranscript({ seq: 10000 }, mode, read)).toEqual(events.slice(-40));
      expect(await workerTranscript({ seq: 10000 }, { ...mode, tail: 9999 }, read)).toEqual(
        events.slice(-500),
      );
      expect(await workerTranscript({}, { ...mode, tail: -1 }, read)).toEqual(events.slice(-1));
      expect(read).toHaveBeenCalledWith({ seq: 10000 }, 6000);
    },
  );

  it('leaves short and exactly 2000-character entries unchanged', async () => {
    const events = [
      { kind: 'text', text: 'short' },
      { kind: 'text', text: 'x'.repeat(2000) },
      { kind: 'status', status: 'idle' },
    ];
    expect(await workerTranscript({}, {}, async () => events)).toEqual(events);
  });
});
