import { describe, it, expect } from 'vitest';
import {
  addStream,
  removeStreamFrom,
  listStreams,
  recordStream,
  forgetStream,
  type StoredStream,
} from '../lib/stream-store';

const mk = (pda: string, over: Partial<StoredStream> = {}): StoredStream => ({
  metadataPda: pda,
  recipient: 'Recip' + pda,
  mint: 'Mint1',
  name: 'Stream ' + pda,
  amount: '10',
  cancelable: true,
  createdAt: 1000,
  ...over,
});

describe('addStream — newest first, dedupe by metadataPda', () => {
  it('prepends new streams', () => {
    const out = addStream(addStream([], mk('A')), mk('B'));
    expect(out.map((s) => s.metadataPda)).toEqual(['B', 'A']);
  });
  it('dedupes (re-adding the same PDA replaces, stays unique)', () => {
    const out = addStream(addStream([], mk('A')), mk('A', { name: 'renamed' }));
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('renamed');
  });
});

describe('removeStreamFrom', () => {
  it('drops the matching PDA, keeps the rest', () => {
    const list = addStream(addStream([], mk('A')), mk('B'));
    expect(removeStreamFrom(list, 'A').map((s) => s.metadataPda)).toEqual(['B']);
  });
});

describe('localStorage-backed (injected fake) round-trip, scoped per address', () => {
  function fakeStorage() {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => void m.set(k, v),
    };
  }

  it('records, lists, and forgets per user address', () => {
    const st = fakeStorage();
    const A = '0xUserA';
    recordStream(A, mk('S1'), st);
    recordStream(A, mk('S2'), st);
    expect(listStreams(A, st).map((s) => s.metadataPda)).toEqual(['S2', 'S1']);

    // a different address sees nothing (scoping)
    expect(listStreams('0xUserB', st)).toEqual([]);

    forgetStream(A, 'S1', st);
    expect(listStreams(A, st).map((s) => s.metadataPda)).toEqual(['S2']);
  });

  it('listStreams tolerates empty / corrupt storage', () => {
    const st = fakeStorage();
    expect(listStreams('0xNope', st)).toEqual([]);
    st.setItem('cardo:streams:0xbad', 'not json');
    expect(listStreams('0xbad', st)).toEqual([]);
  });
});
