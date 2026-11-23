import { describe, it, expect } from './helpers/framework';
import { classifySendError } from '../src/shared/messaging';

/**
 * The popup used to ignore the result of `sendToTab`, so a tab without a content script made
 * the translate button look dead. These are the exact strings Chrome reports; the popup now
 * branches on the code, so the classification has to stay stable.
 */
describe('send error classification', () => {
  it('recognises a tab with no content script', () => {
    expect(classifySendError('Could not establish connection. Receiving end does not exist.')).toBe('no_receiver');
  });

  it('recognises an orphaned content script', () => {
    expect(classifySendError('Extension context invalidated.')).toBe('context_invalidated');
    expect(classifySendError('The message port closed before a response was received.')).toBe('context_invalidated');
  });

  it('keeps anything unknown generic', () => {
    expect(classifySendError('Something else entirely')).toBe('unknown');
  });

  it('treats an empty message as unknown rather than throwing', () => {
    expect(classifySendError('')).toBe('unknown');
  });
});
