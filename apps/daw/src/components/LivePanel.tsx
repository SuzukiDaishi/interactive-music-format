import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { preview, usePreview } from '../preview';
import { liveRtpcValues, setLiveRtpc } from './RoutingPanel';

/**
 * Live control: simulate the host game while previewing — output meter,
 * RTPC sliders, and buttons for every manual cue (onManualCue graph nodes).
 * Editing lives in the Arrange / Routing / Logic views; this panel only plays.
 */
export function LivePanel() {
  const s = useStore();
  usePreview();

  const manualCues = new Set<string>();
  for (const g of s.project.graphs ?? []) {
    if (g.enabled === false) continue;
    for (const n of g.nodes) {
      if (n.kind === 'onManualCue' && typeof n.data.name === 'string' && n.data.name) {
        manualCues.add(n.data.name);
      }
    }
  }

  return (
    <div className="panel live-panel">
      <div className="panel-head">
        <span title="試聴中にゲーム側の操作を模擬（パラメータ・Cue 発火）">
          Live Control <span className="head-jp">ゲーム操作を模擬</span>
        </span>
        <Meter />
      </div>
      <div className="panel-body">
        {s.project.rtpcs.map((r) => {
          const live = liveRtpcValues.get(r.id) ?? r.default;
          return (
            <div key={r.id} className="live-row">
              <span className="live-name" title={r.name}>
                {r.name}
              </span>
              {r.type === 'bool' ? (
                <input
                  type="checkbox"
                  checked={live >= 0.5}
                  onChange={(e) => setLiveRtpc(r, e.target.checked ? 1 : 0)}
                />
              ) : r.type === 'enum' ? (
                <select value={live} onChange={(e) => setLiveRtpc(r, Number(e.target.value))}>
                  {(r.variants ?? []).map((v, i) => (
                    <option key={i} value={i}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  <input
                    type="range"
                    min={r.min}
                    max={r.max}
                    step={(r.max - r.min) / 200 || 0.01}
                    value={live}
                    onChange={(e) => setLiveRtpc(r, Number(e.target.value))}
                  />
                  <span className="dim num-label">{live.toFixed(2)}</span>
                </>
              )}
            </div>
          );
        })}
        {s.project.rtpcs.length === 0 && (
          <div className="hint">Routing ビューの「＋ Parameter」でパラメータを追加すると、ここで動かせます。</div>
        )}
        {manualCues.size > 0 && (
          <div className="live-cues">
            <div className="live-cues-label">手動 Cue（クリックで発火）</div>
            {[...manualCues].map((name) => (
              <button key={name} onClick={() => preview.triggerCue(name)} title="再生中のプレビューでこの Cue を発火">
                ⚡ {name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Output peak meter fed by the preview's analyser. */
function Meter() {
  const [peak, setPeak] = useState(0);
  const hold = useRef(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const p = preview.peakLevel();
      hold.current = Math.max(p, hold.current * 0.94);
      setPeak(hold.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const pct = Math.min(1, peak) * 100;
  return (
    <span className="meter" title="Preview output level">
      <span
        className={`meter-fill${peak > 0.98 ? ' clip' : ''}`}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}
