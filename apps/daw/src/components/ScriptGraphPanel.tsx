import { useMemo, useState } from 'react';
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
import { useStore, store } from '../store';
import { checkGraphs, compileGraphs, type GraphNode, type GraphNodeKind } from '@iam/pack';

/**
 * Visual script editor ("スクリプトグラフ"): trigger → logic → action node
 * graphs stored in the project (META) and compiled to Cue VM bytecode at
 * export. This replaces hand-editing cue rule rows for most use cases; the
 * legacy Cues panel still works alongside it.
 */

const EXEC_SOURCES = new Set(['out', 'then', 'else']);

interface Palette {
  label: string;
  kinds: [GraphNodeKind, string][];
}

const PALETTE: Palette[] = [
  {
    label: 'Trigger',
    kinds: [
      ['onModuleStart', 'On Start'],
      ['onRtpcChanged', 'On RTPC Changed'],
      ['onBar', 'On Bar'],
      ['onBeat', 'On Beat'],
      ['onSectionStart', 'On Section Start'],
      ['onSectionEnd', 'On Section End'],
      ['onAnchor', 'On Anchor'],
      ['onManualCue', 'On Manual Cue'],
    ],
  },
  {
    label: 'Value',
    kinds: [
      ['rtpcValue', 'RTPC Value'],
      ['constant', 'Constant'],
      ['sectionRef', 'Section Ref'],
      ['currentSection', 'Current Section'],
      ['positionBeats', 'Position (beats)'],
      ['random', 'Random 0..1'],
      ['math', 'Math (+−×÷)'],
    ],
  },
  {
    label: 'Logic',
    kinds: [
      ['compare', 'Compare'],
      ['and', 'AND'],
      ['or', 'OR'],
      ['not', 'NOT'],
      ['branch', 'Branch (if/else)'],
    ],
  },
  {
    label: 'Action',
    kinds: [
      ['goto', 'Goto Section'],
      ['gotoRandom', 'Goto Random'],
      ['gotoTrack', 'Goto Track (part swap)'],
      ['setTrackGain', 'Set Track Gain'],
      ['setLoop', 'Set Loop'],
      ['setRtpc', 'Set RTPC'],
      ['setPluginParam', 'Set Plugin Param'],
      ['emit', 'Emit Code'],
      ['oneShot', 'One-Shot'],
      ['stop', 'Stop'],
    ],
  },
];

const KIND_LABEL = new Map(PALETTE.flatMap((g) => g.kinds));

function defaultData(kind: GraphNodeKind, s = store): Record<string, unknown> {
  const rtpc = s.project.rtpcs[0]?.id ?? 0;
  const section = s.selectedSection?.id ?? s.project.sections[0]?.id ?? 0;
  const track = s.project.sections.find((x) => x.id === section)?.tracks[0]?.id ?? 0;
  switch (kind) {
    case 'onRtpcChanged':
    case 'rtpcValue':
      return { rtpc };
    case 'onBar':
    case 'onBeat':
    case 'onSectionStart':
    case 'onSectionEnd':
      return { section: null };
    case 'onAnchor':
      return { section, anchor: 0 };
    case 'onManualCue':
      return { name: 'my_cue' };
    case 'constant':
      return { value: 0.5 };
    case 'sectionRef':
      return { section };
    case 'math':
      return { op: '*' };
    case 'compare':
      return { op: '>=' };
    case 'goto':
      return { section, anchor: null, timing: 'nextBar', transition: 'crossfade', fadeMs: 150, bridge: null };
    case 'gotoRandom':
      return { timing: 'nextBar', transition: 'crossfade', fadeMs: 150, bridge: null, targets: [{ section, anchor: null, weight: 1 }] };
    case 'gotoTrack':
      return { section, track, sourceSection: null, sourceTrack: null, timing: 'nextBar', transition: 'crossfade', fadeMs: 150 };
    case 'setTrackGain':
      return { section, track, gain: 1, fadeMs: 100, timing: 'nextBar' };
    case 'setLoop':
      return { section, enabled: true };
    case 'setRtpc':
      return { rtpc, value: 0 };
    case 'setPluginParam':
      return { instance: s.project.pluginInstances[0]?.id ?? 0, param: 0, value: 0 };
    case 'emit':
      return { code: 1 };
    case 'oneShot':
      return { asset: s.project.assets[0]?.id ?? 0, gain: 1, timing: 'immediate' };
    case 'stop':
      return { timing: 'sectionEnd', fadeMs: 300 };
    default:
      return {};
  }
}

function categoryOf(kind: GraphNodeKind): 'trigger' | 'value' | 'logic' | 'branch' | 'action' {
  if (kind === 'branch') return 'branch';
  for (const g of PALETTE) {
    if (g.kinds.some(([k]) => k === kind)) {
      if (g.label === 'Trigger') return 'trigger';
      if (g.label === 'Value') return 'value';
      if (g.label === 'Logic') return 'logic';
      return 'action';
    }
  }
  return 'action';
}

export function ScriptGraphPanel() {
  const s = useStore();
  const graphs = s.project.graphs ?? [];
  const [graphId, setGraphId] = useState<number | null>(graphs[0]?.id ?? null);
  const graph = graphs.find((g) => g.id === graphId) ?? graphs[0] ?? null;
  const [showCompiled, setShowCompiled] = useState(false);

  const addGraph = () => {
    store.update((st) => {
      st.project.graphs ??= [];
      const id = st.nextId(st.project.graphs.map((g) => g.id));
      st.project.graphs.push({ id, name: `graph_${id + 1}`, nodes: [], edges: [] });
      setGraphId(id);
    });
  };

  const rfNodes = useMemo<RFNode[]>(
    () =>
      (graph?.nodes ?? []).map((n) => ({
        id: n.id,
        type: 'iam',
        position: { x: n.x, y: n.y },
        data: { graphId: graph!.id },
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.version, graph?.id],
  );
  const rfEdges = useMemo<RFEdge[]>(
    () =>
      (graph?.edges ?? []).map((e) => ({
        id: `${e.from}.${e.fromPort}->${e.to}.${e.toPort}`,
        source: e.from,
        sourceHandle: e.fromPort,
        target: e.to,
        targetHandle: e.toPort,
        className: EXEC_SOURCES.has(e.fromPort) ? 'edge-exec' : 'edge-value',
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.version, graph?.id],
  );

  const onNodesChange = (changes: NodeChange[]) => {
    if (!graph) return;
    let structural = false;
    store.touch(() => {
      for (const c of changes) {
        if (c.type === 'position' && c.position) {
          const n = graph.nodes.find((x) => x.id === c.id);
          if (n) {
            n.x = c.position.x;
            n.y = c.position.y;
            if (!c.dragging) structural = true; // final position: mark dirty
          }
        } else if (c.type === 'remove') {
          graph.nodes = graph.nodes.filter((x) => x.id !== c.id);
          graph.edges = graph.edges.filter((e) => e.from !== c.id && e.to !== c.id);
          structural = true;
        }
      }
    });
    if (structural) store.update(() => {});
  };

  const onEdgesChange = (changes: EdgeChange[]) => {
    if (!graph) return;
    const removed = changes.filter((c) => c.type === 'remove');
    if (removed.length === 0) return;
    store.update(() => {
      for (const c of removed) {
        graph.edges = graph.edges.filter(
          (e) => `${e.from}.${e.fromPort}->${e.to}.${e.toPort}` !== c.id,
        );
      }
    });
  };

  const onConnect = (c: Connection) => {
    if (!graph || !c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
    const execSource = EXEC_SOURCES.has(c.sourceHandle);
    const execTarget = c.targetHandle === 'in';
    if (execSource !== execTarget) return; // exec ↔ value mismatch
    store.update(() => {
      if (!execTarget) {
        // Value inputs take a single source: replace.
        graph.edges = graph.edges.filter(
          (e) => !(e.to === c.target && e.toPort === c.targetHandle),
        );
      }
      graph.edges.push({
        from: c.source!,
        fromPort: c.sourceHandle!,
        to: c.target!,
        toPort: c.targetHandle!,
      });
    });
  };

  const addNode = (kind: GraphNodeKind) => {
    if (!graph) return;
    store.update((st) => {
      const id = `n${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
      const count = graph.nodes.length;
      graph.nodes.push({
        id,
        kind,
        x: 40 + (count % 5) * 190,
        y: 40 + Math.floor(count / 5) * 130,
        data: defaultData(kind, st),
      });
    });
  };

  const compiled = useMemo(() => {
    if (!showCompiled) return null;
    const issues = checkGraphs(s.project);
    if (issues.length) return { issues, cues: [] as ReturnType<typeof compileGraphs>['cues'] };
    try {
      return { issues: [], cues: compileGraphs(s.project).cues };
    } catch (e) {
      return { issues: [String(e)], cues: [] };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCompiled, s.version]);

  return (
    <div className="graph-panel">
      <div className="graph-toolbar">
        <select
          value={graph?.id ?? ''}
          onChange={(e) => setGraphId(Number(e.target.value))}
          title="Select a script graph"
        >
          {graphs.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <button onClick={addGraph} title="Add a new script graph">
          ＋ Graph
        </button>
        {graph && (
          <>
            <input
              className="graph-name"
              value={graph.name}
              onChange={(e) => store.update(() => (graph.name = e.target.value))}
            />
            <label className="field" title="Disabled graphs are kept but not compiled into the export">
              <input
                type="checkbox"
                checked={graph.enabled !== false}
                onChange={(e) => store.update(() => (graph.enabled = e.target.checked))}
              />
              enabled
            </label>
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) addNode(e.target.value as GraphNodeKind);
                e.target.value = '';
              }}
              title="Add a node to the graph"
            >
              <option value="">＋ Add node…</option>
              {PALETTE.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.kinds.map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <button
              onClick={() => setShowCompiled(!showCompiled)}
              title="Preview the cues/bindings this graph compiles to"
            >
              {showCompiled ? 'Hide compiled' : 'Show compiled'}
            </button>
            <div className="spacer" />
            <button
              onClick={() => {
                if (!confirm(`Delete graph '${graph.name}'?`)) return;
                store.update((st) => {
                  st.project.graphs = (st.project.graphs ?? []).filter((g) => g.id !== graph.id);
                });
                setGraphId(null);
              }}
            >
              Delete graph
            </button>
          </>
        )}
      </div>
      {graph ? (
        <div className="graph-canvas">
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            deleteKeyCode={['Backspace', 'Delete']}
            fitView
            colorMode="dark"
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} />
            <Controls showInteractive={false} />
          </ReactFlow>
          {compiled && (
            <div className="graph-compiled">
              {compiled.issues.length > 0 ? (
                <div className="error">{compiled.issues.join('\n')}</div>
              ) : (
                compiled.cues.map((c) => (
                  <div key={c.id} className="compiled-cue">
                    <b>{c.name}</b>
                    {c.rules.map((r, i) => (
                      <div key={i} className="compiled-rule">
                        <code>{r.condition || '(always)'}</code> →{' '}
                        {r.actions.map((a) => a.type).join(', ')}
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="placeholder">
          Script graphs wire triggers (RTPC change, bar, section end…) through logic to actions
          (goto, track swap, gains…). Click <b>＋ Graph</b> to create one.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Node rendering
// ---------------------------------------------------------------------------

function useGraphNode(graphId: number, nodeId: string): GraphNode | null {
  const s = useStore();
  const g = (s.project.graphs ?? []).find((x) => x.id === graphId);
  return g?.nodes.find((n) => n.id === nodeId) ?? null;
}

function IamNode({ id, data }: { id: string; data: { graphId: number } }) {
  const n = useGraphNode(data.graphId, id);
  if (!n) return null;
  const cat = categoryOf(n.kind);
  return (
    <div className={`gnode gnode-${cat}`}>
      <div className="gnode-title">{KIND_LABEL.get(n.kind) ?? n.kind}</div>
      <NodeBody n={n} />
      <NodePorts n={n} />
    </div>
  );
}

const NODE_TYPES: NodeTypes = { iam: IamNode as never };

function NodePorts({ n }: { n: GraphNode }) {
  const cat = categoryOf(n.kind);
  const valueOut = cat === 'value' || cat === 'logic';
  return (
    <>
      {cat === 'action' && <Handle type="target" position={Position.Left} id="in" className="port-exec" />}
      {(cat === 'trigger' || cat === 'action') && (
        <Handle type="source" position={Position.Right} id="out" className="port-exec" />
      )}
      {cat === 'branch' && (
        <>
          <Handle type="target" position={Position.Left} id="in" className="port-exec" />
          <Handle type="target" position={Position.Left} id="cond" style={{ top: '75%' }} className="port-value" />
          <Handle type="source" position={Position.Right} id="then" style={{ top: '35%' }} className="port-exec" />
          <Handle type="source" position={Position.Right} id="else" style={{ top: '75%' }} className="port-exec" />
        </>
      )}
      {valueOut && n.kind !== 'branch' && (
        <Handle type="source" position={Position.Right} id="value" className="port-value" />
      )}
      {(n.kind === 'compare' || n.kind === 'and' || n.kind === 'or' || n.kind === 'math') && (
        <>
          <Handle type="target" position={Position.Left} id="a" style={{ top: '35%' }} className="port-value" />
          <Handle type="target" position={Position.Left} id="b" style={{ top: '75%' }} className="port-value" />
        </>
      )}
      {n.kind === 'not' && <Handle type="target" position={Position.Left} id="a" className="port-value" />}
      {n.kind === 'setRtpc' || n.kind === 'setPluginParam' ? (
        <Handle type="target" position={Position.Left} id="value" style={{ top: '80%' }} className="port-value" />
      ) : null}
      {n.kind === 'setTrackGain' && (
        <Handle type="target" position={Position.Left} id="gain" style={{ top: '80%' }} className="port-value" />
      )}
    </>
  );
}

// -- small field helpers -----------------------------------------------------

function upd(n: GraphNode, key: string, v: unknown) {
  store.update(() => {
    n.data[key] = v;
  });
}

function SectionSel({ n, k, allowNone, label }: { n: GraphNode; k: string; allowNone?: boolean; label?: string }) {
  const s = useStore();
  const v = n.data[k];
  return (
    <label className="gfield">
      {label ?? 'section'}
      <select
        className="nodrag"
        value={v === null || v === undefined ? '' : String(v)}
        onChange={(e) => upd(n, k, e.target.value === '' ? null : Number(e.target.value))}
      >
        {allowNone && <option value="">any / none</option>}
        {s.project.sections.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function TrackSel({ n, k, sectionKey, label }: { n: GraphNode; k: string; sectionKey: string; label?: string }) {
  const s = useStore();
  const sec = s.project.sections.find((x) => x.id === n.data[sectionKey]);
  return (
    <label className="gfield">
      {label ?? 'track'}
      <select className="nodrag" value={String(n.data[k] ?? '')} onChange={(e) => upd(n, k, Number(e.target.value))}>
        {(sec?.tracks ?? []).map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function RtpcSel({ n, k }: { n: GraphNode; k: string }) {
  const s = useStore();
  return (
    <label className="gfield">
      rtpc
      <select className="nodrag" value={String(n.data[k] ?? '')} onChange={(e) => upd(n, k, Number(e.target.value))}>
        {s.project.rtpcs.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function NumField({ n, k, label, step }: { n: GraphNode; k: string; label: string; step?: number }) {
  return (
    <label className="gfield">
      {label}
      <input
        className="nodrag"
        type="number"
        step={step ?? 1}
        value={Number(n.data[k] ?? 0)}
        onChange={(e) => upd(n, k, Number(e.target.value) || 0)}
      />
    </label>
  );
}

function TimingSel({ n }: { n: GraphNode }) {
  return (
    <label className="gfield">
      timing
      <select className="nodrag" value={String(n.data.timing ?? 'immediate')} onChange={(e) => upd(n, 'timing', e.target.value)}>
        <option value="immediate">immediate</option>
        <option value="nextBeat">next beat</option>
        <option value="nextBar">next bar</option>
        <option value="sectionEnd">section end</option>
      </select>
    </label>
  );
}

function TransitionSel({ n }: { n: GraphNode }) {
  return (
    <label className="gfield">
      transition
      <select className="nodrag" value={String(n.data.transition ?? 'cut')} onChange={(e) => upd(n, 'transition', e.target.value)}>
        <option value="cut">cut</option>
        <option value="crossfade">crossfade</option>
      </select>
    </label>
  );
}

function NodeBody({ n }: { n: GraphNode }) {
  const s = useStore();
  switch (n.kind) {
    case 'onRtpcChanged':
    case 'rtpcValue':
      return <RtpcSel n={n} k="rtpc" />;
    case 'onBar':
    case 'onBeat':
    case 'onSectionStart':
    case 'onSectionEnd':
      return <SectionSel n={n} k="section" allowNone />;
    case 'onAnchor': {
      const sec = s.project.sections.find((x) => x.id === n.data.section);
      return (
        <>
          <SectionSel n={n} k="section" />
          <label className="gfield">
            anchor
            <select className="nodrag" value={String(n.data.anchor ?? '')} onChange={(e) => upd(n, 'anchor', Number(e.target.value))}>
              {(sec?.anchors ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        </>
      );
    }
    case 'onManualCue':
      return (
        <label className="gfield">
          name
          <input className="nodrag" value={String(n.data.name ?? '')} onChange={(e) => upd(n, 'name', e.target.value)} />
        </label>
      );
    case 'constant':
      return <NumField n={n} k="value" label="value" step={0.1} />;
    case 'sectionRef':
      return <SectionSel n={n} k="section" />;
    case 'currentSection':
    case 'positionBeats':
    case 'random':
      return null;
    case 'math':
      return (
        <label className="gfield">
          op
          <select className="nodrag" value={String(n.data.op ?? '*')} onChange={(e) => upd(n, 'op', e.target.value)}>
            {['+', '-', '*', '/'].map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </label>
      );
    case 'compare':
      return (
        <label className="gfield">
          op
          <select className="nodrag" value={String(n.data.op ?? '>=')} onChange={(e) => upd(n, 'op', e.target.value)}>
            {['<', '<=', '>', '>=', '==', '!='].map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </label>
      );
    case 'and':
    case 'or':
    case 'not':
      return null;
    case 'branch':
      return <div className="gfield dim">cond ▸ then / else</div>;
    case 'goto':
      return (
        <>
          <SectionSel n={n} k="section" label="to" />
          <TimingSel n={n} />
          <TransitionSel n={n} />
          {n.data.transition === 'crossfade' && <NumField n={n} k="fadeMs" label="fade ms" />}
          <SectionSel n={n} k="bridge" allowNone label="bridge" />
        </>
      );
    case 'gotoRandom': {
      const targets = Array.isArray(n.data.targets) ? (n.data.targets as { section: number; anchor: number | null; weight: number }[]) : [];
      return (
        <>
          <TimingSel n={n} />
          <TransitionSel n={n} />
          {targets.map((t, i) => (
            <div key={i} className="gfield-row">
              <select
                className="nodrag"
                value={t.section}
                onChange={(e) => store.update(() => (t.section = Number(e.target.value)))}
              >
                {s.project.sections.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
              <input
                className="nodrag weight"
                type="number"
                step={0.1}
                min={0}
                title="weight"
                value={t.weight}
                onChange={(e) => store.update(() => (t.weight = Number(e.target.value) || 0))}
              />
              <button className="nodrag" onClick={() => store.update(() => targets.splice(i, 1))}>✕</button>
            </div>
          ))}
          <button
            className="nodrag"
            onClick={() =>
              store.update(() =>
                targets.push({ section: s.project.sections[0]?.id ?? 0, anchor: null, weight: 1 }),
              )
            }
          >
            ＋ target
          </button>
        </>
      );
    }
    case 'gotoTrack':
      return (
        <>
          <SectionSel n={n} k="section" label="in" />
          <TrackSel n={n} k="track" sectionKey="section" />
          <SectionSel n={n} k="sourceSection" allowNone label="content from" />
          {n.data.sourceSection !== null && n.data.sourceSection !== undefined && (
            <TrackSel n={n} k="sourceTrack" sectionKey="sourceSection" label="src track" />
          )}
          <TimingSel n={n} />
          <TransitionSel n={n} />
          {n.data.transition === 'crossfade' && <NumField n={n} k="fadeMs" label="fade ms" />}
        </>
      );
    case 'setTrackGain':
      return (
        <>
          <SectionSel n={n} k="section" />
          <TrackSel n={n} k="track" sectionKey="section" />
          <NumField n={n} k="gain" label="gain" step={0.05} />
          <NumField n={n} k="fadeMs" label="fade ms" />
          <TimingSel n={n} />
          <div className="gfield dim">gain port overrides</div>
        </>
      );
    case 'setLoop':
      return (
        <>
          <SectionSel n={n} k="section" />
          <label className="gfield">
            loop
            <input
              className="nodrag"
              type="checkbox"
              checked={Boolean(n.data.enabled)}
              onChange={(e) => upd(n, 'enabled', e.target.checked)}
            />
          </label>
        </>
      );
    case 'setRtpc':
      return (
        <>
          <RtpcSel n={n} k="rtpc" />
          <NumField n={n} k="value" label="value" step={0.1} />
          <div className="gfield dim">value port overrides</div>
        </>
      );
    case 'setPluginParam':
      return (
        <>
          <label className="gfield">
            instance
            <select className="nodrag" value={String(n.data.instance ?? '')} onChange={(e) => upd(n, 'instance', Number(e.target.value))}>
              {s.project.pluginInstances.map((i) => {
                const bank = s.project.plugins.find((p) => p.id === i.pluginBankId);
                return (
                  <option key={i.id} value={i.id}>
                    #{i.id} {bank?.name ?? '?'}
                  </option>
                );
              })}
            </select>
          </label>
          <NumField n={n} k="param" label="param id" />
          <NumField n={n} k="value" label="value" step={0.05} />
        </>
      );
    case 'emit':
      return <NumField n={n} k="code" label="code" />;
    case 'oneShot':
      return (
        <>
          <label className="gfield">
            asset
            <select className="nodrag" value={String(n.data.asset ?? '')} onChange={(e) => upd(n, 'asset', Number(e.target.value))}>
              {s.project.assets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <NumField n={n} k="gain" label="gain" step={0.05} />
          <TimingSel n={n} />
        </>
      );
    case 'stop':
      return (
        <>
          <TimingSel n={n} />
          <NumField n={n} k="fadeMs" label="fade ms" />
        </>
      );
    default:
      return null;
  }
}
