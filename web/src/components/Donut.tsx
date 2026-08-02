/**
 * A donut, built the way Vantage builds its progress rings: one SVG circle
 * per segment with a stroke-dasharray, rotated -90deg so it starts at twelve
 * o'clock.
 *
 * A 2px gap is cut from each segment so adjacent fills never touch — without
 * it, two similar slices read as one.
 */

export interface Segment {
  key: string;
  label: string;
  /** Minor units, as a string. Parsed to a Number only for geometry. */
  value: string;
  color: string;
}

interface DonutProps {
  segments: Segment[];
  size: number;
  stroke: number;
  centre: { big: string; small: string };
  /** Segment key to highlight; everything else dims. */
  highlight?: string | null;
  ariaLabel: string;
}

export function Donut({ segments, size, stroke, centre, highlight, ariaLabel }: DonutProps) {
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;

  // Geometry only. These numbers become pixel lengths, never money.
  const values = segments.map((s) => Math.max(0, Number(s.value)));
  const total = values.reduce((a, b) => a + b, 0);
  const drawn = values.filter((v) => v > 0).length;
  const gap = drawn > 1 ? 2 : 0;

  let offset = 0;
  const arcs = segments.map((seg, i) => {
    const value = values[i] ?? 0;
    if (value <= 0 || total <= 0) return null;

    const fraction = value / total;
    const length = Math.max(0, fraction * circumference - gap);
    const arc = (
      <circle
        key={seg.key}
        className={`seg${highlight === seg.key ? ' hot' : ''}`}
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={seg.color}
        strokeWidth={stroke}
        strokeDasharray={`${length.toFixed(2)} ${(circumference - length).toFixed(2)}`}
        strokeDashoffset={(-offset).toFixed(2)}
        strokeLinecap="butt"
      />
    );
    offset += fraction * circumference;
    return arc;
  });

  return (
    <div className={`donut${highlight ? ' dim' : ''}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={ariaLabel}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--slice-rest)"
            strokeWidth={stroke}
            opacity={0.5}
          />
          {arcs}
        </g>
      </svg>
      <div className="donut-centre">
        <span className="big">{centre.big}</span>
        <span className="small">{centre.small}</span>
      </div>
    </div>
  );
}
