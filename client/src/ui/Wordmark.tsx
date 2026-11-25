/** The Elsewhere wordmark (letters animate in when `animate`). */
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
