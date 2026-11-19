/**
 * The X brand mark, drawn inline.
 *
 * Icon packages dropped brand logos, and a generic line icon would not read as
 * X at 16px. `currentColor` keeps it in step with the link's text through the
 * light/dark swap.
 */
export function XMark({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}
