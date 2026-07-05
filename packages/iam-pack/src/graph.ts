/**
 * Script-graph compiler: turns the visual node graphs (authoring model, kept
 * in META) into ordinary cues + bindings, so the distribution format remains
 * plain Cue VM bytecode — safe, engine-compatible and statically analyzable.
 *
 * Compilation model:
 * - Each trigger node becomes one generated Cue plus (except onManualCue) one
 *   Binding. Generated cue ids start at GRAPH_CUE_ID_BASE to avoid collisions
 *   with hand-authored cues.
 * - The exec chain from a trigger is flattened into CueRules in flow order.
 *   A `branch` node closes the current rule and emits the then/else chains as
 *   subsequent rules whose conditions are the conjunction of all branch
 *   conditions on the path (else = negation).
 * - Value/logic subgraphs are synthesized into expression *source strings*
 *   and compiled with the existing expression compiler, either as rule
 *   conditions or as the dynamic value slots of v3 actions.
 */

import {
  Binding,
  BindingTrigger,
  Cue,
  CueAction,
  CueRule,
  GraphNode,
  IamProject,
  ScriptGraph,
  TimingName,
  TransitionName,
} from './model.js';

/** Generated cue ids live above this base; keep hand-authored ids below. */
export const GRAPH_CUE_ID_BASE = 0x4000_0000;

export class GraphError extends Error {
  constructor(
    message: string,
    public graphId?: number,
    public nodeId?: string,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

interface Segment {
  condition: string;
  actions: CueAction[];
}

class GraphCtx {
  private byId = new Map<string, GraphNode>();
  private execOut = new Map<string, string[]>(); // "node:port" -> target node ids (edge order)
  private valueIn = new Map<string, string>(); // "node:port" -> source node id

  constructor(
    readonly graph: ScriptGraph,
    readonly project: IamProject,
  ) {
    for (const n of graph.nodes) {
      if (this.byId.has(n.id)) throw new GraphError(`duplicate node id '${n.id}'`, graph.id, n.id);
      this.byId.set(n.id, n);
    }
    for (const e of graph.edges) {
      if (!this.byId.has(e.from) || !this.byId.has(e.to)) continue; // dangling edges are ignored
      if (e.toPort === 'in') {
        const key = `${e.from}:${e.fromPort}`;
        const list = this.execOut.get(key) ?? [];
        list.push(e.to);
        this.execOut.set(key, list);
      } else {
        this.valueIn.set(`${e.to}:${e.toPort}`, e.from);
      }
    }
  }

  node(id: string): GraphNode {
    const n = this.byId.get(id);
    if (!n) throw new GraphError(`unknown node '${id}'`, this.graph.id, id);
    return n;
  }

  execTargets(nodeId: string, port: string): string[] {
    return this.execOut.get(`${nodeId}:${port}`) ?? [];
  }

  valueSource(nodeId: string, port: string): string | null {
    return this.valueIn.get(`${nodeId}:${port}`) ?? null;
  }

  // -- name lookups (the expression language works on names) ---------------

  rtpcName(id: unknown, node: GraphNode): string {
    const r = this.project.rtpcs.find((x) => x.id === id);
    if (!r) throw new GraphError(`node references missing RTPC ${id}`, this.graph.id, node.id);
    return r.name;
  }

  sectionName(id: unknown, node: GraphNode): string {
    const s = this.project.sections.find((x) => x.id === id);
    if (!s) throw new GraphError(`node references missing section ${id}`, this.graph.id, node.id);
    return s.name;
  }

  // -- expression synthesis -------------------------------------------------

  /** Expression source for the value produced by a node (recursive). */
  expr(nodeId: string, depth = 0): string {
    if (depth > 32) throw new GraphError('value graph too deep (cycle?)', this.graph.id, nodeId);
    const n = this.node(nodeId);
    const input = (port: string): string => {
      const src = this.valueSource(n.id, port);
      if (!src) throw new GraphError(`'${n.kind}' needs input '${port}'`, this.graph.id, n.id);
      return this.expr(src, depth + 1);
    };
    switch (n.kind) {
      case 'constant': {
        const v = Number(n.data.value ?? 0);
        if (!Number.isFinite(v)) throw new GraphError('constant is not a number', this.graph.id, n.id);
        return v < 0 ? `(0 - ${Math.abs(v)})` : String(v);
      }
      case 'rtpcValue':
        return this.rtpcName(n.data.rtpc, n);
      case 'sectionRef':
        return `'${this.sectionName(n.data.section, n)}'`;
      case 'currentSection':
        return 'section';
      case 'positionBeats':
        return 'beats';
      case 'random':
        return 'rand';
      case 'expr': {
        const src = String(n.data.source ?? '').trim();
        if (!src) throw new GraphError('expression node is empty', this.graph.id, n.id);
        return `(${src})`;
      }
      case 'math': {
        const op = String(n.data.op ?? '+');
        if (!['+', '-', '*', '/'].includes(op)) {
          throw new GraphError(`unknown math op '${op}'`, this.graph.id, n.id);
        }
        return `(${input('a')} ${op} ${input('b')})`;
      }
      case 'compare': {
        const op = String(n.data.op ?? '>=');
        if (!['<', '<=', '>', '>=', '==', '!='].includes(op)) {
          throw new GraphError(`unknown compare op '${op}'`, this.graph.id, n.id);
        }
        return `(${input('a')} ${op} ${input('b')})`;
      }
      case 'and':
        return `(${input('a')} && ${input('b')})`;
      case 'or':
        return `(${input('a')} || ${input('b')})`;
      case 'not':
        return `!(${input('a')})`;
      default:
        throw new GraphError(`node '${n.kind}' does not produce a value`, this.graph.id, n.id);
    }
  }

  /** Optional value-input expression for an action node port. */
  optionalExpr(node: GraphNode, port: string): string | undefined {
    const src = this.valueSource(node.id, port);
    return src ? this.expr(src) : undefined;
  }
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function idOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}

function timing(v: unknown): TimingName {
  const t = String(v ?? 'immediate');
  return (['immediate', 'nextBeat', 'nextBar', 'sectionEnd'] as const).includes(t as TimingName)
    ? (t as TimingName)
    : 'immediate';
}

function transition(v: unknown): TransitionName {
  return v === 'crossfade' ? 'crossfade' : 'cut';
}

/** Builds the CueAction for an action node (value inputs become exprs). */
function actionOf(ctx: GraphCtx, n: GraphNode): CueAction {
  const d = n.data;
  switch (n.kind) {
    case 'goto':
      return {
        type: 'goto',
        section: num(d.section),
        anchor: idOrNull(d.anchor),
        timing: timing(d.timing),
        transition: transition(d.transition),
        fadeMs: num(d.fadeMs),
        bridge: idOrNull(d.bridge),
      };
    case 'gotoRandom':
      return {
        type: 'gotoRandom',
        timing: timing(d.timing),
        transition: transition(d.transition),
        fadeMs: num(d.fadeMs),
        bridge: idOrNull(d.bridge),
        targets: Array.isArray(d.targets)
          ? d.targets.map((t: { section?: unknown; anchor?: unknown; weight?: unknown }) => ({
              section: num(t.section),
              anchor: idOrNull(t.anchor),
              weight: num(t.weight, 1),
            }))
          : [],
      };
    case 'gotoTrack':
      return {
        type: 'gotoTrack',
        section: num(d.section),
        track: num(d.track),
        sourceSection: idOrNull(d.sourceSection),
        sourceTrack: idOrNull(d.sourceTrack),
        timing: timing(d.timing),
        transition: transition(d.transition),
        fadeMs: num(d.fadeMs),
      };
    case 'setTrackGain':
      return {
        type: 'setTrackGain',
        section: num(d.section),
        track: num(d.track),
        gain: num(d.gain, 1),
        fadeMs: num(d.fadeMs),
        timing: timing(d.timing),
        gainExpr: ctx.optionalExpr(n, 'gain'),
      };
    case 'setLoop':
      return { type: 'setLoop', section: num(d.section), enabled: Boolean(d.enabled) };
    case 'setRtpc':
      return {
        type: 'setRtpc',
        rtpc: num(d.rtpc),
        value: num(d.value),
        valueExpr: ctx.optionalExpr(n, 'value'),
      };
    case 'setPluginParam':
      return {
        type: 'setPluginParam',
        instance: num(d.instance),
        param: num(d.param),
        value: num(d.value),
        valueExpr: ctx.optionalExpr(n, 'value'),
      };
    case 'emit':
      return { type: 'emit', code: num(d.code) };
    case 'stop':
      return { type: 'stop', timing: timing(d.timing), fadeMs: num(d.fadeMs) };
    case 'oneShot':
      return {
        type: 'oneShot',
        asset: num(d.asset),
        gain: num(d.gain, 1),
        timing: timing(d.timing),
      };
    default:
      throw new GraphError(`'${n.kind}' is not an action node`, ctx.graph.id, n.id);
  }
}

const TRIGGER_KINDS = new Set([
  'onModuleStart',
  'onRtpcChanged',
  'onBar',
  'onBeat',
  'onSectionStart',
  'onSectionEnd',
  'onAnchor',
  'onManualCue',
]);

function bindingOf(n: GraphNode): BindingTrigger | null {
  const d = n.data;
  switch (n.kind) {
    case 'onModuleStart':
      return { type: 'moduleStart' };
    case 'onRtpcChanged':
      return { type: 'rtpcChanged', rtpc: num(d.rtpc) };
    case 'onBar':
      return { type: 'bar', section: idOrNull(d.section) };
    case 'onBeat':
      return { type: 'beat', section: idOrNull(d.section) };
    case 'onSectionStart':
      return { type: 'sectionStart', section: idOrNull(d.section) };
    case 'onSectionEnd':
      return { type: 'sectionEnd', section: idOrNull(d.section) };
    case 'onAnchor':
      return { type: 'anchorReached', section: num(d.section), anchor: num(d.anchor) };
    case 'onManualCue':
      return null; // fired by the host via triggerCue(name)
    default:
      return null;
  }
}

const and = (a: string, b: string): string => (a ? `${a} && ${b}` : b);

/**
 * Flattens the exec chain starting at `nodeIds` into (condition, actions)
 * segments. Branch nodes fork the chain; every path keeps the conjunction of
 * the branch conditions it passed (negated on the else side).
 */
function flatten(ctx: GraphCtx, nodeIds: string[], cond: string, depth: number): Segment[] {
  if (depth > 64) {
    throw new GraphError('exec graph too deep (cycle?)', ctx.graph.id, nodeIds[0]);
  }
  const segments: Segment[] = [];
  // Appends segments, merging adjacent ones that share a condition so the
  // generated rule list stays small (order of actions is preserved).
  const emit = (segs: Segment[]) => {
    for (const s of segs) {
      const last = segments[segments.length - 1];
      if (last && last.condition === s.condition) last.actions.push(...s.actions);
      else segments.push({ condition: s.condition, actions: [...s.actions] });
    }
  };
  for (const id of nodeIds) {
    const n = ctx.node(id);
    if (n.kind === 'branch') {
      const condSrc = ctx.valueSource(n.id, 'cond');
      if (!condSrc) throw new GraphError(`'branch' needs input 'cond'`, ctx.graph.id, n.id);
      const c = ctx.expr(condSrc);
      const thenTargets = ctx.execTargets(n.id, 'then');
      const elseTargets = ctx.execTargets(n.id, 'else');
      if (thenTargets.length) emit(flatten(ctx, thenTargets, and(cond, c), depth + 1));
      if (elseTargets.length) emit(flatten(ctx, elseTargets, and(cond, `!${c}`), depth + 1));
      continue;
    }
    if (TRIGGER_KINDS.has(n.kind)) {
      throw new GraphError('a trigger cannot be inside an exec chain', ctx.graph.id, n.id);
    }
    emit([{ condition: cond, actions: [actionOf(ctx, n)] }]);
    const next = ctx.execTargets(n.id, 'out');
    if (next.length) emit(flatten(ctx, next, cond, depth + 1));
  }
  return segments;
}

export interface CompiledGraphs {
  cues: Cue[];
  bindings: Binding[];
}

/**
 * Compiles every enabled graph into generated cues/bindings. Throws
 * GraphError on structural problems; expression errors surface later through
 * encodePack's validation with the generated cue's name for context.
 */
export function compileGraphs(project: IamProject): CompiledGraphs {
  const cues: Cue[] = [];
  const bindings: Binding[] = [];
  let nextId = GRAPH_CUE_ID_BASE;
  for (const graph of project.graphs ?? []) {
    if (graph.enabled === false) continue;
    const ctx = new GraphCtx(graph, project);
    for (const n of graph.nodes) {
      if (!TRIGGER_KINDS.has(n.kind)) continue;
      const targets = ctx.execTargets(n.id, 'out');
      if (targets.length === 0) continue; // unwired trigger: nothing to do
      const segments = flatten(ctx, targets, '', 0);
      if (segments.length === 0) continue;
      const rules: CueRule[] = segments.map((s) => ({
        condition: s.condition,
        stopIfMatched: false,
        actions: s.actions,
      }));
      const name =
        n.kind === 'onManualCue' && typeof n.data.name === 'string' && n.data.name
          ? String(n.data.name)
          : `graph:${graph.name}:${n.id}`;
      const cue: Cue = { id: nextId++, name, rules };
      cues.push(cue);
      const trigger = bindingOf(n);
      if (trigger) bindings.push({ trigger, cue: cue.id });
    }
  }
  return { cues, bindings };
}

/**
 * Returns the project with graphs expanded into generated cues/bindings
 * (shallow copy; the input is untouched). Used by encodePack so exported
 * modules contain the compiled logic while META keeps only the graphs.
 */
export function projectWithCompiledGraphs(project: IamProject): IamProject {
  if (!project.graphs?.length) return project;
  const { cues, bindings } = compileGraphs(project);
  if (cues.length === 0) return project;
  return {
    ...project,
    cues: [...project.cues, ...cues],
    bindings: [...project.bindings, ...bindings],
  };
}

/** Validates all graphs, returning human-readable issues (empty = ok). */
export function checkGraphs(project: IamProject): string[] {
  try {
    compileGraphs(project);
    return [];
  } catch (e) {
    if (e instanceof GraphError) {
      const where = e.nodeId ? ` (node ${e.nodeId})` : '';
      return [`Graph ${e.graphId ?? '?'}${where}: ${e.message}`];
    }
    return [String(e)];
  }
}
