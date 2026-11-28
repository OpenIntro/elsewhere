import { describe, expect, it } from 'vitest';
import { containsProfanity, filterText, maskProfanity, sanitizeMultiline, sanitizeText } from '../src/moderation/text.js';

describe('text hygiene', () => {
  it('strips control/invisible/bidi chars and collapses whitespace', () => {
    expect(sanitizeText('  hi\u0000 ​ there\n\nfriend ‮ ')).toBe('hi there friend');
    expect(sanitizeText(42)).toBe('');
    expect(sanitizeMultiline('a\r\n\r\n\r\n\r\nb\u0007')).toBe('a\n\nb');
    expect([...sanitizeText('ź́́́́')].length).toBe(3);
  });
  it('masks profanity (incl. simple leetspeak) without over-masking innocent words', () => {
    expect(maskProfanity('well fuck that')).toBe('well f*** that');
    expect(maskProfanity('Sh1t happens')).toBe('S*** happens');
    expect(maskProfanity('f.u.c.k')).toMatch(/^f\*+$/);
    expect(containsProfanity('a cocktail at Scunthorpe, class assessment, cockroach, Dickens')).toBe(false);
    expect(filterText(' hello​  shit ')).toBe('hello s***');
  });
});
