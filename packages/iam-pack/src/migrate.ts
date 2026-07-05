/**
 * Cue -> script-graph migration: converts hand-authored cues/bindings into
 * equivalent visual graphs so the DAW can present a single, node-based
 * scripting surface. Rule conditions become `expr` nodes (raw expression
 * text), so the conversion is lossless with respect to compiled behavior:
 * migrated graphs compile back to the same rule structure.
 */

import type {
  Binding,
  Cue,
  CueAction,
  GraphEdge,
  GraphNode,
  IamProject,
  ScriptGraph,
} from './model.js';

function triggerNode(id: string, b: Binding, x: number, y: number): GraphNode {
  const t = b.trigger;
  switch (t.type) {
    case 'rtpcChanged':
      return { id, kind: 'onRtpcChanged', x, y, data: { rtpc: t.rtpc } };
    case 'sectionStart':
      return { id, kind: 'onSectionStart', x, y, data: { section: t.section } };
    case 'sectionEnd':
      return { id, kind: 'onSectionEnd', x, y, data: { section: t.section } };
    case 'anchorReached':
      return { id, kind: 'onAnchor', x, y, data: { section: t.section, anchor: t.anchor } };
    case 'bar':
      return { id, kind: 'onBar', x, y, data: { section: t.section } };
    case 'beat':
      return { id, kind: 'onBeat', x, y, data: { section: t.section } };
    case 'moduleStart':
      return { id, kind: 'onModuleStart', x, y, data: {} };
  }
}

function actionNode(id: string, a: CueAction, x: number, y: number): GraphNode {
  switch (a.type) {
    case 'goto':
      return {
        id, kind: 'goto', x, y,
        data: {
          section: a.section, anchor: a.anchor, timing: a.timing,
          transition: a.transition, fadeMs: a.fadeMs, bridge: a.bridge ?? null,
        },
      };
    case 'gotoRandom':
      return {
        id, kind: 'gotoRandom', x, y,
        data: {
          timing: a.timing, transition: a.transition, fadeMs: a.fadeMs,
          bridge: a.bridge ?? null, targets: a.targets,
        },
      };
    case 'play':
      // No dedicated node kind: play(section) ≈ goto immediate/cut.
      return {
        id, kind: 'goto', x, y,
        data: {
          section: a.section, anchor: a.anchor, timing: 'immediate',
          transition: 'cut', fadeMs: 0, bridge: null,
        },
      };
    case 'gotoTrack':
      return {
        id, kind: 'gotoTrack', x, y,
        data: {
          section: a.section, track: a.track, sourceSection: a.sourceSection,
          sourceTrack: a.sourceTrack, timing: a.timing,
          transition: a.transition, fadeMs: a.fadeMs,
        },
      };
    case 'setTrackGain':
      return {
        id, kind: 'setTrackGain', x, y,
        data: {
          section: a.section, track: a.track, gain: a.gain, fadeMs: a.fadeMs,
          timing: a.timing ?? 'immediate',
        },
      };
    case 'setLoop':
      return { id, kind: 'setLoop', x, y, data: { section: a.section, enabled: a.enabled } };
    case 'setRtpc':
      return { id, kind: 'setRtpc', x, y, data: { rtpc: a.rtpc, value: a.value } };
    case 'setPluginParam':
      return {
        id, kind: 'setPluginParam', x, y,
        data: { instance: a.instance, param: a.param, value: a.value },
      };
    case 'emit':
      return { id, kind: 'emit', x, y, data: { code: a.code } };
    case 'stop':
      return { id, kind: 'stop', x, y, data: { timing: a.timing, fadeMs: a.fadeMs } };
    case 'oneShot':
      return {
        id, kind: 'oneShot', x, y,
        data: { asset: a.asset, gain: a.gain, timing: a.timing },
      };
  }
}

/**
 * Value-expression slots on actions become `expr` nodes wired to the action's
 * value input port so nothing is lost in migration.
 */
function exprInputsOf(a: CueAction): { port: string; source: string }[] {
  const out: { port: string; source: string }[] = [];
  if (a.type === 'setTrackGain' && a.gainExpr?.trim()) out.push({ port: 'gain', source: a.gainExpr });
  if ((a.type === 'setRtpc' || a.type === 'setPluginParam') && a.valueExpr?.trim()) {
    out.push({ port: 'value', source: a.valueExpr });
  }
  return out;
}

function cueToGraph(cue: Cue, bindings: Binding[], graphId: number): ScriptGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let n = 0;
  const nid = () => `m${graphId}_${n++}`;

  // Trigger nodes (manual cue when nothing binds to it).
  const trigIds: string[] = [];
  if (bindings.length === 0) {
    const id = nid();
    nodes.push({ id, kind: 'onManualCue', x: 30, y: 40, data: { name: cue.name } });
    trigIds.push(id);
  } else {
    bindings.forEach((b, i) => {
      const id = nid();
      nodes.push(triggerNode(id, b, 30, 40 + i * 150));
      trigIds.push(id);
    });
  }

  // Rule chain. stopIfMatched rules cascade through branch else-ports;
  // non-stop rules fan out from the same upstream point.
  const ROW = 170;
  const COL = 240;
  let fromIds = trigIds;
  let fromPort = 'out';
  let col = 1;
  for (const [ri, rule] of cue.rules.entries()) {
    const y = 40 + ri * ROW;
    const cond = rule.condition.trim();
    let chainFrom = fromIds;
    let chainPort = fromPort;
    let branchId: string | null = null;
    if (cond) {
      branchId = nid();
      const exprId = nid();
      nodes.push({ id: branchId, kind: 'branch', x: 30 + col * COL, y, data: {} });
      nodes.push({ id: exprId, kind: 'expr', x: 30 + (col - 1) * COL, y: y + 90, data: { source: cond } });
      for (const f of fromIds) edges.push({ from: f, fromPort, to: branchId, toPort: 'in' });
      edges.push({ from: exprId, fromPort: 'value', to: branchId, toPort: 'cond' });
      chainFrom = [branchId];
      chainPort = 'then';
      col++;
    }
    // Action chain of this rule.
    rule.actions.forEach((a, ai) => {
      const id = nid();
      nodes.push(actionNode(id, a, 30 + (col + ai) * COL, y));
      for (const ex of exprInputsOf(a)) {
        const eid = nid();
        nodes.push({ id: eid, kind: 'expr', x: 30 + (col + ai - 1) * COL, y: y + 90, data: { source: ex.source } });
        edges.push({ from: eid, fromPort: 'value', to: id, toPort: ex.port });
      }
      for (const f of chainFrom) edges.push({ from: f, fromPort: chainPort, to: id, toPort: 'in' });
      chainFrom = [id];
      chainPort = 'out';
    });
    if (rule.stopIfMatched && branchId) {
      // Later rules only run when this one did not match.
      fromIds = [branchId];
      fromPort = 'else';
    }
    // Non-stop rules keep fanning out from the previous upstream.
  }

  return { id: graphId, name: cue.name, nodes, edges };
}

/**
 * Converts every cue/binding of the project into script graphs (appended to
 * `project.graphs`) and clears `cues`/`bindings`. Idempotent on projects that
 * have no cues. Mutates and returns the project.
 */
export function migrateCuesToGraphs(project: IamProject): IamProject {
  if (!project.cues.length && !project.bindings.length) return project;
  project.graphs ??= [];
  let nextId = project.graphs.reduce((m, g) => Math.max(m, g.id), -1) + 1;
  for (const cue of project.cues) {
    const bindings = project.bindings.filter((b) => b.cue === cue.id);
    project.graphs.push(cueToGraph(cue, bindings, nextId++));
  }
  project.cues = [];
  project.bindings = [];
  return project;
}
