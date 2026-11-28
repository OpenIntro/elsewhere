/**
 * Hand-drawn inline SVG icon set (24×24, 1.6 stroke, round caps). Decorative by
 * default (aria-hidden); give the parent control an aria-label.
 */
import type { DayPhase, ItemDef } from '@elsewhere/shared';

export type IconName =
  | 'map'
  | 'bag'
  | 'chat'
  | 'home'
  | 'paper'
  | 'gear'
  | 'close'
  | 'back'
  | 'chevron'
  | 'people'
  | 'sun'
  | 'sunrise'
  | 'sunset'
  | 'moon'
  | 'dusk'
  | 'cloud'
  | 'dice'
  | 'wave'
  | 'dance'
  | 'smile'
  | 'whisper'
  | 'mute'
  | 'volume'
  | 'block'
  | 'flag'
  | 'send'
  | 'sparkle'
  | 'check'
  | 'rotateL'
  | 'rotateR'
  | 'zoomIn'
  | 'zoomOut'
  | 'target'
  | 'camera'
  | 'mail'
  | 'scroll'
  | 'key'
  | 'user'
  | 'pin'
  | 'history'
  | 'shield'
  | 'drop'
  | 'compass';

const P: Record<IconName, React.ReactNode> = {
  map: (
    <>
      <path d="M9 4.5 3.8 6.6v12.9L9 17.4l6 2.1 5.2-2.1V4.5L15 6.6 9 4.5Z" />
      <path d="M9 4.5v12.9M15 6.6v12.9" />
    </>
  ),
  bag: (
    <>
      <path d="M5.5 8.5h13l-1 11.2a1.5 1.5 0 0 1-1.5 1.3H8a1.5 1.5 0 0 1-1.5-1.3l-1-11.2Z" />
      <path d="M9 10.5V7a3 3 0 0 1 6 0v3.5" />
    </>
  ),
  chat: (
    <>
      <path d="M4.5 6.8c0-1.3 1-2.3 2.3-2.3h10.4c1.3 0 2.3 1 2.3 2.3v6.9c0 1.3-1 2.3-2.3 2.3H11l-4.2 3.3V16h0c-1.3 0-2.3-1-2.3-2.3V6.8Z" />
      <path d="M8.5 9.5h7M8.5 12.3h4.5" />
    </>
  ),
  home: (
    <>
      <path d="M4 11 12 4.5l8 6.5" />
      <path d="M6 9.6V19a1 1 0 0 0 1 1h3.5v-5h3v5H17a1 1 0 0 0 1-1V9.6" />
    </>
  ),
  paper: (
    <>
      <path d="M5 5.5h11.5v13a1.5 1.5 0 0 0 1.5 1.5H6.5A1.5 1.5 0 0 1 5 18.5v-13Z" />
      <path d="M16.5 9H19v9.5a1.5 1.5 0 0 1-1.5 1.5" />
      <path d="M8 8.5h5.5M8 11.5h5.5M8 14.5h3.5" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="2.8" />
      <path d="M12 3.8v2.1M12 18.1v2.1M20.2 12h-2.1M5.9 12H3.8M17.8 6.2l-1.5 1.5M7.7 16.3l-1.5 1.5M17.8 17.8l-1.5-1.5M7.7 7.7 6.2 6.2" />
      <circle cx="12" cy="12" r="6.1" />
    </>
  ),
  close: <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />,
  back: <path d="M14.5 6 8.5 12l6 6" />,
  chevron: <path d="m9.5 6 6 6-6 6" />,
  people: (
    <>
      <circle cx="9" cy="8.6" r="3" />
      <path d="M3.8 19c.5-3 2.6-4.8 5.2-4.8s4.7 1.8 5.2 4.8" />
      <path d="M15.2 5.9a2.8 2.8 0 0 1 0 5.4M17 14.6c1.7.6 2.8 2.1 3.2 4.4" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="3.6" />
      <path d="M12 3.5v1.8M12 18.7v1.8M20.5 12h-1.8M5.3 12H3.5M18 6l-1.3 1.3M7.3 16.7 6 18M18 18l-1.3-1.3M7.3 7.3 6 6" />
    </>
  ),
  sunrise: (
    <>
      <path d="M7.5 16a4.5 4.5 0 0 1 9 0" />
      <path d="M3.5 19.5h17M12 5v3.5M5.6 9.6l1.3 1.3M18.4 9.6l-1.3 1.3M3.5 16h1.6M18.9 16h1.6" />
    </>
  ),
  sunset: (
    <>
      <path d="M7.5 15.5a4.5 4.5 0 0 1 9 0" />
      <path d="M3.5 19h17M5.6 9.6l1.3 1.3M18.4 9.6l-1.3 1.3M3.5 15.5h1.6M18.9 15.5h1.6M10 6l2 2 2-2" />
    </>
  ),
  dusk: (
    <>
      <path d="M15.8 5.2a6.8 6.8 0 1 0 3 10.6 5.6 5.6 0 0 1-3-10.6Z" />
      <path d="M3.5 20h17" />
    </>
  ),
  moon: (
    <>
      <path d="M16.5 4.5a7.6 7.6 0 1 0 3 11.9 6.2 6.2 0 0 1-3-11.9Z" />
      <path d="M18.5 4.2v2M17.5 5.2h2" />
    </>
  ),
  cloud: <path d="M7.5 18.5h9.2a3.6 3.6 0 0 0 .4-7.2 5 5 0 0 0-9.6-.9A3.9 3.9 0 0 0 7.5 18.5Z" />,
  dice: (
    <>
      <rect x="4.5" y="4.5" width="15" height="15" rx="3.5" />
      <circle cx="9" cy="9" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="15" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="9" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="15" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  wave: (
    <>
      <path d="M8.2 12.5V7.4a1.3 1.3 0 0 1 2.6 0v4.1M10.8 11V5.9a1.3 1.3 0 0 1 2.6 0V11M13.4 11V6.8a1.3 1.3 0 0 1 2.6 0v6.1" />
      <path d="M16 10.5a1.3 1.3 0 0 1 2.6 0v3.3a6.2 6.2 0 0 1-6.2 6.2h-.6a5.6 5.6 0 0 1-4.5-2.3L5 15a1.4 1.4 0 0 1 2.2-1.7l1 1.2" />
      <path d="M4 6.5c.4-1.2 1.1-2 2.1-2.5M19.5 4.5c.9.5 1.5 1.3 1.8 2.3" />
    </>
  ),
  dance: (
    <>
      <path d="M9.5 17.5V6.2l9-1.7v11" />
      <circle cx="7.5" cy="17.5" r="2" />
      <circle cx="16.5" cy="15.5" r="2" />
    </>
  ),
  smile: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M8.8 13.8a3.8 3.8 0 0 0 6.4 0" />
      <path d="M9.3 9.6h.01M14.7 9.6h.01" strokeWidth="2.2" />
    </>
  ),
  whisper: (
    <>
      <path d="M5 7.2c0-1.2 1-2.2 2.2-2.2h9.6c1.2 0 2.2 1 2.2 2.2v6.1c0 1.2-1 2.2-2.2 2.2H12l-4 3v-3h-.8c-1.2 0-2.2-1-2.2-2.2V7.2Z" />
      <path d="M9 10.3h.01M12 10.3h.01M15 10.3h.01" strokeWidth="2.2" />
    </>
  ),
  mute: (
    <>
      <path d="M4.5 9.5h3l4-3.5v12l-4-3.5h-3z" />
      <path d="m15.5 9.5 5 5M20.5 9.5l-5 5" />
    </>
  ),
  volume: (
    <>
      <path d="M4.5 9.5h3l4-3.5v12l-4-3.5h-3z" />
      <path d="M15.2 9.2a4 4 0 0 1 0 5.6M17.7 6.8a7.4 7.4 0 0 1 0 10.4" />
    </>
  ),
  block: (
    <>
      <circle cx="12" cy="12" r="7.8" />
      <path d="m6.6 6.6 10.8 10.8" />
    </>
  ),
  flag: (
    <>
      <path d="M6 20.5V4.5" />
      <path d="M6 5h10.5l-2.2 3.8 2.2 3.7H6" />
    </>
  ),
  send: <path d="M4.5 11.6 19.5 4.5l-5.2 15-2.8-6.3-7-1.6ZM11.5 13.2l8-8.7" />,
  sparkle: <path d="M12 3.8c.6 3.9 2.3 5.6 6.2 6.2-3.9.6-5.6 2.3-6.2 6.2-.6-3.9-2.3-5.6-6.2-6.2 3.9-.6 5.6-2.3 6.2-6.2ZM18.2 15.6c.3 1.6 1 2.3 2.6 2.6-1.6.3-2.3 1-2.6 2.6-.3-1.6-1-2.3-2.6-2.6 1.6-.3 2.3-1 2.6-2.6Z" />,
  check: <path d="m5.5 12.5 4.2 4.2 8.8-9.4" />,
  rotateL: (
    <>
      <path d="M5.5 12a6.5 6.5 0 1 0 2-4.7" />
      <path d="M5 4.5v3.6h3.6" />
    </>
  ),
  rotateR: (
    <>
      <path d="M18.5 12a6.5 6.5 0 1 1-2-4.7" />
      <path d="M19 4.5v3.6h-3.6" />
    </>
  ),
  zoomIn: (
    <>
      <circle cx="10.8" cy="10.8" r="6" />
      <path d="m15.3 15.3 4.2 4.2M8.3 10.8h5M10.8 8.3v5" />
    </>
  ),
  zoomOut: (
    <>
      <circle cx="10.8" cy="10.8" r="6" />
      <path d="m15.3 15.3 4.2 4.2M8.3 10.8h5" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="6.5" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3" />
    </>
  ),
  camera: (
    <>
      <path d="M4.5 8.6c0-.9.7-1.6 1.6-1.6h2l1.4-2h5l1.4 2h2c.9 0 1.6.7 1.6 1.6v8.8c0 .9-.7 1.6-1.6 1.6H6.1c-.9 0-1.6-.7-1.6-1.6V8.6Z" />
      <circle cx="12" cy="12.8" r="3.2" />
    </>
  ),
  mail: (
    <>
      <rect x="4" y="6" width="16" height="12" rx="2" />
      <path d="m4.8 7.2 7.2 5.6 7.2-5.6" />
    </>
  ),
  scroll: (
    <>
      <path d="M7 4.5h10.5a2 2 0 0 1 2 2V8h-3.5" />
      <path d="M16 8v10a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2v-1.5H13" />
      <path d="M7 4.5a2 2 0 0 0-2 2v10M8.5 9h4.5M8.5 12.3h4.5" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15.5" r="3.5" />
      <path d="m10.6 13 8.4-8.4M15.5 8l2.5 2.5M17.5 6l1.8 1.8" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5.5 19.5c.7-3.5 3.3-5.6 6.5-5.6s5.8 2.1 6.5 5.6" />
    </>
  ),
  pin: (
    <>
      <path d="M12 20.5s6-5.6 6-10.5a6 6 0 0 0-12 0c0 4.9 6 10.5 6 10.5Z" />
      <circle cx="12" cy="10" r="2.2" />
    </>
  ),
  history: (
    <>
      <path d="M4.8 12a7.2 7.2 0 1 0 2.1-5.1" />
      <path d="M4.5 4.8v3.4h3.4M12 8.2V12l2.7 1.8" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.8 5.5 6.3v5.3c0 4.1 2.7 7.4 6.5 8.6 3.8-1.2 6.5-4.5 6.5-8.6V6.3L12 3.8Z" />
      <path d="m9.2 12 2 2 3.8-4" />
    </>
  ),
  drop: (
    <>
      <path d="M12 4.5v10M8 11l4 4 4-4" />
      <path d="M5 19.5h14" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="m14.8 9.2-1.7 3.9-3.9 1.7 1.7-3.9 3.9-1.7Z" />
    </>
  ),
};

export function Icon({ name, size = 22, className, title }: { name: IconName; size?: number; className?: string; title?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      {P[name]}
    </svg>
  );
}

export function phaseIcon(phase: DayPhase): IconName {
  switch (phase) {
    case 'morning':
      return 'sunrise';
    case 'midday':
      return 'sun';
    case 'golden_hour':
      return 'sunset';
    case 'dusk':
      return 'dusk';
    case 'night':
      return 'moon';
  }
}

/** Little illustrative glyph for an item, drawn from its renderer shape hint + colour. */
export function ItemGlyph({ item, size = 40 }: { item: ItemDef; size?: number }) {
  const c = item.color;
  const shape = (() => {
    switch (item.shape) {
      case 'sphere':
        return (
          <>
            <circle cx="20" cy="22" r="10" fill={c} />
            <path d="M20 12c0-3 1.5-5 4-6" stroke="#6b4a2a" strokeWidth="1.8" fill="none" strokeLinecap="round" />
            <ellipse cx="16" cy="18" rx="2.4" ry="3.4" fill="#fff" opacity="0.28" />
          </>
        );
      case 'tool':
        return <path d="M12 30 25 17m0 0a5 5 0 1 0 2.5-6.2l-3 3-1.8-.6-.6-1.8 3-3A5 5 0 0 0 25 17Z" stroke={c} strokeWidth="3.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />;
      case 'flower':
        return (
          <>
            <path d="M20 33V19" stroke="#6f8a52" strokeWidth="2" strokeLinecap="round" />
            {[0, 72, 144, 216, 288].map((a) => (
              <ellipse key={a} cx="20" cy="11.5" rx="3.2" ry="5" fill={c} transform={`rotate(${a} 20 16)`} />
            ))}
            <circle cx="20" cy="16" r="2.6" fill="#f0d27a" />
          </>
        );
      case 'pebble':
        return (
          <>
            <ellipse cx="20" cy="23" rx="12" ry="7.5" fill={c} />
            <ellipse cx="16" cy="20.5" rx="5" ry="2" fill="#fff" opacity="0.22" />
          </>
        );
      case 'cone':
        return (
          <>
            <path d="M20 8c6 4 8 10 7 15s-4 9-7 9-6-4-7-9 1-11 7-15Z" fill={c} />
            <path d="M14 17h12M13.5 22h13M15 27h10" stroke="#4e3520" strokeWidth="1.4" opacity="0.7" />
          </>
        );
      case 'shell':
        return (
          <>
            <path d="M8 26c0-9 5-16 12-16s12 7 12 16c-4 3-20 3-24 0Z" fill={c} />
            <path d="M20 11v17M14 13l3 14M26 13l-3 14M10 19l5 8M30 19l-5 8" stroke="#b8927a" strokeWidth="1.2" />
          </>
        );
      case 'cup':
        return (
          <>
            <path d="M15 9c0-2 2-2 2-4M21 9c0-2 2-2 2-4" stroke="#b9ad98" strokeWidth="1.4" fill="none" strokeLinecap="round" opacity="0.8" />
            <path d="M10 13h18l-2 15a4 4 0 0 1-4 3.5h-6A4 4 0 0 1 12 28Z" fill={c} />
            <path d="M28 16c4 0 4 7 0 7" stroke={c} strokeWidth="2.6" fill="none" />
            <ellipse cx="19" cy="13.5" rx="8.5" ry="1.8" fill="#5a3a26" opacity="0.55" />
          </>
        );
      case 'card':
        return (
          <>
            <rect x="8" y="11" width="24" height="18" rx="2" fill={c} transform="rotate(-6 20 20)" />
            <path d="M12 16h8M12 20h10M12 24h6" stroke="#6b5a4a" strokeWidth="1.3" opacity="0.6" transform="rotate(-6 20 20)" />
          </>
        );
      case 'key':
        return (
          <>
            <circle cx="14" cy="14" r="6" fill="none" stroke={c} strokeWidth="3" />
            <path d="M18.5 18.5 31 31m-4-4 3-3m-6 0 3-3" stroke={c} strokeWidth="3" strokeLinecap="round" />
          </>
        );
      case 'trinket':
        return (
          <>
            <circle cx="20" cy="21" r="10" fill={c} />
            <ellipse cx="16.5" cy="17.5" rx="3" ry="2.2" fill="#fff" opacity="0.3" />
          </>
        );
      case 'lantern':
        return (
          <>
            <path d="M20 5v4" stroke="#6b4a2a" strokeWidth="1.6" />
            <rect x="11" y="9" width="18" height="22" rx="8" fill={c} />
            <path d="M11 15h18M11 25h18" stroke="#b07a32" strokeWidth="1.2" />
            <ellipse cx="20" cy="20" rx="4" ry="6" fill="#fff4cf" opacity="0.45" />
          </>
        );
    }
  })();
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      {shape}
    </svg>
  );
}
