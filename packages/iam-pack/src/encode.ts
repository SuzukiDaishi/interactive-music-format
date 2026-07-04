/**
 * IAMP v1 binary encoder. The byte layout is normatively described in
 * docs/02_iam_pack_spec.md and must stay in sync with engine/src/pack.rs.
 */

import {
  EncodeAsset,
  EncodePlugin,
  IamProject,
  NONE_ID,
  PACK_MAGIC,
  PACK_VERSION,
  RTPC_TYPE_CODE,
  TIMING_CODE,
  CueAction,
} from './model.js';
import { compileExpression, compileValueExpression } from './expr.js';

class Writer {
  private buf = new Uint8Array(1024);
  private len = 0;

  private ensure(n: number) {
    if (this.len + n > this.buf.length) {
      const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
  }

  u8(v: number) {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }

  u16(v: number) {
    this.ensure(2);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
  }

  u32(v: number) {
    this.ensure(4);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 24) & 0xff;
  }

  f32(v: number) {
    this.ensure(4);
    new DataView(this.buf.buffer).setFloat32(this.len, v, true);
    this.len += 4;
  }

  bytes(b: Uint8Array) {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  str(s: string) {
    const b = new TextEncoder().encode(s);
    if (b.length > 0xffff) throw new Error(`String too long: ${s.slice(0, 32)}…`);
    this.u16(b.length);
    this.bytes(b);
  }

  pad4() {
    while (this.len % 4 !== 0) this.u8(0);
  }

  get length() {
    return this.len;
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

function idOrNone(v: number | null): number {
  return v === null ? NONE_ID : v >>> 0;
}

export class ValidationError extends Error {
  constructor(public issues: string[]) {
    super(issues.join('\n'));
    this.name = 'ValidationError';
  }
}

/** Structural validation; returns a list of human-readable issues. */
export function validateProject(
  project: IamProject,
  assets: EncodeAsset[],
  plugins: EncodePlugin[] = [],
): string[] {
  const issues: string[] = [];
  const secIds = new Set(project.sections.map((s) => s.id));
  const assetIds = new Set(assets.map((a) => a.id));
  const cueIds = new Set(project.cues.map((c) => c.id));
  const rtpcIds = new Set(project.rtpcs.map((r) => r.id));
  const projPlugins = project.plugins ?? [];
  const projInstances = project.pluginInstances ?? [];
  const projMasterEffects = project.masterEffects ?? [];
  const pluginIds = new Set(projPlugins.map((p) => p.id));
  const instanceIds = new Set(projInstances.map((p) => p.id));
  const embeddedBin = new Set(plugins.filter((p) => p.data).map((p) => p.id));

  const dupCheck = (label: string, ids: number[]) => {
    const seen = new Set<number>();
    for (const id of ids) {
      if (seen.has(id)) issues.push(`${label}: duplicate id ${id}`);
      seen.add(id);
    }
  };
  dupCheck('sections', project.sections.map((s) => s.id));
  dupCheck('rtpcs', project.rtpcs.map((r) => r.id));
  dupCheck('cues', project.cues.map((c) => c.id));
  dupCheck('assets', assets.map((a) => a.id));
  dupCheck('plugins', projPlugins.map((p) => p.id));
  dupCheck('pluginInstances', projInstances.map((p) => p.id));

  for (const p of projPlugins) {
    if (p.embedded && !embeddedBin.has(p.id) && !p.url) {
      issues.push(`Plugin '${p.name}': marked embedded but no binary data supplied`);
    }
    if (!p.embedded && !p.url) {
      issues.push(`Plugin '${p.name}': not embedded and has no url`);
    }
  }
  for (const inst of projInstances) {
    if (!pluginIds.has(inst.pluginBankId)) {
      issues.push(`PluginInstance ${inst.id}: references missing plugin ${inst.pluginBankId}`);
    }
  }
  for (const e of projMasterEffects) {
    if (!instanceIds.has(e)) issues.push(`masterEffects: instance ${e} does not exist`);
  }

  const names = new Set<string>();
  for (const s of project.sections) {
    if (names.has(s.name)) issues.push(`Section name '${s.name}' is duplicated`);
    names.add(s.name);
    if (!(s.lengthBeats > 0)) issues.push(`Section '${s.name}': lengthBeats must be > 0`);
    for (const t of s.tracks) {
      const where = `Section '${s.name}' track '${t.name}'`;
      if (t.kind === 'instrument') {
        if (t.instrument == null || !instanceIds.has(t.instrument)) {
          issues.push(`${where}: instrument track must reference an existing plugin instance`);
        }
        if (t.items.length > 0) issues.push(`${where}: instrument track must not have audio items`);
        for (const n of t.notes ?? []) {
          if (!(n.key >= 0 && n.key <= 127)) issues.push(`${where}: note key ${n.key} out of range 0..127`);
          if (!(n.velocity >= 0 && n.velocity <= 1)) issues.push(`${where}: note velocity ${n.velocity} out of range 0..1`);
          if (!(n.lengthBeats > 0)) issues.push(`${where}: note lengthBeats must be > 0`);
        }
      } else {
        for (const it of t.items) {
          if (!assetIds.has(it.assetId)) {
            issues.push(`${where}: item references missing asset ${it.assetId}`);
          }
        }
      }
      for (const e of t.effects ?? []) {
        if (!instanceIds.has(e)) issues.push(`${where}: effect instance ${e} does not exist`);
      }
    }
  }
  if (project.startSectionId !== null && !secIds.has(project.startSectionId)) {
    issues.push(`startSectionId ${project.startSectionId} does not exist`);
  }

  const checkSecRef = (where: string, id: number | null) => {
    if (id !== null && !secIds.has(id)) issues.push(`${where}: section ${id} does not exist`);
  };
  const checkAnchorRef = (where: string, section: number, anchor: number | null) => {
    if (anchor === null) return;
    const sec = project.sections.find((s) => s.id === section);
    if (sec && !sec.anchors.some((a) => a.id === anchor)) {
      issues.push(`${where}: anchor ${anchor} not found in section '${sec.name}'`);
    }
  };
  const checkValueExpr = (where: string, src: string | undefined) => {
    if (src === undefined || !src.trim()) return;
    try {
      compileValueExpression(src, project);
    } catch (e) {
      issues.push(`${where}: value expression: ${(e as Error).message}`);
    }
  };
  const checkCurve = (where: string, points: { x: number; y: number }[]) => {
    if (points.length === 0) issues.push(`${where}: curve needs at least one point`);
    for (let i = 1; i < points.length; i++) {
      if (!(points[i].x >= points[i - 1].x)) {
        issues.push(`${where}: curve x values must be ascending`);
        break;
      }
    }
  };

  for (const b of project.blends ?? []) {
    const where = `Blend ${b.id}`;
    if (!rtpcIds.has(b.rtpc)) issues.push(`${where}: RTPC ${b.rtpc} does not exist`);
    const sec = project.sections.find((s) => s.id === b.section);
    if (!sec) issues.push(`${where}: section ${b.section} does not exist`);
    else if (!sec.tracks.some((t) => t.id === b.track)) {
      issues.push(`${where}: track ${b.track} not in section '${sec.name}'`);
    }
    checkCurve(where, b.points);
  }
  dupCheck('blends', (project.blends ?? []).map((b) => b.id));
  for (const [mi, m] of (project.paramMods ?? []).entries()) {
    const where = `ParamMod ${mi + 1}`;
    if (!instanceIds.has(m.instance)) issues.push(`${where}: plugin instance ${m.instance} does not exist`);
    if (!rtpcIds.has(m.rtpc)) issues.push(`${where}: RTPC ${m.rtpc} does not exist`);
    checkCurve(where, m.points);
  }
  for (const [si, s] of (project.noteSources ?? []).entries()) {
    const where = `NoteSource ${si + 1}`;
    if (!instanceIds.has(s.generator)) issues.push(`${where}: generator instance ${s.generator} does not exist`);
    if (!instanceIds.has(s.target)) issues.push(`${where}: target instance ${s.target} does not exist`);
    if (s.generator === s.target) issues.push(`${where}: generator and target must differ`);
  }

  for (const c of project.cues) {
    for (const [ri, rule] of c.rules.entries()) {
      try {
        compileExpression(rule.condition, project);
      } catch (e) {
        issues.push(`Cue '${c.name}' rule ${ri + 1}: ${(e as Error).message}`);
      }
      for (const a of rule.actions) {
        const where = `Cue '${c.name}' rule ${ri + 1}`;
        switch (a.type) {
          case 'goto':
            checkSecRef(where, a.section);
            checkAnchorRef(where, a.section, a.anchor);
            if (a.bridge != null) checkSecRef(`${where} (bridge)`, a.bridge);
            break;
          case 'play':
            checkSecRef(where, a.section);
            checkAnchorRef(where, a.section, a.anchor);
            break;
          case 'gotoRandom':
            if (a.targets.length === 0) issues.push(`${where}: gotoRandom needs targets`);
            for (const t of a.targets) {
              checkSecRef(where, t.section);
              checkAnchorRef(where, t.section, t.anchor);
            }
            if (a.bridge != null) checkSecRef(`${where} (bridge)`, a.bridge);
            break;
          case 'setTrackGain': {
            checkSecRef(where, a.section);
            const sec = project.sections.find((s) => s.id === a.section);
            if (sec && !sec.tracks.some((t) => t.id === a.track)) {
              issues.push(`${where}: track ${a.track} not in section '${sec.name}'`);
            }
            checkValueExpr(where, a.gainExpr);
            break;
          }
          case 'gotoTrack': {
            checkSecRef(where, a.section);
            const dest = project.sections.find((s) => s.id === a.section);
            if (dest && !dest.tracks.some((t) => t.id === a.track)) {
              issues.push(`${where}: track ${a.track} not in section '${dest.name}'`);
            }
            if (a.sourceSection !== null) {
              checkSecRef(`${where} (source)`, a.sourceSection);
              const src = project.sections.find((s) => s.id === a.sourceSection);
              if (src && !src.tracks.some((t) => t.id === a.sourceTrack)) {
                issues.push(`${where}: source track ${a.sourceTrack} not in section '${src.name}'`);
              }
              const dt = dest?.tracks.find((t) => t.id === a.track);
              const st = src?.tracks.find((t) => t.id === a.sourceTrack);
              if (dt && st && (dt.kind ?? 'audio') !== (st.kind ?? 'audio')) {
                issues.push(`${where}: gotoTrack source/destination track kinds differ`);
              }
            }
            break;
          }
          case 'setPluginParam':
            if (!instanceIds.has(a.instance)) {
              issues.push(`${where}: plugin instance ${a.instance} does not exist`);
            }
            checkValueExpr(where, a.valueExpr);
            break;
          case 'setLoop':
            checkSecRef(where, a.section);
            break;
          case 'setRtpc':
            if (!rtpcIds.has(a.rtpc)) issues.push(`${where}: RTPC ${a.rtpc} does not exist`);
            checkValueExpr(where, a.valueExpr);
            break;
          case 'oneShot':
            if (!assetIds.has(a.asset)) issues.push(`${where}: asset ${a.asset} does not exist`);
            break;
          case 'stop':
          case 'emit':
            break;
        }
      }
    }
  }

  for (const [bi, b] of project.bindings.entries()) {
    const where = `Binding ${bi + 1}`;
    if (!cueIds.has(b.cue)) issues.push(`${where}: cue ${b.cue} does not exist`);
    const t = b.trigger;
    switch (t.type) {
      case 'rtpcChanged':
        if (!rtpcIds.has(t.rtpc)) issues.push(`${where}: RTPC ${t.rtpc} does not exist`);
        break;
      case 'sectionStart':
      case 'sectionEnd':
      case 'bar':
      case 'beat':
        checkSecRef(where, t.section);
        break;
      case 'anchorReached':
        checkSecRef(where, t.section);
        checkAnchorRef(where, t.section, t.anchor);
        break;
      case 'moduleStart':
        break;
    }
  }

  for (const a of assets) {
    const expected = a.frames * a.channels;
    if (a.data.length !== expected) {
      issues.push(`Asset '${a.name}': data length ${a.data.length} != frames*channels ${expected}`);
    }
    if (a.format === 'pcm16' && !(a.data instanceof Int16Array)) {
      issues.push(`Asset '${a.name}': pcm16 requires Int16Array data`);
    }
    if (a.format === 'f32' && !(a.data instanceof Float32Array)) {
      issues.push(`Asset '${a.name}': f32 requires Float32Array data`);
    }
  }

  return issues;
}

function writeAction(w: Writer, a: CueAction, project: IamProject) {
  const valueExpr = (src: string | undefined): Uint8Array =>
    src && src.trim() ? compileValueExpression(src, project) : new Uint8Array(0);
  switch (a.type) {
    case 'goto':
      w.u8(0x01);
      w.u32(a.section);
      w.u32(idOrNone(a.anchor));
      w.u8(TIMING_CODE[a.timing]);
      w.u8(a.transition === 'crossfade' ? 1 : 0);
      w.u16(0);
      w.f32(a.fadeMs);
      w.u32(idOrNone(a.bridge ?? null));
      break;
    case 'play':
      w.u8(0x02);
      w.u32(a.section);
      w.u32(idOrNone(a.anchor));
      break;
    case 'stop':
      w.u8(0x03);
      w.u8(TIMING_CODE[a.timing]);
      w.u8(0);
      w.u8(0);
      w.u8(0);
      w.f32(a.fadeMs);
      break;
    case 'setTrackGain': {
      const expr = valueExpr(a.gainExpr);
      const timing = a.timing ?? 'immediate';
      if (timing === 'immediate' && expr.length === 0) {
        // v2-compatible opcode for the plain immediate form.
        w.u8(0x04);
        w.u32(a.section);
        w.u32(a.track);
        w.f32(a.gain);
        w.f32(a.fadeMs);
      } else {
        w.u8(0x0a);
        w.u32(a.section);
        w.u32(a.track);
        w.f32(a.gain);
        w.f32(a.fadeMs);
        w.u8(TIMING_CODE[timing]);
        w.u8(0);
        w.u16(expr.length);
        w.bytes(expr);
      }
      break;
    }
    case 'gotoTrack':
      w.u8(0x0b);
      w.u32(a.section);
      w.u32(a.track);
      w.u32(idOrNone(a.sourceSection));
      w.u32(a.sourceSection === null ? NONE_ID : idOrNone(a.sourceTrack));
      w.u8(TIMING_CODE[a.timing]);
      w.u8(a.transition === 'crossfade' ? 1 : 0);
      w.u16(0);
      w.f32(a.fadeMs);
      break;
    case 'setPluginParam': {
      const expr = valueExpr(a.valueExpr);
      w.u8(0x0c);
      w.u32(a.instance);
      w.u32(a.param);
      w.f32(a.value);
      w.u16(expr.length);
      w.u16(0);
      w.bytes(expr);
      break;
    }
    case 'setLoop':
      w.u8(0x05);
      w.u32(a.section);
      w.u8(a.enabled ? 1 : 0);
      w.u8(0);
      w.u8(0);
      w.u8(0);
      break;
    case 'emit':
      w.u8(0x06);
      w.u32(a.code);
      break;
    case 'setRtpc': {
      const expr = valueExpr(a.valueExpr);
      if (expr.length === 0) {
        w.u8(0x07);
        w.u32(a.rtpc);
        w.f32(a.value);
      } else {
        w.u8(0x0d);
        w.u32(a.rtpc);
        w.f32(a.value);
        w.u16(expr.length);
        w.u16(0);
        w.bytes(expr);
      }
      break;
    }
    case 'oneShot':
      w.u8(0x08);
      w.u32(a.asset);
      w.f32(a.gain);
      w.u8(TIMING_CODE[a.timing]);
      w.u8(0);
      w.u8(0);
      w.u8(0);
      break;
    case 'gotoRandom':
      w.u8(0x09);
      w.u8(a.targets.length);
      w.u8(TIMING_CODE[a.timing]);
      w.u8(a.transition === 'crossfade' ? 1 : 0);
      w.u8(0);
      w.f32(a.fadeMs);
      w.u32(idOrNone(a.bridge ?? null));
      for (const t of a.targets) {
        w.u32(t.section);
        w.u32(idOrNone(t.anchor));
        w.f32(t.weight);
      }
      break;
  }
}

const TRIGGER_CODE: Record<string, number> = {
  rtpcChanged: 1,
  sectionStart: 2,
  sectionEnd: 3,
  anchorReached: 4,
  bar: 5,
  beat: 6,
  moduleStart: 7,
};

export interface EncodeOptions {
  /**
   * Embed the project JSON as a META chunk so the resulting module can be
   * re-imported into the DAW. Default true.
   */
  includeMeta?: boolean;
}

/** Encodes a project + audio assets (+ optional WCLAP binaries) into IAMP bytes. */
export function encodePack(
  project: IamProject,
  assets: EncodeAsset[],
  options: EncodeOptions = {},
  plugins: EncodePlugin[] = [],
): Uint8Array {
  const issues = validateProject(project, assets, plugins);
  if (issues.length > 0) throw new ValidationError(issues);

  const includeMeta = options.includeMeta !== false;
  const chunks: { id: string; body: Uint8Array }[] = [];

  // PROJ
  {
    const w = new Writer();
    w.str(project.name);
    w.u32(project.bankSampleRate);
    w.f32(project.bpm);
    w.u8(project.timeSignature[0]);
    w.u8(project.timeSignature[1]);
    w.u16(0);
    w.u32(idOrNone(project.startSectionId));
    chunks.push({ id: 'PROJ', body: w.result() });
  }

  // RTPC
  {
    const w = new Writer();
    w.u32(project.rtpcs.length);
    for (const r of project.rtpcs) {
      w.u32(r.id);
      w.str(r.name);
      w.u8(RTPC_TYPE_CODE[r.type]);
      w.u8(0);
      const variants = r.type === 'enum' ? r.variants ?? [] : [];
      w.u16(variants.length);
      for (const v of variants) w.str(v);
      w.f32(r.default);
      w.f32(r.min);
      w.f32(r.max);
      w.f32(r.smoothingMs);
    }
    chunks.push({ id: 'RTPC', body: w.result() });
  }

  // SECT
  {
    const w = new Writer();
    w.u32(project.sections.length);
    for (const s of project.sections) {
      w.u32(s.id);
      w.str(s.name);
      w.f32(s.bpm);
      w.u8(s.timeSignature[0]);
      w.u8(s.timeSignature[1]);
      w.u8(s.loopEnabled ? 1 : 0);
      w.u8(0);
      w.f32(s.lengthBeats);
      w.f32(s.loopStartBeats);
      w.u32(s.tracks.length);
      for (const t of s.tracks) {
        w.u32(t.id);
        w.str(t.name);
        w.f32(t.volume);
        w.f32(t.pan);
        w.u8(t.muted ? 1 : 0);
        w.u8(t.kind === 'instrument' ? 1 : 0);
        w.u8(0);
        w.u8(0);
        w.u32(idOrNone(t.instrument ?? null));
        const effects = t.effects ?? [];
        w.u16(effects.length);
        for (const e of effects) w.u32(e);
        w.u32(t.items.length);
        for (const it of t.items) {
          w.u32(it.id);
          w.u32(it.assetId);
          w.f32(it.startBeat);
          w.f32(it.lengthBeats);
          w.f32(it.offsetBeats);
          w.f32(it.gain);
          w.f32(it.fadeInBeats);
          w.f32(it.fadeOutBeats);
        }
        const notes = t.notes ?? [];
        w.u32(notes.length);
        for (const n of notes) {
          w.f32(n.startBeat);
          w.f32(n.lengthBeats);
          w.u8(n.key & 0x7f);
          w.u8(n.channel & 0x0f);
          w.u16(0);
          w.f32(n.velocity);
        }
      }
      w.u32(s.anchors.length);
      for (const a of s.anchors) {
        w.u32(a.id);
        w.str(a.name);
        w.f32(a.beat);
      }
    }
    chunks.push({ id: 'SECT', body: w.result() });
  }

  // CUES
  {
    const w = new Writer();
    w.u32(project.cues.length);
    for (const c of project.cues) {
      w.u32(c.id);
      w.str(c.name);
      w.u32(c.rules.length);
      for (const r of c.rules) {
        const bytecode = compileExpression(r.condition, project);
        w.u16(bytecode.length);
        w.bytes(bytecode);
        w.u8(r.actions.length);
        w.u8(r.stopIfMatched ? 1 : 0);
        for (const a of r.actions) writeAction(w, a, project);
      }
    }
    w.u32(project.bindings.length);
    for (const b of project.bindings) {
      w.u8(TRIGGER_CODE[b.trigger.type]);
      w.u8(0);
      w.u8(0);
      w.u8(0);
      const t = b.trigger;
      switch (t.type) {
        case 'rtpcChanged':
          w.u32(t.rtpc);
          break;
        case 'sectionStart':
        case 'sectionEnd':
        case 'bar':
        case 'beat':
          w.u32(idOrNone(t.section));
          break;
        case 'anchorReached':
          w.u32(t.section);
          w.u32(t.anchor);
          break;
        case 'moduleStart':
          break;
      }
      w.u32(b.cue);
    }
    chunks.push({ id: 'CUES', body: w.result() });
  }

  // ABNK
  {
    const w = new Writer();
    w.u32(assets.length);
    for (const a of assets) {
      w.u32(a.id);
      w.str(a.name);
      w.u8(a.format === 'pcm16' ? 0 : 1);
      w.u8(a.channels);
      w.u16(0);
      w.u32(a.sampleRate);
      w.u32(a.frames);
      const bytes = new Uint8Array(a.data.buffer, a.data.byteOffset, a.data.byteLength);
      w.bytes(bytes);
      // Sample data is padded to a multiple of 4 bytes (by data length,
      // independent of its position inside the chunk).
      const pad = (4 - (bytes.length % 4)) % 4;
      for (let p = 0; p < pad; p++) w.u8(0);
    }
    chunks.push({ id: 'ABNK', body: w.result() });
  }

  // WCLP (WCLAP plugin bank). Embedded binaries are looked up from `plugins`.
  {
    const binById = new Map<number, Uint8Array | undefined>();
    for (const p of plugins) binById.set(p.id, p.data);
    const w = new Writer();
    const projPlugins = project.plugins ?? [];
    w.u32(projPlugins.length);
    for (const p of projPlugins) {
      const data = p.embedded ? binById.get(p.id) : undefined;
      w.u32(p.id);
      w.str(p.name);
      w.str(p.clapPluginId ?? '');
      w.str(p.url ?? '');
      w.u8(p.embedded && data ? 1 : 0);
      w.u8(0);
      w.u16(0);
      const bytes = p.embedded && data ? data : new Uint8Array(0);
      w.u32(bytes.length);
      w.bytes(bytes);
      const pad = (4 - (bytes.length % 4)) % 4;
      for (let i = 0; i < pad; i++) w.u8(0);
    }
    chunks.push({ id: 'WCLP', body: w.result() });
  }

  // PINS (plugin instances + master effect chain)
  {
    const w = new Writer();
    const projInstances = project.pluginInstances ?? [];
    const projMasterEffects = project.masterEffects ?? [];
    w.u32(projInstances.length);
    for (const inst of projInstances) {
      w.u32(inst.id);
      w.u32(inst.pluginBankId);
      w.str(inst.clapPluginId ?? '');
      w.u16(inst.params.length);
      w.u16(0);
      for (const p of inst.params) {
        w.u32(p.id);
        w.f32(p.value);
      }
    }
    w.u32(projMasterEffects.length);
    for (const e of projMasterEffects) w.u32(e);
    chunks.push({ id: 'PINS', body: w.result() });
  }

  // BLND (vertical blend curves, v3; engine-evaluated)
  {
    const blends = project.blends ?? [];
    const w = new Writer();
    w.u32(blends.length);
    for (const b of blends) {
      w.u32(b.id);
      w.u32(b.rtpc);
      w.u32(b.section);
      w.u32(b.track);
      w.u16(b.points.length);
      w.u16(0);
      for (const p of b.points) {
        w.f32(p.x);
        w.f32(p.y);
      }
    }
    chunks.push({ id: 'BLND', body: w.result() });
  }

  // PMOD (RTPC -> plugin parameter modulation, v3; host-side only)
  {
    const mods = project.paramMods ?? [];
    const w = new Writer();
    w.u32(mods.length);
    for (const m of mods) {
      w.u32(m.instance);
      w.u32(m.param);
      w.u32(m.rtpc);
      w.u16(m.points.length);
      w.u16(0);
      for (const p of m.points) {
        w.f32(p.x);
        w.f32(p.y);
      }
    }
    chunks.push({ id: 'PMOD', body: w.result() });
  }

  // NSRC (note-generator routing, v3; host-side only)
  {
    const sources = project.noteSources ?? [];
    const w = new Writer();
    w.u32(sources.length);
    for (const s of sources) {
      w.u32(s.generator);
      w.u32(s.target);
    }
    chunks.push({ id: 'NSRC', body: w.result() });
  }

  // META (project JSON for re-import; the engine skips unknown chunks)
  if (includeMeta) {
    const json = JSON.stringify({ project });
    chunks.push({ id: 'META', body: new TextEncoder().encode(json) });
  }

  const w = new Writer();
  w.bytes(new TextEncoder().encode(PACK_MAGIC));
  w.u32(PACK_VERSION);
  w.u32(chunks.length);
  for (const c of chunks) {
    w.bytes(new TextEncoder().encode(c.id));
    w.u32(c.body.length);
    w.bytes(c.body);
    w.pad4();
  }
  return w.result();
}
