import { useRef, useState } from 'react';
import type { CurvePoint } from '@iam/pack';

const W = 220;
const H = 72;
const PAD = 6;
const Y_MAX = 1.5;

/**
 * Small SVG piecewise-linear curve editor. Drag points; double-click the
 * background to add a point; double-click a point to remove it. Y is linear
 * gain 0..1.5, X spans the given range.
 */
export function CurveEditor({
  points,
  xMin,
  xMax,
  yMax = Y_MAX,
  onChange,
}: {
  points: CurvePoint[];
  xMin: number;
  xMax: number;
  yMax?: number;
  onChange: (points: CurvePoint[]) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const span = xMax - xMin || 1;

  const px = (p: CurvePoint) => PAD + ((p.x - xMin) / span) * (W - 2 * PAD);
  const py = (p: CurvePoint) => H - PAD - (Math.min(p.y, yMax) / yMax) * (H - 2 * PAD);
  const fromPx = (cx: number, cy: number): CurvePoint => ({
    x: xMin + Math.min(1, Math.max(0, (cx - PAD) / (W - 2 * PAD))) * span,
    y: Math.min(yMax, Math.max(0, ((H - PAD - cy) / (H - 2 * PAD)) * yMax)),
  });

  const svgPos = (e: { clientX: number; clientY: number }) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      cx: ((e.clientX - rect.left) / rect.width) * W,
      cy: ((e.clientY - rect.top) / rect.height) * H,
    };
  };

  const move = (e: React.PointerEvent) => {
    if (drag === null) return;
    const { cx, cy } = svgPos(e);
    const p = fromPx(cx, cy);
    const next = points.map((pt, i) => (i === drag ? p : pt));
    if (drag > 0) next[drag].x = Math.max(next[drag].x, next[drag - 1].x);
    if (drag < next.length - 1) next[drag].x = Math.min(next[drag].x, next[drag + 1].x);
    onChange(next);
  };

  const addPoint = (e: React.MouseEvent) => {
    const { cx, cy } = svgPos(e);
    const next = [...points, fromPx(cx, cy)].sort((a, b) => a.x - b.x);
    onChange(next);
  };

  const poly = points.map((p) => `${px(p)},${py(p)}`).join(' ');
  const first = points[0];
  const last = points[points.length - 1];

  return (
    <svg
      ref={svgRef}
      className="curve-editor nodrag"
      viewBox={`0 0 ${W} ${H}`}
      onDoubleClick={addPoint}
      onPointerMove={move}
      onPointerUp={() => setDrag(null)}
      onPointerLeave={() => setDrag(null)}
    >
      <rect x={0} y={0} width={W} height={H} className="curve-bg" />
      <line
        x1={PAD}
        x2={W - PAD}
        y1={py({ x: 0, y: 1 })}
        y2={py({ x: 0, y: 1 })}
        className="curve-unity"
      />
      {first && (
        <polyline
          className="curve-line"
          points={`${PAD},${py(first)} ${poly} ${W - PAD},${py(last)}`}
        />
      )}
      {points.map((p, i) => (
        <circle
          key={i}
          cx={px(p)}
          cy={py(p)}
          r={4}
          className={`curve-point${drag === i ? ' dragging' : ''}`}
          onPointerDown={(e) => {
            e.stopPropagation();
            (e.target as Element).setPointerCapture?.(e.pointerId);
            setDrag(i);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (points.length <= 1) return;
            onChange(points.filter((_, j) => j !== i));
          }}
        />
      ))}
    </svg>
  );
}
