/**
 * Project merge: imports another project's sections/assets/plugins/logic into
 * a destination project so "transition one track to another project's audio"
 * works inside a single self-contained .iam.wasm.
 *
 * Every id space of the source is remapped onto free ids of the destination.
 * RTPCs merge **by name** (a source RTPC named like an existing destination
 * RTPC reuses it — game state stays unified); everything else always gets new
 * ids. Section names are de-duplicated with a suffix.
 */

import {
  Binding,
  BlendCurve,
  Cue,
  CueAction,
  GraphNode,
  IamProject,
  NoteSource,
  ParamMod,
  ScriptGraph,
  Section,
} from './model.js';

export interface MergeResult {
  /** The destination project (mutated in place and returned). */
  project: IamProject;
  /** Source asset id -> merged asset id (callers move sample data along). */
  assetIdMap: Map<number, number>;
  /** Source plugin bank id -> merged id (callers move bundle bytes along). */
  pluginIdMap: Map<number, number>;
  sectionIdMap: Map<number, number>;
  instanceIdMap: Map<number, number>;
}

function nextIdAfter(ids: number[]): number {
  let max = -1;
  for (const id of ids) if (id > max && id < 0x4000_0000) max = id;
  return max + 1;
}

function remapper(ids: number[], srcIds: number[]): Map<number, number> {
  let next = nextIdAfter(ids);
  const map = new Map<number, number>();
  for (const id of srcIds) map.set(id, next++);
  return map;
}

const mapped = (map: Map<number, number>, id: number): number => map.get(id) ?? id;

function mappedOrNull(map: Map<number, number>, id: number | null | undefined): number | null {
  if (id === null || id === undefined) return null;
  return map.get(id) ?? id;
}

/** Merges `src` into `dst` (deep-copies everything taken from src). */
export function mergeProjects(dst: IamProject, src: IamProject): MergeResult {
  src = JSON.parse(JSON.stringify(src)) as IamProject;

  // RTPCs: merge by name, remap the rest.
  const rtpcIdMap = new Map<number, number>();
  {
    let next = nextIdAfter(dst.rtpcs.map((r) => r.id));
    for (const r of src.rtpcs ?? []) {
      const existing = dst.rtpcs.find((x) => x.name === r.name);
      if (existing) {
        rtpcIdMap.set(r.id, existing.id);
      } else {
        rtpcIdMap.set(r.id, next);
        dst.rtpcs.push({ ...r, id: next });
        next++;
      }
    }
  }

  const assetIdMap = remapper(
    dst.assets.map((a) => a.id),
    (src.assets ?? []).map((a) => a.id),
  );
  const sectionIdMap = remapper(
    dst.sections.map((s) => s.id),
    (src.sections ?? []).map((s) => s.id),
  );
  // Plugins: reuse a destination bank plugin with the same CLAP plugin id.
  const pluginIdMap = new Map<number, number>();
  {
    let next = nextIdAfter((dst.plugins ?? []).map((p) => p.id));
    for (const p of src.plugins ?? []) {
      const existing = (dst.plugins ?? []).find(
        (x) => x.clapPluginId && x.clapPluginId === p.clapPluginId,
      );
      if (existing) {
        pluginIdMap.set(p.id, existing.id);
      } else {
        pluginIdMap.set(p.id, next);
        dst.plugins.push({ ...p, id: next });
        next++;
      }
    }
  }
  const instanceIdMap = remapper(
    (dst.pluginInstances ?? []).map((i) => i.id),
    (src.pluginInstances ?? []).map((i) => i.id),
  );
  const cueIdMap = remapper(
    dst.cues.map((c) => c.id),
    (src.cues ?? []).map((c) => c.id),
  );
  const graphIdMap = remapper(
    (dst.graphs ?? []).map((g) => g.id),
    (src.graphs ?? []).map((g) => g.id),
  );

  for (const a of src.assets ?? []) {
    dst.assets.push({ ...a, id: mapped(assetIdMap, a.id) });
  }
  for (const inst of src.pluginInstances ?? []) {
    dst.pluginInstances.push({
      ...inst,
      id: mapped(instanceIdMap, inst.id),
      pluginBankId: mapped(pluginIdMap, inst.pluginBankId),
    });
  }

  const usedNames = new Set(dst.sections.map((s) => s.name));
  const uniqueName = (name: string): string => {
    if (!usedNames.has(name)) {
      usedNames.add(name);
      return name;
    }
    for (let i = 2; ; i++) {
      const candidate = `${name} (${i})`;
      if (!usedNames.has(candidate)) {
        usedNames.add(candidate);
        return candidate;
      }
    }
  };

  for (const s of src.sections ?? []) {
    const section: Section = {
      ...s,
      id: mapped(sectionIdMap, s.id),
      name: uniqueName(s.name),
      tracks: s.tracks.map((t) => ({
        ...t,
        items: t.items.map((it) => ({ ...it, assetId: mapped(assetIdMap, it.assetId) })),
        instrument:
          t.instrument === null || t.instrument === undefined
            ? t.instrument
            : mapped(instanceIdMap, t.instrument),
        effects: (t.effects ?? []).map((e) => mapped(instanceIdMap, e)),
      })),
    };
    dst.sections.push(section);
  }

  const remapAction = (a: CueAction): CueAction => {
    switch (a.type) {
      case 'goto':
        return {
          ...a,
          section: mapped(sectionIdMap, a.section),
          bridge: mappedOrNull(sectionIdMap, a.bridge),
        };
      case 'gotoRandom':
        return {
          ...a,
          bridge: mappedOrNull(sectionIdMap, a.bridge),
          targets: a.targets.map((t) => ({ ...t, section: mapped(sectionIdMap, t.section) })),
        };
      case 'play':
        return { ...a, section: mapped(sectionIdMap, a.section) };
      case 'gotoTrack':
        return {
          ...a,
          section: mapped(sectionIdMap, a.section),
          sourceSection: mappedOrNull(sectionIdMap, a.sourceSection),
        };
      case 'setTrackGain':
      case 'setLoop':
        return { ...a, section: mapped(sectionIdMap, a.section) };
      case 'setRtpc':
        return { ...a, rtpc: mapped(rtpcIdMap, a.rtpc) };
      case 'setPluginParam':
        return { ...a, instance: mapped(instanceIdMap, a.instance) };
      case 'oneShot':
        return { ...a, asset: mapped(assetIdMap, a.asset) };
      case 'stop':
      case 'emit':
        return { ...a };
    }
  };

  for (const c of src.cues ?? []) {
    const cue: Cue = {
      ...c,
      id: mapped(cueIdMap, c.id),
      rules: c.rules.map((r) => ({ ...r, actions: r.actions.map(remapAction) })),
    };
    dst.cues.push(cue);
  }

  for (const b of src.bindings ?? []) {
    const t = b.trigger;
    const trigger: Binding['trigger'] =
      t.type === 'rtpcChanged'
        ? { ...t, rtpc: mapped(rtpcIdMap, t.rtpc) }
        : t.type === 'anchorReached'
          ? { ...t, section: mapped(sectionIdMap, t.section) }
          : t.type === 'moduleStart'
            ? t
            : { ...t, section: mappedOrNull(sectionIdMap, t.section) };
    dst.bindings.push({ trigger, cue: mapped(cueIdMap, b.cue) });
  }

  for (const bl of src.blends ?? []) {
    const blend: BlendCurve = {
      ...bl,
      id: nextIdAfter((dst.blends ?? []).map((x) => x.id)),
      rtpc: mapped(rtpcIdMap, bl.rtpc),
      section: mapped(sectionIdMap, bl.section),
    };
    (dst.blends ??= []).push(blend);
  }
  for (const m of src.paramMods ?? []) {
    const mod: ParamMod = {
      ...m,
      instance: mapped(instanceIdMap, m.instance),
      rtpc: mapped(rtpcIdMap, m.rtpc),
    };
    (dst.paramMods ??= []).push(mod);
  }
  for (const ns of src.noteSources ?? []) {
    const source: NoteSource = {
      generator: mapped(instanceIdMap, ns.generator),
      target: mapped(instanceIdMap, ns.target),
    };
    (dst.noteSources ??= []).push(source);
  }

  // Graph node data references entities by id under well-known keys.
  const remapNodeData = (n: GraphNode): GraphNode => {
    const d = { ...n.data };
    const remapKey = (key: string, map: Map<number, number>) => {
      if (typeof d[key] === 'number') d[key] = mapped(map, d[key] as number);
    };
    remapKey('rtpc', rtpcIdMap);
    remapKey('section', sectionIdMap);
    remapKey('sourceSection', sectionIdMap);
    remapKey('bridge', sectionIdMap);
    remapKey('instance', instanceIdMap);
    remapKey('asset', assetIdMap);
    if (Array.isArray(d.targets)) {
      d.targets = (d.targets as { section?: number }[]).map((t) =>
        typeof t.section === 'number' ? { ...t, section: mapped(sectionIdMap, t.section) } : t,
      );
    }
    return { ...n, data: d };
  };
  for (const g of src.graphs ?? []) {
    const graph: ScriptGraph = {
      ...g,
      id: mapped(graphIdMap, g.id),
      nodes: g.nodes.map(remapNodeData),
    };
    (dst.graphs ??= []).push(graph);
  }

  return { project: dst, assetIdMap, pluginIdMap, sectionIdMap, instanceIdMap };
}
