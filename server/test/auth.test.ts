import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAuth, hashPassword, verifyPassword } from '../src/auth/index.js';
import { ApiFailure } from '../src/http/errors.js';
import { createPersistence } from '../src/persistence/index.js';

const SECRET = 'test-secret-test-secret-test-secret';

describe('auth', { timeout: 60_000 }, () => {
  it('hashes passwords with scrypt (salted, verifiable, never plaintext)', async () => {
    const h1 = await hashPassword('correct horse');
    const h2 = await hashPassword('correct horse');
    expect(h1).toMatch(/^scrypt\$/);
    expect(h1).not.toContain('correct');
    expect(h1).not.toBe(h2);
    expect(await verifyPassword('correct horse', h1)).toBe(true);
    expect(await verifyPassword('wrong horse', h1)).toBe(false);
  });

  it('guest tokens resume the same profile across a restart; forged/revoked tokens fail', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elsewhere-auth-'));
    try {
      const p1 = createPersistence({ dataDir: dir });
      await p1.init();
      const a1 = createAuth(p1, { secret: SECRET });
      const s = await a1.createGuestSession({ name: 'Fern' });
      expect(s.profile.kind).toBe('guest');
      expect(await a1.verify(s.token)).toEqual({ profileId: s.profile.profileId, kind: 'guest' });
      // Tampered MAC / wrong secret / garbage.
      expect(await a1.verify(s.token.slice(0, -2) + 'xx')).toBeNull();
      expect(await createAuth(p1, { secret: 'other-secret-other-secret-other' }).verify(s.token)).toBeNull();
      expect(await a1.verify('es1.abc.def')).toBeNull();
      expect(await a1.verify(undefined)).toBeNull();
      await p1.close();

      const p2 = createPersistence({ dataDir: dir });
      await p2.init();
      const a2 = createAuth(p2, { secret: SECRET });
      const resumed = await a2.createGuestSession({ token: s.token, name: 'Ignored' });
      expect(resumed.profile.profileId).toBe(s.profile.profileId);
      expect(resumed.profile.name).toBe('Fern');
      await a2.logout(s.token);
      expect(await a2.verify(s.token)).toBeNull();
      await p2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('register upgrades a guest (same profile id, keeps discoveries), login works, wrong password fails, names validated', async () => {
    const p = createPersistence({ dataDir: 'memory://' });
    await p.init();
    const auth = createAuth(p, { secret: SECRET });
    const guest = await auth.createGuestSession({ name: 'Moth' });
    const stored = (await p.profiles.get(guest.profile.profileId))!;
    stored.discoveries.push('carved_owl');
    await p.profiles.save(stored);

    const reg = await auth.register({ username: 'Moth_01', password: 'hunter2hunter2', displayName: 'Moth', guestToken: guest.token });
    expect(reg.profile.profileId).toBe(guest.profile.profileId);
    expect(reg.profile.kind).toBe('registered');
    expect(reg.profile.discoveries).toEqual(['carved_owl']);
    expect(reg.profile.username).toBe('moth_01');
    expect(await auth.verify(guest.token)).toBeNull(); // guest credential retired
    expect((await auth.verify(reg.token))?.kind).toBe('registered');

    const login = await auth.login({ username: 'MOTH_01', password: 'hunter2hunter2' });
    expect(login.profile.profileId).toBe(guest.profile.profileId);
    await expect(auth.login({ username: 'moth_01', password: 'nope-nope-nope' })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(auth.login({ username: 'nobody', password: 'nope-nope-nope' })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(auth.register({ username: 'moth_01', password: 'hunter2hunter2', displayName: 'Other' })).rejects.toMatchObject({ code: 'name_taken' });
    await expect(auth.register({ username: 'x', password: 'hunter2hunter2', displayName: 'Other' })).rejects.toBeInstanceOf(ApiFailure);
    await expect(auth.register({ username: 'okname', password: 'short', displayName: 'Other' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(auth.register({ username: 'okname', password: 'longenough1', displayName: '<script>' })).rejects.toMatchObject({ code: 'invalid_name' });
    const stored2 = await p.profiles.get(guest.profile.profileId);
    expect(stored2?.passwordHash).toMatch(/^scrypt\$/);
    await p.close();
  });

  it('locks out a username after repeated failed logins', async () => {
    const p = createPersistence({ dataDir: 'memory://' });
    await p.init();
    const auth = createAuth(p, { secret: SECRET });
    await auth.register({ username: 'lock_me', password: 'goodpassword', displayName: 'Lock' });
    for (let i = 0; i < 6; i++) await expect(auth.login({ username: 'lock_me', password: 'badpassword' })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(auth.login({ username: 'lock_me', password: 'goodpassword' })).rejects.toMatchObject({ code: 'rate_limited' });
    await p.close();
  });
});
