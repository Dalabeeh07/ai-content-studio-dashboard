import type { MonthlyBar } from "@/lib/types";

const CHART_W  = 560;
const CHART_H  = 160;
const BAR_GAP  = 16;
const PADDING  = { top: 12, right: 24, bottom: 36, left: 48 };

export default function MonthlyChart({ bars }: { bars: MonthlyBar[] }) {
  if (!bars.length) return null;

  const maxGross = Math.max(...bars.map((b) => b.gross), 0.01);

  const innerW = CHART_W - PADDING.left - PADDING.right;
  const innerH = CHART_H - PADDING.top - PADDING.bottom;
  const barW   = (innerW - BAR_GAP * (bars.length - 1)) / bars.length;

  // Y-axis tick count
  const yTicks = 4;

  return (
    <div className="bg-[#141428] border border-[#1e1e38] rounded-xl p-5">
      <h2 className="text-[#e8e8f0] font-bold text-base mb-4">Monthly Earnings (last 6 months)</h2>

      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="w-full"
        aria-label="Monthly earnings bar chart"
      >
        <g transform={`translate(${PADDING.left},${PADDING.top})`}>
          {/* Y-axis gridlines + labels */}
          {Array.from({ length: yTicks + 1 }).map((_, i) => {
            const pct = i / yTicks;
            const y   = innerH * (1 - pct);
            const val = maxGross * pct;
            return (
              <g key={i}>
                <line
                  x1={0} y1={y} x2={innerW} y2={y}
                  stroke="#1e1e38" strokeWidth={1}
                />
                <text
                  x={-6} y={y + 4}
                  textAnchor="end"
                  fontSize={10}
                  fill="#3a3a60"
                >
                  ${val < 1 ? val.toFixed(2) : val.toFixed(0)}
                </text>
              </g>
            );
          })}

          {/* Bars */}
          {bars.map((b, i) => {
            const x        = i * (barW + BAR_GAP);
            const grossH   = maxGross > 0 ? (b.gross / maxGross) * innerH : 0;
            const adminH   = maxGross > 0 ? (b.admin_share / maxGross) * innerH : 0;
            const userH    = grossH - adminH;

            return (
              <g key={b.month}>
                {/* User portion (mint, bottom) */}
                {userH > 0 && (
                  <rect
                    x={x} y={innerH - grossH}
                    width={barW} height={userH}
                    rx={b.gross > 0 ? 0 : 3}
                    fill="#3dffa0"
                    fillOpacity={0.85}
                  />
                )}
                {/* Admin portion (yellow, top) */}
                {adminH > 0 && (
                  <rect
                    x={x} y={innerH - adminH}
                    width={barW} height={adminH}
                    rx={3}
                    fill="#ffc444"
                    fillOpacity={0.85}
                  />
                )}
                {/* Empty bar placeholder */}
                {grossH === 0 && (
                  <rect
                    x={x} y={innerH - 3}
                    width={barW} height={3}
                    rx={1.5}
                    fill="#1e1e38"
                  />
                )}

                {/* Value label above bar */}
                {b.gross > 0 && (
                  <text
                    x={x + barW / 2}
                    y={innerH - grossH - 4}
                    textAnchor="middle"
                    fontSize={9}
                    fill="#7070a0"
                  >
                    ${b.gross.toFixed(0)}
                  </text>
                )}

                {/* Month label */}
                <text
                  x={x + barW / 2}
                  y={innerH + 16}
                  textAnchor="middle"
                  fontSize={11}
                  fill="#7070a0"
                >
                  {b.label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {/* Legend */}
      <div className="flex gap-5 mt-3">
        <span className="flex items-center gap-1.5 text-xs text-[#7070a0]">
          <span className="w-3 h-3 rounded-sm bg-brand-mint inline-block" />
          User share (60%)
        </span>
        <span className="flex items-center gap-1.5 text-xs text-[#7070a0]">
          <span className="w-3 h-3 rounded-sm bg-brand-yellow inline-block" />
          Admin share (40%)
        </span>
      </div>
    </div>
  );
}
