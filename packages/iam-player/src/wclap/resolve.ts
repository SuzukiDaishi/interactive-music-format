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

  return { instances: instancePlans, routing: { instruments, masterEffects } };
}
