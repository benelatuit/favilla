import assert from 'node:assert/strict';
import { it } from 'vitest';
import { EventJournal } from '../src/server/event-journal';

it('replays shared events and only the requested session’s deltas in order', () => {
  const journal = new EventJournal('server');
  const cursor = journal.cursor;
  const began = journal.append('turn.start');
  journal.append('other text', 'other');
  const text = journal.append('active text', 'active');
  const ended = journal.append('turn.end');
  assert.deepEqual(journal.since(cursor, 'active'), [began, text, ended]);
  assert.deepEqual(journal.since(cursor), [began, ended]);
  assert.deepEqual(journal.since(ended.id, 'active'), []);
  assert.equal(journal.since('old-server.0', 'active'), undefined);
  assert.equal(journal.since('server.5', 'active'), undefined);
});

it('requires a full view after replay falls out of the event or byte budget', () => {
  const journal = new EventJournal('server');
  const first = journal.append('first');
  for (let i = 0; i < 4096; i++) journal.append(String(i));
  assert.equal(journal.since('server.0'), undefined);
  assert.equal(journal.since(first.id)?.length, 4096);

  const oversized = journal.append('x'.repeat(4 * 1024 * 1024));
  assert.equal(journal.since(first.id), undefined);
  assert.deepEqual(journal.since(oversized.id), []);
  const next = journal.append('next');
  assert.deepEqual(journal.since(oversized.id), [next]);
});

