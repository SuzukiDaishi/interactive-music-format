/**
 * Pure routing computation for the WCLAP rack: given a decoded project, work out
 * which plugin instances are needed, whether each is an instrument (no audio
 * input) or an effect (one audio input), and the instrument/master routing.
 *
 * IO (fetching/decompressing bundles, compiling wasm) lives in the player; this
 * stays side-effect free so it can be unit tested.
 */

import type { IamProject } from '@iam/pack';
import type { RackRouting } from './rack.js';

export interface RackInstancePlan {
  instanceId: number;
  pluginBankId: number;
  clapPluginId?: string;
  params: { id: number; value: number }[];
  audioInputs: 0 | 1;
}

export interface RackPlan {
  instances: RackInstancePlan[];
  routing: RackRouting;
}

/** Returns a rack plan, or null when the project uses no plugins. */
export function planRack(project: IamProject): RackPlan | null {
  const instancesById = new Map((project.pluginInstances ?? []).map((p) => [p.id, p]));
  const instrumentIds = new Set<number>();
  const used = new Set<number>();
  const instruments: { instanceId: number; effects: number[] }[] = [];

  for (const section of project.sections) {
    for (const track of section.tracks) {
      if (track.kind !== 'instrument' || track.instrument == null) continue;
      const effects = (track.effects ?? []).filter((id) => instancesById.has(id));
      instrumentIds.add(track.instrument);
      used.add(track.instrument);
      effects.forEach((id) => used.add(id));
      // Dedupe instrument instances reused across sections.
      if (!instruments.some((i) => i.instanceId === track.instrument)) {
        instruments.push({ instanceId: track.instrument, effects });
      }
    }
  }

  const masterEffects = (project.masterEffects ?? []).filter((id) => instancesById.has(id));
  masterEffects.forEach((id) => used.add(id));

  // Note-generator routings (v3): both ends are audio-input-less plugins. A
  // target that no track references directly is added to the instrument sum so
  // its (note-driven) audio is heard.
  const noteSources = (project.noteSources ?? []).filter(
    (s) => instancesById.has(s.generator) && instancesById.has(s.target),
  );
  for (const s of noteSources) {
    instrumentIds.add(s.generator);
    instrumentIds.add(s.target);
    used.add(s.generator);
    used.add(s.target);
    if (!instruments.some((i) => i.instanceId === s.target)) {
      instruments.push({ instanceId: s.target, effects: [] });
    }
  }

  // RTPC -> parameter modulations (v3), kept only for instances in the graph.
  const paramMods = (project.paramMods ?? []).filter((m) => used.has(m.instance));

  if (used.size === 0) return null;

  const instancePlans: RackInstancePlan[] = [];
  for (const id of used) {
    const inst = instancesById.get(id);
    if (!inst) continue;
    instancePlans.push({
      instanceId: id,
      pluginBankId: inst.pluginBankId,
      clapPluginId: inst.clapPluginId,
      params: inst.params ?? [],
      audioInputs: instrumentIds.has(id) ? 0 : 1,
    });
  }

  return {
    instances: instancePlans,
    routing: { instruments, masterEffects, noteSources, paramMods },
  };
}
