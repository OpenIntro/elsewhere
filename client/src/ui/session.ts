/**
 * Session flows used by App/Onboarding/Settings: resume a saved session, enter
 * as guest, register / log in, upgrade a guest, log out. Talks to the server
 * only through net/ + rest (typed shared API). Never fakes success.
 */
import { CONFIG, type Appearance } from '@elsewhere/shared';
import { net, rest, RestError, setAuthToken } from '../net/index.js';
import { STORAGE_KEYS, safeStorage } from '../state/storage.js';
import { useGameStore } from '../state/gameStore.js';

export type EnterRequest =
  | { mode: 'guest'; name: string; appearance: Appearance }
  | { mode: 'register'; name: string; appearance: Appearance; username: string; password: string }
  | { mode: 'login'; username: string; password: string };

/** A user-presentable failure. `code` lets the UI offer the right way forward. */
export class FlowError extends Error {
  constructor(
    public readonly code: 'accounts_unavailable' | 'bad_credentials' | 'username_taken' | 'invalid' | 'network' | 'server',
    message: string,
  ) {
    super(message);
  }
}

function toFlowError(err: unknown, context: 'register' | 'login' | 'join'): FlowError {
  if (err instanceof FlowError) return err;
  if (err instanceof RestError) {
    if (err.code === 'not_implemented' || err.status === 501) {
      return new FlowError('accounts_unavailable', context === 'login' ? 'Logging in isn’t available on this server yet.' : 'Accounts aren’t open on this server yet.');
    }
    if (err.code === 'unauthorized') return new FlowError('bad_credentials', 'That username and password don’t match.');
    if (err.code === 'name_taken') return new FlowError('username_taken', 'That username is taken. Try another.');
    if (err.code === 'invalid_name' || err.code === 'bad_request') return new FlowError('invalid', err.message || 'Please check the details and try again.');
    if (err.code === 'forbidden') return new FlowError('server', err.message || 'This account can’t enter right now.');
    if (err.code === 'rate_limited') return new FlowError('server', 'Too many attempts. Wait a minute and try again.');
    return new FlowError('server', 'The island isn’t answering right now. Try again in a moment.');
  }
  return new FlowError('network', 'Couldn’t reach the island. Check your connection and try again.');
}

export function hasSavedSession(): boolean {
  return !!safeStorage.get(STORAGE_KEYS.session);
}

/**
 * Resume with the saved token. Returns the profile name, or null when there is
 * no usable saved session (token unknown to the server → cleared).
 */
export async function resumeSession(): Promise<string | null> {
  const token = safeStorage.get(STORAGE_KEYS.session);
  if (!token) return null;
  setAuthToken(token);
  try {
    await rest.getProfile();
  } catch (err) {
    if (err instanceof RestError && (err.status === 401 || err.status === 404)) {
      safeStorage.remove(STORAGE_KEYS.session);
      setAuthToken(null);
      return null;
    }
    // Network / 5xx: let connect() decide (it shows its own error).
  }
  try {
    await net.connect({});
  } catch (err) {
    throw toFlowError(err, 'join');
  }
  return useGameStore.getState().profile?.name ?? '';
}

function saveToken(token: string): void {
  safeStorage.set(STORAGE_KEYS.session, token);
  setAuthToken(token);
}

export async function enter(req: EnterRequest): Promise<void> {
  if (req.mode === 'login') {
    try {
      const s = await rest.login({ username: req.username.trim(), password: req.password });
      saveToken(s.token);
    } catch (err) {
      throw toFlowError(err, 'login');
    }
    try {
      await net.connect({});
    } catch (err) {
      throw toFlowError(err, 'join');
    }
    return;
  }
  if (req.mode === 'register') {
    try {
      const guestToken = safeStorage.get(STORAGE_KEYS.session) ?? undefined;
      const s = await rest.register({ username: req.username.trim(), password: req.password, displayName: req.name, ...(guestToken ? { guestToken } : {}) });
      saveToken(s.token);
    } catch (err) {
      throw toFlowError(err, 'register');
    }
    try {
      await rest.saveProfile({ appearance: req.appearance });
    } catch {
      /* the join below also carries the appearance */
    }
  }
  try {
    await net.connect({ name: req.name, appearance: req.appearance });
  } catch (err) {
    throw toFlowError(err, 'join');
  }
}

/** Guest → registered account from Settings (keeps discoveries/history via guestToken). */
export async function upgradeGuest(username: string, password: string, displayName: string): Promise<void> {
  try {
    const guestToken = safeStorage.get(STORAGE_KEYS.session) ?? undefined;
    const s = await rest.register({ username: username.trim(), password, displayName, ...(guestToken ? { guestToken } : {}) });
    saveToken(s.token);
    useGameStore.getState().setProfile(s.profile);
  } catch (err) {
    throw toFlowError(err, 'register');
  }
}

export async function logout(): Promise<void> {
  try {
    await rest.logout();
  } catch {
    /* ignore: we forget the token locally either way */
  }
  safeStorage.remove(STORAGE_KEYS.session);
  safeStorage.remove('elsewhere.chat.v1');
  setAuthToken(null);
  await net.disconnect().catch(() => undefined);
  location.reload();
}

export type CredentialError = 'username_short' | 'username_long' | 'username_chars' | 'password_short' | 'password_long';

export function validateCredentials(username: string, password: string): CredentialError | null {
  const u = username.trim();
  const { usernameMin, usernameMax, passwordMin, passwordMax } = CONFIG.auth;
  if (u.length < usernameMin) return 'username_short';
  if (u.length > usernameMax) return 'username_long';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(u)) return 'username_chars';
  if (password.length < passwordMin) return 'password_short';
  if (password.length > passwordMax) return 'password_long';
  return null;
}

export const CREDENTIAL_ERRORS: Record<CredentialError, string> = {
  username_short: `Usernames need at least ${CONFIG.auth.usernameMin} characters.`,
  username_long: `Usernames can be at most ${CONFIG.auth.usernameMax} characters.`,
  username_chars: 'Start with a letter or number; then letters, numbers, . _ or -.',
  password_short: `Passwords need at least ${CONFIG.auth.passwordMin} characters.`,
  password_long: `Passwords can be at most ${CONFIG.auth.passwordMax} characters.`,
};
