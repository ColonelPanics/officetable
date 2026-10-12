'use client';

import { ScoreOutcome } from '@/lib/types';

// The exact-score odds board: 11 cells on one axis (10-0 → 0-10), bar height
// = win probability, label = UK fractional price. Optional selection callback
// lets the bet form reuse the board as a picker. Predicted line is flagged.

interface Props {
  ladder: ScoreOutcome[];
  predictedLine?: string;
  total: number;
  stake?: number; // entered stake → show projected payout per cell
  selected?: { red: number; blue: number } | null;
  onSelect?: (red: number, blue: number) => void;
}

export function GambleOddsBoard({ ladder, predictedLine, total, stake, selected, onSelect }: Props) {
  const probs = ladder.map(o => o.prob);
  const maxProb = Math.max(...probs, 0.0001);

  const payoutFor = (o: ScoreOutcome) => {
    if (!stake || stake <= 0) return null;
    return Math.floor(stake * o.decimalOdds);
  };

  return (
    <div>
      {/* Board */}
      <div className="grid" style={{ gridTemplateColumns: `repeat(${total + 1}, minmax(0, 1fr))`, gap: '6px' }}>
        {ladder.map((o) => {
          const line = `${o.redScore}-${o.blueScore}`;
          const isSelected = selected?.red === o.redScore && selected?.blue === o.blueScore;
          const isPredicted = predictedLine === line;
          const payout = payoutFor(o);
          const barHeight = Math.max(4, Math.round((o.prob / maxProb) * 72));
          const redHeavy = o.redScore > o.blueScore;
          const blueHeavy = o.blueScore > o.redScore;

          return (
            <button
              key={line}
              type="button"
              onClick={onSelect ? () => onSelect(o.redScore, o.blueScore) : undefined}
              className={`relative flex flex-col items-end justify-end h-28 rounded-lg border px-1 pb-1.5 transition-colors
                ${isSelected ? 'border-primary ring-2 ring-primary/40 bg-primary/5' : 'border-gray-200 bg-card'}
                ${onSelect ? 'hover:border-primary/60 cursor-pointer' : 'cursor-default'}`}
              title={`${line} — ${(o.prob * 100).toFixed(1)}% (${o.fractional})`}
            >
              <div
                className={`absolute bottom-6 left-1 right-1 rounded-sm ${
                  redHeavy ? 'bg-red-500/60' : blueHeavy ? 'bg-blue-500/60' : 'bg-gray-400/50'
                }`}
                style={{ height: `${barHeight}px` }}
              />
              <div className="relative text-[10px] leading-tight text-gray-500 z-10">{(o.prob * 100).toFixed(1)}%</div>
              <div className={`relative text-xs font-bold z-10 ${redHeavy ? 'text-red-600' : blueHeavy ? 'text-blue-600' : 'text-gray-700'}`}>
                {line}
              </div>
              <div className="relative text-[11px] font-semibold text-gray-800 z-10">{o.fractional}</div>
              {payout !== null && (
                <div className="relative text-[10px] text-gray-500 z-10">→ {payout}</div>
              )}
              {isPredicted && (
                <div className="absolute -top-2 text-[9px] bg-amber-400 text-gray-900 px-1 rounded-full font-semibold z-10">line</div>
              )}
            </button>
          );
        })}
      </div>

      {/* A11y table */}
      <details className="mt-3 text-sm">
        <summary className="text-gray-500 cursor-pointer select-none">Full odds as a list</summary>
        <table className="mt-2 w-full max-w-md text-left">
          <thead>
            <tr className="text-xs text-gray-500 border-b border-gray-200">
              <th className="py-1">Score (red–blue)</th>
              <th className="py-1">Decimal</th>
              <th className="py-1">UK price</th>
              <th className="py-1">Chance</th>
            </tr>
          </thead>
          <tbody>
            {ladder.map(o => (
              <tr key={`${o.redScore}-${o.blueScore}`} className="border-b border-gray-100">
                <td className="py-1 font-medium">{o.redScore}-{o.blueScore}</td>
                <td className="py-1 text-gray-600">{o.decimalOdds.toFixed(2)}</td>
                <td className="py-1 text-gray-800">{o.fractional}</td>
                <td className="py-1 text-gray-600">{(o.prob * 100).toFixed(2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}