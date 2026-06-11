import { useState } from 'react';
import { useStore, store } from '../store';
import { preview } from '../preview';
import type { Rtpc } from '@iam/pack';

/** Live values sent to the running preview (UI state only). */
const liveValues = new Map<number, number>();

export function RtpcPanel() {
  const s = useStore();
  const [expanded, setExpanded] = useState<number | null>(null);

  const add = () => {
    store.update((st) => {
      const id = st.nextRtpcId();
      st.project.rtpcs.push({
        id,
        name: `rtpc_${id}`,
        type: 'f32',
        default: 0,
        min: 0,
        max: 1,
        smoothingMs: 0,
      });
    });
  };

  const live = (r: Rtpc) => liveValues.get(r.id) ?? r.default;

  const setLive = (r: Rtpc, v: number) => {
    liveValues.set(r.id, v);
    preview.setRtpc(r.name, v);
    store.touch(() => {});
  };

  return (
    <div className="panel rtpc">
      <div className="panel-head">
        <span title="Realtime parameters the host game/app drives (e.g. intensity, weather). Move a slider while previewing to hear the music react.">
          Parameters (RTPC)
        </span>
        <button title="Add a new parameter" onClick={add}>
          ＋ Add
        </button>
      </div>
      <div className="panel-body">
        {s.project.rtpcs.map((r) => (
          <div key={r.id} className="rtpc-row">
            <div className="rtpc-main">
              <button
                className="rtpc-toggle"
                title={expanded === r.id ? 'Hide settings' : 'Edit name, type, range…'}
                onClick={() => setExpanded(expanded === r.id ? null : r.id)}
              >
                <span className="chev">{expanded === r.id ? '▾' : '▸'}</span>
                <span className="rtpc-name">{r.name}</span>
              </button>
              {r.type === 'f32' && (
                <>
                  <input
                    type="range"
                    min={r.min}
                    max={r.max}
                    step={(r.max - r.min) / 200 || 0.01}
                    value={live(r)}
                    onChange={(e) => setLive(r, Number(e.target.value))}
                  />
                  <span className="dim num-label">{live(r).toFixed(2)}</span>
                </>
              )}
              {r.type === 'bool' && (
                <input
                  type="checkbox"
                  checked={live(r) >= 0.5}
                  onChange={(e) => setLive(r, e.target.checked ? 1 : 0)}
                />
              )}
              {r.type === 'enum' && (
                <select value={live(r)} onChange={(e) => setLive(r, Number(e.target.value))}>
                  {(r.variants ?? []).map((v, i) => (
                    <option key={i} value={i}>
                      {v}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {expanded === r.id && (
              <div className="rtpc-edit">
                <label className="field">
                  Name
                  <input
                    value={r.name}
                    onChange={(e) => store.update(() => (r.name = e.target.value))}
                  />
                </label>
                <label className="field">
                  Type
                  <select
                    value={r.type}
                    onChange={(e) =>
                      store.update(() => {
                        r.type = e.target.value as Rtpc['type'];
                        if (r.type === 'enum' && !r.variants) r.variants = ['a', 'b'];
                        if (r.type === 'bool') {
                          r.min = 0;
                          r.max = 1;
                        }
                      })
                    }
                  >
                    <option value="f32">f32</option>
                    <option value="bool">bool</option>
                    <option value="enum">enum</option>
                  </select>
                </label>
                {r.type === 'f32' && (
                  <>
                    <label className="field">
                      Min
                      <input
                        type="number"
                        value={r.min}
                        onChange={(e) => store.update(() => (r.min = Number(e.target.value) || 0))}
                      />
                    </label>
                    <label className="field">
                      Max
                      <input
                        type="number"
                        value={r.max}
                        onChange={(e) => store.update(() => (r.max = Number(e.target.value) || 0))}
                      />
                    </label>
                  </>
                )}
                {r.type === 'enum' && (
                  <label className="field wide">
                    Variants (comma separated)
                    <input
                      value={(r.variants ?? []).join(',')}
                      onChange={(e) =>
                        store.update(() => {
                          r.variants = e.target.value.split(',').map((v) => v.trim()).filter(Boolean);
                          r.min = 0;
                          r.max = Math.max(0, (r.variants?.length ?? 1) - 1);
                        })
                      }
                    />
                  </label>
                )}
                <label className="field">
                  Default
                  <input
                    type="number"
                    value={r.default}
                    onChange={(e) => store.update(() => (r.default = Number(e.target.value) || 0))}
                  />
                </label>
                <label className="field">
                  Smooth ms
                  <input
                    type="number"
                    min={0}
                    value={r.smoothingMs}
                    onChange={(e) =>
                      store.update(() => (r.smoothingMs = Math.max(0, Number(e.target.value) || 0)))
                    }
                  />
                </label>
                <button
                  onClick={() => {
                    if (!confirm(`Delete RTPC '${r.name}'?`)) return;
                    store.update((st) => {
                      st.project.rtpcs = st.project.rtpcs.filter((x) => x.id !== r.id);
                      st.project.bindings = st.project.bindings.filter(
                        (b) => !(b.trigger.type === 'rtpcChanged' && b.trigger.rtpc === r.id),
                      );
                    });
                  }}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        ))}
        {s.project.rtpcs.length === 0 && (
          <div className="hint">
            Parameters (RTPCs) are realtime values the host game/app drives — e.g. <i>intensity</i>,
            <i> weather</i>. Cues can react to them. Click <b>＋ Add</b> to create one.
          </div>
        )}
      </div>
    </div>
  );
}
