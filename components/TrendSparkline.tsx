'use client';

/** Tiny SVG sparkline of a player's recent rating deltas (oldest → newest). */
export function TrendSparkline({ deltas }: { deltas: number[] }) {
  if (deltas.length === 0) {
    return <span className="text-gray-300">—</span>;
  }

  const netChange = deltas.reduce((sum, d) => sum + d, 0);
  const isPositive = netChange >= 0;
  const color = isPositive ? '#16a34a' : '#dc2626';

  const cumulative: number[] = [];
  let running = 0;
  for (const d of deltas) {
    running += d;
    cumulative.push(running);
  }

  const min = Math.min(...cumulative, 0);
  const max = Math.max(...cumulative, 0);
  const range = Math.max(max - min, 1);

  const width = 60;
  const height = 20;
  const padding = 2;

  const points = cumulative.map((val, i) => {
    const x = padding + (i / Math.max(cumulative.length - 1, 1)) * (width - 2 * padding);
    const y = padding + (1 - (val - min) / range) * (height - 2 * padding);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return (
    <svg width={width} height={height} className="inline-block align-middle">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}