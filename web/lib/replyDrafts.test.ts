import { afterEach, describe, expect, it } from 'vitest';
import { clearReplyDrafts, readReplyDraft, replyDraftKey, writeReplyDraft } from './replyDrafts';

describe('reply drafts', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it('saves and reads a draft per user and thread, and forgets an empty one', () => {
    writeReplyDraft('u1', 'task', 't1', { body: 'half a thought', attachments: [] });
    expect(readReplyDraft('u1', 'task', 't1')).toEqual({ body: 'half a thought', attachments: [] });
    expect(readReplyDraft('u1', 'issue', 't1')).toBeNull();

    writeReplyDraft('u1', 'task', 't1', { body: '  ', attachments: [] });
    expect(sessionStorage.getItem(replyDraftKey('u1', 'task', 't1'))).toBeNull();
  });

  it('keeps an answer to a reply apart from the thread’s own draft (BAT-13)', () => {
    writeReplyDraft('u1', 'task', 't1', { body: 'top level', attachments: [] });
    writeReplyDraft('u1', 'task', 't1', { body: 'an answer', attachments: [] }, 'r1');
    expect(readReplyDraft('u1', 'task', 't1')?.body).toBe('top level');
    expect(readReplyDraft('u1', 'task', 't1', 'r1')?.body).toBe('an answer');
    expect(readReplyDraft('u1', 'task', 't1', 'r2')).toBeNull();
    clearReplyDrafts();
    expect(readReplyDraft('u1', 'task', 't1', 'r1')).toBeNull();
  });

  // Someone else signing in in the same tab must never be offered another person's unsent text.
  it("never hands one user's draft to another", () => {
    writeReplyDraft('u1', 'issue', 'i1', { body: 'private note', attachments: [] });
    expect(readReplyDraft('u2', 'issue', 'i1')).toBeNull();
  });

  it('clears every draft on sign-out and leaves other storage alone', () => {
    writeReplyDraft('u1', 'issue', 'i1', { body: 'one', attachments: [] });
    writeReplyDraft('u1', 'task', 't1', { body: 'two', attachments: [] });
    sessionStorage.setItem('other', 'kept');
    clearReplyDrafts();
    expect(readReplyDraft('u1', 'issue', 'i1')).toBeNull();
    expect(readReplyDraft('u1', 'task', 't1')).toBeNull();
    expect(sessionStorage.getItem('other')).toBe('kept');
  });

  it('ignores a malformed draft', () => {
    sessionStorage.setItem(replyDraftKey('u1', 'task', 't1'), '{"body":1}');
    expect(readReplyDraft('u1', 'task', 't1')).toBeNull();
    sessionStorage.setItem(replyDraftKey('u1', 'task', 't1'), 'not json');
    expect(readReplyDraft('u1', 'task', 't1')).toBeNull();
  });
});
