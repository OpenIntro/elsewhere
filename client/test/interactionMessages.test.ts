import { describe, expect, it } from 'vitest';
import { interactErrorNotice } from '../src/player/interactionMessages.js';

describe('interaction error wording', () => {
  it('stays quiet for not_implemented / rate limits / no code', () => {
    expect(interactErrorNotice('not_implemented', 'bell')).toBeNull();
    expect(interactErrorNotice('rate_limited')).toBeNull();
    expect(interactErrorNotice(undefined)).toBeNull();
  });
  it('uses friendly per-kind wording and never leaks the raw code', () => {
    const cases = [
      interactErrorNotice('occupied', 'bench'),
      interactErrorNotice('occupied', 'pickup'),
      interactErrorNotice('occupied', 'mailbox', 'Post Box'),
      interactErrorNotice('cooldown', 'bell'),
      interactErrorNotice('cooldown', 'lantern'),
      interactErrorNotice('too_far', 'sign'),
      interactErrorNotice('blocked', 'mailbox'),
      interactErrorNotice('forbidden', 'door'),
      interactErrorNotice('forbidden', 'chair'),
      interactErrorNotice('not_found'),
      interactErrorNotice('internal'),
    ];
    for (const n of cases) {
      expect(n).not.toBeNull();
      expect(n!.text).not.toMatch(/occupied|cooldown|too_far|blocked|forbidden|not_found|internal|\(|Can't do that/i);
      expect(n!.level).toBe('info');
    }
    expect(interactErrorNotice('occupied', 'bench')!.text).toMatch(/seat/i);
    expect(interactErrorNotice('cooldown', 'bell')!.text).toMatch(/bell/i);
    expect(interactErrorNotice('occupied', 'mailbox', 'Post Box')!.text).toContain('post box');
  });
});
