/**
 * Onboarding: title sequence → auth choice (guest / create account / log in)
 * → appearance → display name → enter. Contract: `onEnter(req)` performs the
 * session + join (App passes session.enter) and rejects with a FlowError we
 * show in place. No tutorials, no missions — a new player is in the world in
 * well under a minute.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { CONFIG, randomAppearance, randomDisplayName, validateDisplayName, type Appearance } from '@elsewhere/shared';
import { CharacterPreview } from '../characters/index.js';
import { CustomizationScreen, NAME_ERRORS } from './CustomizationScreen.js';
import { useReducedMotion } from './hooks.js';
import { Icon } from './icons.js';
import { Spinner } from './primitives.js';
import { CREDENTIAL_ERRORS, FlowError, validateCredentials, type EnterRequest } from './session.js';

export interface OnboardingResult {
  name: string;
  appearance: Appearance;
}

export interface OnboardingProps {
  onEnter(req: EnterRequest): Promise<void>;
  /** Back-compat with the foundation seam (called after a successful guest/register entry). */
  onDone?(result: OnboardingResult): void;
}

type Step = 'intro' | 'auth' | 'login' | 'register' | 'customize' | 'name' | 'entering';

export const TAGLINE = 'Somewhere between a game and a place.';

export function Wordmark({ animate = false, className = '' }: { animate?: boolean; className?: string }) {
  const letters = 'Elsewhere'.split('');
  return (
    <h1 className={`wordmark ${animate ? 'wordmark--animate' : ''} ${className}`} aria-label="Elsewhere">
      {letters.map((l, i) => (
        <span key={i} aria-hidden="true" style={{ '--i': i } as React.CSSProperties}>
          {l}
        </span>
      ))}
    </h1>
  );
}

function Intro({ showChoices, children, onSkip }: { showChoices: boolean; children: React.ReactNode; onSkip(): void }) {
  return (
    <div className={`intro ${showChoices ? 'intro--choices' : ''}`} onPointerDown={showChoices ? undefined : onSkip} data-testid="intro">
      <div className="intro__title">
        <Wordmark animate />
        <div className="intro__rule" aria-hidden="true" />
        <p className="intro__tagline">{TAGLINE}</p>
      </div>
      <div className="intro__choices" aria-hidden={!showChoices}>
        {showChoices ? children : null}
      </div>
      {!showChoices ? (
        <button type="button" className="intro__skip" onClick={onSkip} data-testid="intro-skip">
          Skip
        </button>
      ) : null}
    </div>
  );
}

function AuthChoice({ onGuest, onRegister, onLogin }: { onGuest(): void; onRegister(): void; onLogin(): void }) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus({ preventScroll: true }), []);
  return (
    <div className="auth-choice" data-testid="auth-choice">
      <button ref={first} type="button" className="btn btn--primary btn--lg auth-choice__main" onClick={onGuest} data-testid="enter-guest">
        <span>Enter as a guest</span>
        <small>No account needed. You can keep your place later.</small>
      </button>
      <div className="auth-choice__row">
        <button type="button" className="btn btn--ghost" onClick={onRegister} data-testid="choose-register">
          Create an account
        </button>
        <button type="button" className="btn btn--quiet" onClick={onLogin} data-testid="choose-login">
          Log in
        </button>
      </div>
    </div>
  );
}

function CredentialsForm({
  mode,
  onBack,
  onSubmit,
  busy,
  error,
  initial,
}: {
  mode: 'login' | 'register';
  onBack(): void;
  onSubmit(username: string, password: string): void;
  busy: boolean;
  error: string | null;
  initial?: { username: string; password: string };
}) {
  const [username, setUsername] = useState(initial?.username ?? '');
  const [password, setPassword] = useState(initial?.password ?? '');
  const [localErr, setLocalErr] = useState<string | null>(null);
  const id = useId();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'register') {
      const bad = validateCredentials(username, password);
      if (bad) return setLocalErr(CREDENTIAL_ERRORS[bad]);
    } else if (!username.trim() || !password) {
      return setLocalErr('Enter your username and password.');
    }
    setLocalErr(null);
    onSubmit(username, password);
  };
  const shown = localErr ?? error;
  return (
    <form className="card onboard-card" onSubmit={submit} data-testid={`${mode}-form`} noValidate>
      <button type="button" className="icon-btn icon-btn--sm onboard-card__back" onClick={onBack} aria-label="Back">
        <Icon name="back" size={20} />
      </button>
      <h2 className="card__title">{mode === 'login' ? 'Welcome back' : 'Keep your place'}</h2>
      <p className="card__lede">
        {mode === 'login'
          ? 'Log in to return with your character, discoveries and history.'
          : 'An account keeps your character and discoveries across devices. Next, you’ll choose how you look.'}
      </p>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-u`}>
          Username
        </label>
        <input
          id={`${id}-u`}
          className="input"
          value={username}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={CONFIG.auth.usernameMax + 8}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
        />
        {mode === 'register' ? <small className="field__hint">Private — used only to log in. People see your display name.</small> : null}
      </div>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-p`}>
          Password
        </label>
        <input
          id={`${id}-p`}
          className="input"
          type="password"
          value={password}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          maxLength={CONFIG.auth.passwordMax}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {shown ? (
        <p className="form-error" role="alert">
          {shown}
        </p>
      ) : null}
      <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
        {busy ? <Spinner label="Working" /> : mode === 'login' ? 'Log in' : 'Continue'}
      </button>
    </form>
  );
}

function NameStep({
  appearance,
  initialName,
  onBack,
  onSubmit,
  busy,
  error,
  unavailableAccount,
  onGuestInstead,
}: {
  appearance: Appearance;
  initialName: string;
  onBack(): void;
  onSubmit(name: string): void;
  busy: boolean;
  error: string | null;
  unavailableAccount: boolean;
  onGuestInstead(): void;
}) {
  const [name, setName] = useState(initialName);
  const [touched, setTouched] = useState(false);
  const id = useId();
  const v = validateDisplayName(name);
  const nameErr = touched && !v.ok ? NAME_ERRORS[v.reason] : null;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (v.ok) onSubmit(v.name);
  };
  return (
    <form className="card onboard-card name-step" onSubmit={submit} data-testid="name-step" noValidate>
      <button type="button" className="icon-btn icon-btn--sm onboard-card__back" onClick={onBack} aria-label="Back to appearance">
        <Icon name="back" size={20} />
      </button>
      <div className="name-step__preview" aria-hidden="true">
        <CharacterPreview appearance={appearance} anim="wave" spin={0} />
      </div>
      <h2 className="card__title" id={`${id}-h`}>
        What should people call you?
      </h2>
      <div className="field">
        <label className="visually-hidden" htmlFor={id}>
          Display name
        </label>
        <div className="field__row">
          <input
            id={id}
            className={`input input--lg${nameErr ? ' is-invalid' : ''}`}
            value={name}
            autoComplete="nickname"
            spellCheck={false}
            maxLength={CONFIG.profile.displayNameMax + 4}
            aria-invalid={!!nameErr}
            aria-describedby={`${id}-hint`}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setTouched(true)}
            autoFocus
            data-testid="name-input"
          />
          <button type="button" className="icon-btn" aria-label="Suggest a name" title="Suggest a name" onClick={() => setName(randomDisplayName())}>
            <Icon name="dice" size={20} />
          </button>
        </div>
        <small className={nameErr ? 'field__error' : 'field__hint'} id={`${id}-hint`} role={nameErr ? 'alert' : undefined}>
          {nameErr ?? 'Shown above your character. You can change it later.'}
        </small>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {unavailableAccount ? (
        <button type="button" className="btn btn--ghost btn--block" onClick={onGuestInstead} disabled={busy}>
          Enter as a guest instead
        </button>
      ) : null}
      <button type="submit" className="btn btn--primary btn--block btn--lg" disabled={busy} data-testid="enter-world">
        {busy ? <Spinner label="Entering" /> : 'Enter Elsewhere'}
      </button>
    </form>
  );
}

export function Onboarding({ onEnter, onDone }: OnboardingProps) {
  const reduced = useReducedMotion();
  const [step, setStep] = useState<Step>('intro');
  const [path, setPath] = useState<'guest' | 'register'>('guest');
  const [appearance, setAppearance] = useState<Appearance>(() => randomAppearance());
  const [name, setName] = useState(() => randomDisplayName());
  const [creds, setCreds] = useState<{ username: string; password: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accountsUnavailable, setAccountsUnavailable] = useState(false);

  // Title sequence → choices, automatically (short) or on skip.
  useEffect(() => {
    if (step !== 'intro') return;
    const t = setTimeout(() => setStep('auth'), reduced ? 300 : 2600);
    const skip = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') setStep('auth');
    };
    window.addEventListener('keydown', skip);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', skip);
    };
  }, [step, reduced]);

  const run = async (req: EnterRequest, back: Step) => {
    setBusy(true);
    setError(null);
    setStep('entering');
    try {
      await onEnter(req);
      if (req.mode !== 'login') onDone?.({ name: req.name, appearance: req.appearance });
    } catch (err) {
      const fe = err instanceof FlowError ? err : new FlowError('network', 'Something went wrong. Try again.');
      if (fe.code === 'accounts_unavailable' && req.mode === 'register') setAccountsUnavailable(true);
      if (fe.code === 'username_taken' && req.mode === 'register') {
        setError(fe.message);
        setStep('register');
      } else {
        setError(fe.message);
        setStep(back);
      }
    } finally {
      setBusy(false);
    }
  };

  const finish = (finalName: string) => {
    setName(finalName);
    if (path === 'register' && creds && !accountsUnavailable) {
      void run({ mode: 'register', name: finalName, appearance, username: creds.username, password: creds.password }, 'name');
    } else {
      void run({ mode: 'guest', name: finalName, appearance }, 'name');
    }
  };

  const showIntro = step === 'intro' || step === 'auth';

  return (
    <div className={`onboard onboard--${step}`} data-testid="onboarding" data-step={step}>
      <div className="onboard__veil" aria-hidden="true" />
      {showIntro ? (
        <Intro showChoices={step === 'auth'} onSkip={() => setStep('auth')}>
          <AuthChoice
            onGuest={() => {
              setPath('guest');
              setError(null);
              setStep('customize');
            }}
            onRegister={() => {
              setPath('register');
              setError(null);
              setStep('register');
            }}
            onLogin={() => {
              setError(null);
              setStep('login');
            }}
          />
        </Intro>
      ) : null}

      {step === 'login' || step === 'register' ? (
        <div className="onboard__center">
          <Wordmark className="wordmark--small" />
          <CredentialsForm
            key={step}
            mode={step}
            busy={busy}
            error={error}
            initial={creds ?? undefined}
            onBack={() => {
              setError(null);
              setStep('auth');
            }}
            onSubmit={(username, password) => {
              if (step === 'login') return void run({ mode: 'login', username, password }, 'login');
              setCreds({ username, password });
              setError(null);
              setStep('customize');
            }}
          />
        </div>
      ) : null}

      {step === 'customize' ? (
        <div className="onboard__customize">
          <div className="onboard__steps" aria-label="Step 1 of 2: your look">
            <span className="is-on">Your look</span>
            <span aria-hidden="true" className="onboard__dot" />
            <span>Your name</span>
          </div>
          <CustomizationScreen
            initial={appearance}
            layout="screen"
            saveLabel="Continue"
            cancelLabel="Back"
            onCancel={() => setStep(path === 'register' ? 'register' : 'auth')}
            onSave={(a) => {
              setAppearance(a);
              setError(null);
              setStep('name');
            }}
          />
        </div>
      ) : null}

      {step === 'name' ? (
        <div className="onboard__center">
          <NameStep
            appearance={appearance}
            initialName={name}
            busy={busy}
            error={error}
            unavailableAccount={accountsUnavailable && path === 'register'}
            onGuestInstead={() => {
              setPath('guest');
              setAccountsUnavailable(false);
              setError(null);
            }}
            onBack={() => setStep('customize')}
            onSubmit={finish}
          />
        </div>
      ) : null}

      {step === 'entering' ? (
        <div className="onboard__entering" role="status" data-testid="entering">
          <Spinner label="Entering" />
          <p>Stepping into the Town Square…</p>
        </div>
      ) : null}
    </div>
  );
}
