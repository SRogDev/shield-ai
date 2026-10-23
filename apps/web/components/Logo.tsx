/**
 * Shield AI mark — original for this product (PLAN_V2 §13): a shield
 * outline fused with an AI node/spark motif, extreme minimalist strokes,
 * legible at favicon size. Not derived from any stock icon set.
 */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      role="img"
      aria-label="Shield AI"
    >
      <path
        d="M24 4 40 10v12c0 10.5-6.8 17.7-16 22C14.8 39.7 8 32.5 8 22V10L24 4Z"
        stroke="#2563EB"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <circle cx="24" cy="19" r="2.6" fill="#2563EB" />
      <circle cx="16.5" cy="28" r="2.2" fill="#2563EB" />
      <circle cx="31.5" cy="28" r="2.2" fill="#2563EB" />
      <path
        d="M22.6 21.2 18 25.9M25.4 21.2 30 25.9M18.7 28h10.6"
        stroke="#2563EB"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
