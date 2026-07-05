import { useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  type Node as RFNode,
  type Edge as RFEdge,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useDerivedFlow } from './flowState';
import { useStore, store } from '../store';
import { preview } from '../preview';
import { CurveEditor } from './CurveEditor';
import { WCLAP_LIBRARY, findLibraryEntry, fetchBundleBytes } from '../wclapLibrary';
import type { Rtpc } from '@iam/pack';

/**
 * Routing view: the whole interactive design as one patchable node canvas.
 *
 *   [RTPC] ──value──▶ [Blend curve] ──gain──▶ [Track]
 *      └────value──▶ [Param mod]  ──param──▶ [Plugin]
 *   [Generator ♪] ──notes──▶ [Synth] ──synth──▶ [Track]
 *
 * Cables mutate the project model directly; audio always sums into Master
 * (insert/master effect chains are chips on the Track/Master nodes).
 */

// Session-persistent node positions (auto-layout provides defaults).
const positions = new Map<string, { x: number; y: number }>();
let autoSlot: Record<string, number> = {};

function place(id: string, col: number, row: number): { x: number; y: number } {
  const cached = positions.get(id);
  if (cached) return cached;
  const p = { x: 24 + col * 300, y: 24 + row * 170 };
  positions.set(id, p);
  return p;
}

/** Live RTPC values pushed to the running preview (UI state only). */
export const liveRtpcValues = new Map<number, number>();

export function setLiveRtpc(r: Rtpc, v: number) {
  liveRtpcValues.set(r.id, v);
  preview.setRtpc(r.name, v);
  store.touch(() => {});
}

export function RoutingPanel() {
  const s = useStore();
  const project = s.project;

  // ---- derive nodes -------------------------------------------------------
  const deriveNodes = (): RFNode[] => {
    autoSlot = {};
    const row = (col: string) => (autoSlot[col] = (autoSlot[col] ?? 0) + 1) - 1;
    const nodes: RFNode[] = [];
    for (const r of project.rtpcs) {
      const id = `rtpc:${r.id}`;
      nodes.push({ id, type: 'rtpc', position: place(id, 0, row('0')), data: { rtpcId: r.id } });
    }
    for (const b of project.blends ?? []) {
      const id = `blend:${b.id}`;
      nodes.push({ id, type: 'blend', position: place(id, 1, row('1')), data: { blendId: b.id } });
    }
    (project.paramMods ?? []).forEach((m, i) => {
      const id = `mod:${i}`;
      nodes.push({ id, type: 'mod', position: place(id, 1, row('1')), data: { modIndex: i } });
    });
    for (const inst of project.pluginInstances) {
      const id = `inst:${inst.id}`;
      nodes.push({ id, type: 'inst', position: place(id, 2, row('2')), data: { instanceId: inst.id } });
    }
    for (const sec of project.sections) {
      for (const t of sec.tracks) {
        const id = `track:${sec.id}:${t.id}`;
        nodes.push({
          id,
          type: 'track',
          position: place(id, 3, row('3')),
          data: { sectionId: sec.id, trackId: t.id },
        });
      }
    }
    nodes.push({ id: 'master', type: 'master', position: place('master', 4, 0), data: {} });
    return nodes;
  };

  const deriveEdges = (): RFEdge[] => {
    const edges: RFEdge[] = [];
    const push = (
      id: string,
      source: string,
      sourceHandle: string,
      target: string,
      targetHandle: string,
      cls: string,
    ) => edges.push({ id, source, sourceHandle, target, targetHandle, className: cls });
    for (const b of project.blends ?? []) {
      push(`eb1:${b.id}`, `rtpc:${b.rtpc}`, 'value', `blend:${b.id}`, 'rtpc', 'edge-value');
      push(`eb2:${b.id}`, `blend:${b.id}`, 'out', `track:${b.section}:${b.track}`, 'gain', 'edge-mod');
    }
    (project.paramMods ?? []).forEach((m, i) => {
      push(`em1:${i}`, `rtpc:${m.rtpc}`, 'value', `mod:${i}`, 'rtpc', 'edge-value');
      push(`em2:${i}`, `mod:${i}`, 'param', `inst:${m.instance}`, 'param', 'edge-mod');
    });
    (project.noteSources ?? []).forEach((ns, i) => {
      push(`en:${i}`, `inst:${ns.generator}`, 'notes', `inst:${ns.target}`, 'notesIn', 'edge-notes');
    });
    for (const sec of project.sections) {
      for (const t of sec.tracks) {
        if (t.kind === 'instrument' && t.instrument != null) {
          push(
            `ei:${sec.id}:${t.id}`,
            `inst:${t.instrument}`,
            'synth',
            `track:${sec.id}:${t.id}`,
            'synth',
            'edge-audio',
          );
        }
      }
    }
    return edges;
  };

  const flow = useDerivedFlow(() => ({ nodes: deriveNodes(), edges: deriveEdges() }), [s.version]);

  // ---- graph interactions -------------------------------------------------
  const onNodesChange = (changes: NodeChange[]) => {
    flow.applyNodes(changes);
    for (const c of changes) {
      if (c.type === 'position' && c.position) {
        positions.set(c.id, c.position);
      } else if (c.type === 'remove') {
        deleteNode(c.id);
      }
    }
  };

  const deleteNode = (id: string) => {
    const [kind, a, b] = id.split(':');
    store.update((st) => {
      if (kind === 'rtpc') {
        const rid = Number(a);
        st.project.rtpcs = st.project.rtpcs.filter((r) => r.id !== rid);
        st.project.blends = (st.project.blends ?? []).filter((x) => x.rtpc !== rid);
        st.project.paramMods = (st.project.paramMods ?? []).filter((m) => m.rtpc !== rid);
      } else if (kind === 'blend') {
        st.project.blends = (st.project.blends ?? []).filter((x) => x.id !== Number(a));
      } else if (kind === 'mod') {
        st.project.paramMods?.splice(Number(a), 1);
      } else if (kind === 'inst') {
        st.removeInstances([Number(a)]);
      } else if (kind === 'track') {
        // Tracks are managed in the Arrange view; ignore canvas deletes.
        void b;
      }
    });
  };

  const onEdgesChange = (changes: EdgeChange[]) => {
    flow.applyEdges(changes);
    const removed = changes.filter((c) => c.type === 'remove');
    if (!removed.length) return;
    store.update((st) => {
      for (const c of removed) {
        const [tag, key] = c.id.split(':');
        if (tag === 'eb2') {
          st.project.blends = (st.project.blends ?? []).filter((x) => x.id !== Number(key));
        } else if (tag === 'em2') {
          st.project.paramMods?.splice(Number(key), 1);
        } else if (tag === 'en') {
          st.project.noteSources?.splice(Number(key), 1);
        } else if (tag === 'ei') {
          const [, secId, trackId] = c.id.split(':');
          const sec = st.project.sections.find((x) => x.id === Number(secId));
          const tr = sec?.tracks.find((t) => t.id === Number(trackId));
          if (tr) tr.instrument = null;
        }
        // eb1/em1 (rtpc feeds) are re-wired by connecting, not deleted.
      }
    });
  };

  const onConnect = (c: Connection) => {
    if (!c.source || !c.target) return;
    const [sk, sa] = c.source.split(':');
    const [tk, ta, tb] = c.target.split(':');
    store.update((st) => {
      if (sk === 'rtpc' && tk === 'blend' && c.targetHandle === 'rtpc') {
        const bl = (st.project.blends ?? []).find((x) => x.id === Number(ta));
        if (bl) bl.rtpc = Number(sa);
      } else if (sk === 'rtpc' && tk === 'mod' && c.targetHandle === 'rtpc') {
        const m = st.project.paramMods?.[Number(ta)];
        if (m) m.rtpc = Number(sa);
      } else if (sk === 'blend' && tk === 'track' && c.targetHandle === 'gain') {
        const bl = (st.project.blends ?? []).find((x) => x.id === Number(sa));
        if (bl) {
          bl.section = Number(ta);
          bl.track = Number(tb);
        }
      } else if (sk === 'mod' && tk === 'inst' && c.targetHandle === 'param') {
        const m = st.project.paramMods?.[Number(sa)];
        if (m) m.instance = Number(ta);
      } else if (sk === 'inst' && tk === 'inst' && c.sourceHandle === 'notes' && c.targetHandle === 'notesIn') {
        const gen = Number(sa);
        const target = Number(ta);
        if (gen === target) return;
        st.project.noteSources ??= [];
        if (!st.project.noteSources.some((x) => x.generator === gen && x.target === target)) {
          st.project.noteSources.push({ generator: gen, target });
        }
      } else if (sk === 'inst' && tk === 'track' && c.targetHandle === 'synth') {
        const sec = st.project.sections.find((x) => x.id === Number(ta));
        const tr = sec?.tracks.find((t) => t.id === Number(tb));
        if (tr) {
          if (tr.kind !== 'instrument') {
            tr.kind = 'instrument';
            tr.notes ??= [];
            tr.effects ??= [];
            tr.items = [];
          }
          tr.instrument = Number(sa);
        }
      }
    });
  };

  // ---- toolbar ------------------------------------------------------------
  const addRtpc = () =>
    store.update((st) => {
      const id = st.nextRtpcId();
      st.project.rtpcs.push({
        id, name: `param_${id}`, type: 'f32', default: 0, min: 0, max: 1, smoothingMs: 50,
      });
    });

  const addBlend = () =>
    store.update((st) => {
      const rtpc = st.project.rtpcs[0];
      const sec = st.selectedSection ?? st.project.sections[0];
      if (!rtpc || !sec || !sec.tracks.length) {
        alert('A blend needs an RTPC and a section with a track (add them first).');
        return;
      }
      st.project.blends ??= [];
      st.project.blends.push({
        id: st.nextId(st.project.blends.map((x) => x.id)),
        rtpc: rtpc.id,
        section: sec.id,
        track: sec.tracks[0].id,
        points: [
          { x: rtpc.min, y: 0 },
          { x: rtpc.max, y: 1 },
        ],
      });
    });

  const addMod = () =>
    store.update((st) => {
      const rtpc = st.project.rtpcs[0];
      const inst = st.project.pluginInstances[0];
      if (!rtpc || !inst) {
        alert('Param modulation needs an RTPC and a plugin instance.');
        return;
      }
      st.project.paramMods ??= [];
      st.project.paramMods.push({
        instance: inst.id, param: 0, rtpc: rtpc.id,
        points: [
          { x: rtpc.min, y: 0 },
          { x: rtpc.max, y: 1 },
        ],
      });
    });

  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const addPluginInstance = async (clapPluginId: string) => {
    setBusy(true);
    try {
      let bank = store.project.plugins.find((p) => p.clapPluginId === clapPluginId);
      if (!bank) {
        const entry = findLibraryEntry(clapPluginId);
        if (!entry) return;
        const bytes = await fetchBundleBytes(entry.url);
        store.update((st) => {
          const id = st.nextPluginId();
          st.pluginBundles.set(id, bytes);
          st.project.plugins.push({
            id, name: entry.name, clapPluginId, embedded: true, url: entry.url,
          });
        });
        bank = store.project.plugins.find((p) => p.clapPluginId === clapPluginId);
      }
      if (!bank) return;
      store.update((st) => {
        st.project.pluginInstances.push({
          id: st.nextInstanceId(),
          pluginBankId: bank!.id,
          clapPluginId: bank!.clapPluginId,
          params: [],
        });
      });
    } catch (e) {
      alert(`Add plugin failed:\n${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  const addPluginFromFile = async (f: File) => {
    setBusy(true);
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      store.update((st) => {
        const id = st.nextPluginId();
        st.pluginBundles.set(id, bytes);
        st.project.plugins.push({
          id,
          name: f.name.replace(/\.(wclap\.)?tar\.gz$/i, ''),
          clapPluginId: '',
          embedded: true,
        });
        st.project.pluginInstances.push({ id: st.nextInstanceId(), pluginBankId: id, params: [] });
      });
    } catch (e) {
      alert(`Load bundle failed:\n${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="graph-panel">
      <div className="graph-toolbar">
        <button onClick={addRtpc} title="Add a realtime parameter the host game drives">＋ Parameter</button>
        <button onClick={addBlend} title="Add an RTPC→track-gain blend curve (vertical transition)">＋ Blend</button>
        <button onClick={addMod} title="Add an RTPC→plugin-parameter modulation">＋ Param mod</button>
        <select
          value=""
          disabled={busy}
          title="Add a WebCLAP plugin instance"
          onChange={(e) => {
            if (e.target.value) addPluginInstance(e.target.value);
            e.target.value = '';
          }}
        >
          <option value="">{busy ? 'loading…' : '＋ Plugin…'}</option>
          <optgroup label="Instruments">
            {WCLAP_LIBRARY.filter((x) => x.kind === 'instrument').map((x) => (
              <option key={x.clapPluginId} value={x.clapPluginId}>
                {x.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Effects">
            {WCLAP_LIBRARY.filter((x) => x.kind === 'effect').map((x) => (
              <option key={x.clapPluginId} value={x.clapPluginId}>
                {x.name}
              </option>
            ))}
          </optgroup>
        </select>
        <button disabled={busy} onClick={() => fileRef.current?.click()} title="Load a .wclap.tar.gz bundle">
          ＋ .wclap file
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".gz,.tgz,.tar.gz"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) addPluginFromFile(f);
            e.target.value = '';
          }}
        />
        <span className="hint-inline">
          drag cables: parameter → curve → track · generator ♪ → synth → track
        </span>
      </div>
      <div className="graph-canvas">
        <ReactFlow
          nodes={flow.nodes}
          edges={flow.edges}
          nodeTypes={ROUTING_NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          deleteKeyCode={['Backspace', 'Delete']}
          fitView
          minZoom={0.25}
          colorMode="dark"
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={16} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

function RtpcNode({ data }: { data: { rtpcId: number } }) {
  const s = useStore();
  const r = s.project.rtpcs.find((x) => x.id === data.rtpcId);
  const [open, setOpen] = useState(false);
  if (!r) return null;
  const live = liveRtpcValues.get(r.id) ?? r.default;
  return (
    <div className="gnode gnode-rtpc">
      <div className="gnode-title">
        <input
          className="nodrag title-input"
          value={r.name}
          onChange={(e) => store.update(() => (r.name = e.target.value))}
        />
        <button className="nodrag mini-btn" onClick={() => setOpen(!open)} title="Settings">
          {open ? '▾' : '⚙'}
        </button>
      </div>
      <div className="gfield live">
        {r.type === 'bool' ? (
          <input
            className="nodrag"
            type="checkbox"
            checked={live >= 0.5}
            onChange={(e) => setLiveRtpc(r, e.target.checked ? 1 : 0)}
          />
        ) : r.type === 'enum' ? (
          <select className="nodrag" value={live} onChange={(e) => setLiveRtpc(r, Number(e.target.value))}>
            {(r.variants ?? []).map((v, i) => (
              <option key={i} value={i}>
                {v}
              </option>
            ))}
          </select>
        ) : (
          <>
            <input
              className="nodrag wide-range"
              type="range"
              min={r.min}
              max={r.max}
              step={(r.max - r.min) / 200 || 0.01}
              value={live}
              onChange={(e) => setLiveRtpc(r, Number(e.target.value))}
            />
            <span className="dim">{live.toFixed(2)}</span>
          </>
        )}
      </div>
      {open && (
        <>
          <label className="gfield">
            type
            <select
              className="nodrag"
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
            <label className="gfield">
              range
              <span className="pair">
                <input
                  className="nodrag"
                  type="number"
                  value={r.min}
                  onChange={(e) => store.update(() => (r.min = Number(e.target.value) || 0))}
                />
                <input
                  className="nodrag"
                  type="number"
                  value={r.max}
                  onChange={(e) => store.update(() => (r.max = Number(e.target.value) || 0))}
                />
              </span>
            </label>
          )}
          {r.type === 'enum' && (
            <label className="gfield">
              variants
              <input
                className="nodrag"
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
          <label className="gfield">
            smooth ms
            <input
              className="nodrag"
              type="number"
              min={0}
              value={r.smoothingMs}
              onChange={(e) =>
                store.update(() => (r.smoothingMs = Math.max(0, Number(e.target.value) || 0)))
              }
            />
          </label>
        </>
      )}
      <Handle type="source" position={Position.Right} id="value" className="port-value" />
    </div>
  );
}

function BlendNode({ data }: { data: { blendId: number } }) {
  const s = useStore();
  const b = (s.project.blends ?? []).find((x) => x.id === data.blendId);
  if (!b) return null;
  const rtpc = s.project.rtpcs.find((r) => r.id === b.rtpc);
  const sec = s.project.sections.find((x) => x.id === b.section);
  const track = sec?.tracks.find((t) => t.id === b.track);
  return (
    <div className="gnode gnode-blend">
      <div className="gnode-title">Blend curve</div>
      <div className="gfield dim">
        {rtpc?.name ?? '?'} → {sec?.name ?? '?'} / {track?.name ?? '?'}
      </div>
      <CurveEditor
        points={b.points}
        xMin={rtpc?.min ?? 0}
        xMax={rtpc?.max ?? 1}
        onChange={(pts) => store.update(() => (b.points = pts))}
      />
      <Handle type="target" position={Position.Left} id="rtpc" className="port-value" />
      <Handle type="source" position={Position.Right} id="out" className="port-mod" />
    </div>
  );
}

function ModNode({ data }: { data: { modIndex: number } }) {
  const s = useStore();
  const m = s.project.paramMods?.[data.modIndex];
  if (!m) return null;
  const rtpc = s.project.rtpcs.find((r) => r.id === m.rtpc);
  return (
    <div className="gnode gnode-mod">
      <div className="gnode-title">Param mod</div>
      <label className="gfield">
        CLAP param
        <input
          className="nodrag"
          type="number"
          value={m.param}
          onChange={(e) => store.update(() => (m.param = Number(e.target.value) || 0))}
        />
      </label>
      <CurveEditor
        points={m.points}
        xMin={rtpc?.min ?? 0}
        xMax={rtpc?.max ?? 1}
        yMax={Math.max(1.5, ...m.points.map((p) => p.y * 1.2))}
        onChange={(pts) => store.update(() => (m.points = pts))}
      />
      <Handle type="target" position={Position.Left} id="rtpc" className="port-value" />
      <Handle type="source" position={Position.Right} id="param" className="port-mod" />
    </div>
  );
}

function InstNode({ data }: { data: { instanceId: number } }) {
  const s = useStore();
  const inst = s.project.pluginInstances.find((i) => i.id === data.instanceId);
  if (!inst) return null;
  const bank = s.project.plugins.find((p) => p.id === inst.pluginBankId);
  const lib = bank?.clapPluginId ? findLibraryEntry(bank.clapPluginId) : undefined;
  const isGenerator = (s.project.noteSources ?? []).some((x) => x.generator === inst.id);
  const kind = isGenerator ? 'generator' : lib?.kind ?? 'instrument';
  return (
    <div className={`gnode gnode-inst gnode-inst-${kind}`}>
      <div className="gnode-title">
        {bank?.name ?? `plugin ${inst.pluginBankId}`} <span className="badge">{kind}</span>
      </div>
      <div className="gfield dim">#{inst.id} {bank?.embedded ? '· embedded' : ''}</div>
      {inst.params.map((pr, pi) => (
        <div key={pi} className="gfield-row">
          <input
            className="nodrag weight"
            type="number"
            title="CLAP param id"
            value={pr.id}
            onChange={(e) => store.update(() => (pr.id = Number(e.target.value) || 0))}
          />
          <input
            className="nodrag weight"
            type="number"
            step={0.01}
            title="value"
            value={pr.value}
            onChange={(e) => store.update(() => (pr.value = Number(e.target.value) || 0))}
          />
          <button className="nodrag" onClick={() => store.update(() => inst.params.splice(pi, 1))}>
            ✕
          </button>
        </div>
      ))}
      <button
        className="nodrag mini-btn"
        title="Add an initial CLAP parameter value"
        onClick={() => store.update(() => inst.params.push({ id: 0, value: 0 }))}
      >
        ＋ param
      </button>
      {kind === 'effect' ? (
        <MasterChainToggle instanceId={inst.id} />
      ) : (
        <>
          <Handle type="target" position={Position.Left} id="notesIn" className="port-notes" />
          <Handle type="source" position={Position.Right} id="notes" style={{ top: '35%' }} className="port-notes" />
          <Handle type="source" position={Position.Right} id="synth" style={{ top: '70%' }} className="port-audio" />
        </>
      )}
      <Handle type="target" position={Position.Left} id="param" style={{ top: '70%' }} className="port-mod" />
    </div>
  );
}

function MasterChainToggle({ instanceId }: { instanceId: number }) {
  const s = useStore();
  const inChain = s.project.masterEffects.includes(instanceId);
  return (
    <label className="gfield">
      master chain
      <input
        className="nodrag"
        type="checkbox"
        checked={inChain}
        onChange={(e) =>
          store.update((st) => {
            if (e.target.checked) st.project.masterEffects.push(instanceId);
            else st.project.masterEffects = st.project.masterEffects.filter((x) => x !== instanceId);
          })
        }
      />
    </label>
  );
}

function TrackNode({ data }: { data: { sectionId: number; trackId: number } }) {
  const s = useStore();
  const sec = s.project.sections.find((x) => x.id === data.sectionId);
  const t = sec?.tracks.find((x) => x.id === data.trackId);
  if (!sec || !t) return null;
  return (
    <div className={`gnode gnode-track${t.muted ? ' muted' : ''}`}>
      <div className="gnode-title">
        <span className="dim">{sec.name} ·</span> {t.name}
        <span className="badge">{t.kind === 'instrument' ? 'synth' : 'audio'}</span>
      </div>
      <div className="gfield live">
        <button
          className={`nodrag mini-btn${t.muted ? ' on' : ''}`}
          onClick={() =>
            store.update(() => {
              t.muted = !t.muted;
              preview.setTrackMute(sec.id, t.id, t.muted);
            })
          }
        >
          M
        </button>
        <input
          className="nodrag wide-range"
          type="range"
          min={0}
          max={1.5}
          step={0.01}
          value={t.volume}
          title={`volume ${t.volume.toFixed(2)}`}
          onChange={(e) =>
            store.update(() => {
              t.volume = Number(e.target.value);
              preview.setTrackVolume(sec.id, t.id, t.volume);
            })
          }
        />
      </div>
      {(t.effects ?? []).length > 0 && (
        <div className="gfield dim">
          fx: {(t.effects ?? []).map((id) => `#${id}`).join(' → ')}
        </div>
      )}
      <Handle type="target" position={Position.Left} id="gain" className="port-mod" />
      {t.kind === 'instrument' && (
        <Handle type="target" position={Position.Left} id="synth" style={{ top: '70%' }} className="port-audio" />
      )}
    </div>
  );
}

function MasterNode() {
  const s = useStore();
  const name = (id: number) => {
    const inst = s.project.pluginInstances.find((i) => i.id === id);
    const bank = inst && s.project.plugins.find((p) => p.id === inst.pluginBankId);
    return `${bank?.name ?? '?'} #${id}`;
  };
  const move = (idx: number, delta: number) => {
    const j = idx + delta;
    if (j < 0 || j >= s.project.masterEffects.length) return;
    store.update((st) => {
      const arr = st.project.masterEffects;
      [arr[idx], arr[j]] = [arr[j], arr[idx]];
    });
  };
  return (
    <div className="gnode gnode-master">
      <div className="gnode-title">Master 🔊</div>
      <div className="gfield dim">all tracks sum here</div>
      {s.project.masterEffects.map((id, i) => (
        <div key={i} className="gfield-row">
          <span className="chain-name">{i + 1}. {name(id)}</span>
          <button className="nodrag" disabled={i === 0} onClick={() => move(i, -1)}>▲</button>
          <button
            className="nodrag"
            disabled={i === s.project.masterEffects.length - 1}
            onClick={() => move(i, 1)}
          >
            ▼
          </button>
        </div>
      ))}
      {s.project.masterEffects.length === 0 && (
        <div className="gfield dim">enable "master chain" on an effect node</div>
      )}
    </div>
  );
}

const ROUTING_NODE_TYPES: NodeTypes = {
  rtpc: RtpcNode as never,
  blend: BlendNode as never,
  mod: ModNode as never,
  inst: InstNode as never,
  track: TrackNode as never,
  master: MasterNode as never,
};
