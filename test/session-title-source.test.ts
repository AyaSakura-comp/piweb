import { describe, expect, it } from 'vitest';
import {
  MAX_SESSION_TITLE_SOURCE_LENGTH,
  buildSessionTitleSource,
  resolveSessionCreationTitle,
} from '../src/web/session-title-source.js';

describe('session creation title policy', () => {
  it('prepares automatic naming only when the caller did not supply a name', () => {
    expect(resolveSessionCreationTitle(undefined)).toEqual({
      name: 'New session',
      prepareSessionTitle: true,
    });
    expect(resolveSessionCreationTitle('  Release notes  ')).toEqual({
      name: 'Release notes',
      prepareSessionTitle: false,
    });
  });
});

describe('session title source', () => {
  it('keeps typed text, quoted context, and attachment names from the first turn', () => {
    const source = buildSessionTitleSource(
      'Explain why this request failed',
      'The API returned a malformed response',
      ['trace.log', 'response.json'],
    );

    expect(source).toContain('Explain why this request failed');
    expect(source).toContain('The API returned a malformed response');
    expect(source).toContain('trace.log');
    expect(source).toContain('response.json');
  });

  it('bounds a long source without dropping quote or attachment context', () => {
    const source = buildSessionTitleSource(
      'x'.repeat(MAX_SESSION_TITLE_SOURCE_LENGTH * 2),
      'quoted context',
      ['trace.log'],
    );

    expect(source.length).toBeLessThanOrEqual(MAX_SESSION_TITLE_SOURCE_LENGTH);
    expect(source).toContain('quoted context');
    expect(source).toContain('trace.log');
  });

  it('never splits a Unicode surrogate pair at the source limit', () => {
    const source = buildSessionTitleSource(
      `${'x'.repeat(MAX_SESSION_TITLE_SOURCE_LENGTH - 1)}😀`,
      '',
      [],
    );

    expect(Buffer.from(source, 'utf8').toString('utf8')).toBe(source);
    expect(source).toBe('x'.repeat(MAX_SESSION_TITLE_SOURCE_LENGTH - 1));
  });

  it('consumes an attachment-only first turn even when its filename is blank', () => {
    const source = buildSessionTitleSource('', '', ['   ']);

    expect(source).toBe('Attachment');
  });
});
