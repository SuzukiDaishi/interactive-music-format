import { useRef, useState } from 'react';
import { useStore, store } from '../store';
import type { BlendCurve, CurvePoint } from '@iam/pack';

/**
 * Vertical mix editor: RTPC -> track gain blend curves (BLND). The engine
 * evaluates these continuously, so dragging the mapped RTPC slider during
 * preview fades layers in and out ("縦の遷移").
 */
export function BlendPanel() {
  const s = useStore();
  const blends = s.project.blends ?? [];

  const add = () => {
    store.update((st) => {
      st.project.blends ??= [];
      const rtpc = st.project.rtpcs[0];
      const section = st.selectedSection ?? st.project.sections[0];
      if (!rtpc || !section || section.tracks.length === 0) {
        alert('A blend needs at least one RTPC and one section with a track.');
        return;
      }
      st.project.blends.push({
        id: st.nextId(st.project.blends.map((b) => b.id)),
        rtpc: rtpc.id,
        section: section.id,
        track: section.tracks[0].id,
        points: [
          { x: rtpc.min, y: 0 },
          { x: rtpc.max, y: 1 },
        ],
      });
    });
  };

  return (
    <div className="panel blend">
      <div className="panel-head">
        <span title="Vertical transitions: map an RTPC to a track's gain with a curve. The engine blends layers continuously as the parameter moves.">
          Vertical Mix (Blends)
        </span>
        <button title="Add a blend curve" onClick={add}>
          ＋ Add
        </button>
      </div>
      <div className="panel-body">
        {blends.map((b) => (
          <BlendRow key={b.id} blend={b} />
        ))}
        {blends.length === 0 && (
          <div className="hint">
            Blend curves fade tracks with an RTPC (e.g. <i>intensity</i> raises a drums layer) —
            vertical transitions without any scripting. Click <b>＋ Add</b>.
          </div>
        )}
      </div>
    </div>
  );
}

function BlendRow({ blend }: { blend: BlendCurve }) {
  const s = useStore();
  const rtpc = s.project.rtpcs.find((r) => r.id === blend.rtpc);
  const section = s.project.sections.find((x) => x.id === blend.section);

  return (
    <div className="blend-row">
      <div className="blend-controls">
        <select
          value={blend.rtpc}
          title="Driving parameter"
          onChange={(e) =>
            store.update(() => {
              blend.rtpc = Number(e.target.value);
              const r = store.project.rtpcs.find((x) => x.id === blend.rtpc);
              if (r && blend.points.length >= 2) {
                blend.points[0].x = r.min;
                blend.points[blend.points.length - 1].x = r.max;
              }
            })
          }
        >
          {s.project.rtpcs.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <span className="dim">→</span>
        <select
          value={blend.section}
          title="Section"
          onChange={(e) =>
            store.update(() => {
              blend.section = Number(e.target.value);
              const sec = store.project.sections.find((x) => x.id === blend.section);
              if (sec && !sec.tracks.some((t) => t.id === blend.track)) {
                blend.track = sec.tracks[0]?.id ?? 0;
              }
            })
          }
        >
          {s.project.sections.map((sec) => (
            <option key={sec.id} value={sec.id}>
              {sec.name}
            </option>
          ))}
        </select>
        <select
          value={blend.track}
          title="Track whose gain follows the curve"
          onChange={(e) => store.update(() => (blend.track = Number(e.target.value)))}
        >
          {(section?.tracks ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <button
          title="Delete this blend"
          onClick={() =>
            store.update((st) => {
              st.project.blends = (st.project.blends ?? []).filter((x) => x.id !== blend.id);
            })
          }
        >
          ✕
        </button>
      </div>
      <CurveEditor
        points={blend.points}
        xMin={rtpc?.min ?? 0}
        xMax={rtpc?.max ?? 1}
        onChange={(pts) => store.update(() => (blend.points = pts))}
      />
    </div>
  );
}

const W = 220;
const H = 72;
const PAD = 6;
const Y_MAX = 1.5;

/**
 * Small SVG piecewise-linear curve editor. Drag points; double-click the
 * background to add a point; double-click a point to remove it (endpoints
 * stay). Y is linear gain 0..1.5, X spans the RTPC range.
 */
export function CurveEditor({
  points,
  xMin,
  xMax,
  onChange,
}: {
  points: CurvePoint[];
  xMin: number;
  xMax: number;
  onChange: (points: CurvePoint[]) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const span = xMax - xMin || 1;

  const px = (p: CurvePoint) => PAD + ((p.x - xMin) / span) * (W - 2 * PAD);
  const py = (p: CurvePoint) => H - PAD - (Math.min(p.y, Y_MAX) / Y_MAX) * (H - 2 * PAD);
  const fromPx = (cx: number, cy: number): CurvePoint => ({
    x: xMin + Math.min(1, Math.max(0, (cx - PAD) / (W - 2 * PAD))) * span,
    y: Math.min(Y_MAX, Math.max(0, ((H - PAD - cy) / (H - 2 * PAD)) * Y_MAX)),
  });

  const svgPos = (e: { clientX: number; clientY: number }) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { cx: ((e.clientX - rect.left) / rect.width) * W, cy: ((e.clientY - rect.top) / rect.height) * H };
  };

  const move = (e: React.PointerEvent) => {
    if (drag === null) return;
    const { cx, cy } = svgPos(e);
    const p = fromPx(cx, cy);
    const next = points.map((pt, i) => (i === drag ? p : pt));
    // Keep x ascending by clamping against neighbors.
    if (drag > 0) next[drag].x = Math.max(next[drag].x, next[drag - 1].x);
    if (drag < next.length - 1) next[drag].x = Math.min(next[drag].x, next[drag + 1].x);
    onChange(next);
  };

  const addPoint = (e: React.MouseEvent) => {
    const { cx, cy } = svgPos(e);
    const p = fromPx(cx, cy);
    const next = [...points, p].sort((a, b) => a.x - b.x);
    onChange(next);
  };

  const poly = points.map((p) => `${px(p)},${py(p)}`).join(' ');
  const first = points[0];
  const last = points[points.length - 1];

  return (
    <svg
      ref={svgRef}
      className="curve-editor"
      viewBox={`0 0 ${W} ${H}`}
      onDoubleClick={addPoint}
      onPointerMove={move}
      onPointerUp={() => setDrag(null)}
      onPointerLeave={() => setDrag(null)}
    >
      <rect x={0} y={0} width={W} height={H} className="curve-bg" />
      {/* unity-gain line */}
      <line x1={PAD} x2={W - PAD} y1={py({ x: 0, y: 1 })} y2={py({ x: 0, y: 1 })} className="curve-unity" />
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
