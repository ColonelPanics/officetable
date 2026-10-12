import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer } from "recharts";

// Net-over-time line for gambling money, matching the app's Skill History
// chart look. Single series, so the section title names it (no legend).
// One point per official gamble — even a single gamble draws (as a dot), so
// the first gamble shows immediately. X positions are REAL gamble ids.

export interface MoneyPoint {
  /** 0 = the arbitrary zero point the line sets out from; 1..N = official gamble */
  gamble: number | null;
  date: string | null;
  net: number;
}

export function MoneyChart({ points, gradientId = "moneyGradient" }: { points: MoneyPoint[]; gradientId?: string }) {
  if (points.length === 0) return null;

  const data = points.map(point => ({
    gamble: point.gamble ?? 0,
    net: point.net,
    date: point.date
      ? new Date(point.date.replace(" ", "T") + "Z").toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : null,
  }));

  // Y domain always holds 0 (the "no gambling yet" baseline) with padding —
  // and never degenerates when every value is equal or there's one point.
  const nets = data.map(d => d.net);
  let min = Math.min(0, ...nets);
  let max = Math.max(0, ...nets);
  if (min === max) { min -= 10; max += 10; }
  const pad = (max - min) * 0.1;

  return (
    <div className="h-40">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3}/>
              <stop offset="95%" stopColor="#f59e0b" stopOpacity={0}/>
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis
            dataKey="gamble"
            type="number"
            domain={["dataMin", "dataMax"]}
            allowDecimals={false}
            tick={{ fontSize: 10, fill: "#6b7280" }}
            tickLine={false}
            axisLine={{ stroke: "#e5e7eb" }}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "#6b7280" }}
            tickLine={false}
            axisLine={{ stroke: "#e5e7eb" }}
            tickFormatter={(value) => (value > 0 ? `+${value}` : value)}
            domain={[min - pad, max + pad]}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "white",
              border: "none",
              borderRadius: "12px",
              boxShadow: "0 10px 25px -5px rgba(0,0,0,0.1)",
              fontSize: "12px",
            }}
            formatter={(value) =>
              value === null || value === undefined
                ? [null, "Net"]
                : [`${(value as number) > 0 ? "+" : ""}${value as number}`, "Net"]
            }
            labelFormatter={(label) => {
              const point = data.find(d => d.gamble === label);
              if (!point) return `Gamble #${label}`;
              return point.date ? `Official gamble ${label} · ${point.date}` : "Start · net 0";
            }}
          />
          {/* the flat line at 0 — where a player/casino would be without any gambles */}
          <ReferenceLine y={0} stroke="#d1d5db" strokeDasharray="4 4" />
          <Area
            type="monotone"
            dataKey="net"
            stroke="#f59e0b"
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            dot={data.length <= 2 ? { r: 4, fill: "#f59e0b" } : false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}