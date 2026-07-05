import { useEffect, useRef, useState } from 'react';
import { useStore, store } from '../store';
import { usePreview, preview } from '../preview';
import { smfToNotes } from '@iam/pack';
import type { Item, MidiNote, Track } from '@iam/pack';

/** ".mid import" button for instrument tracks (SMF format 0/1, beat-timed). */
function MidImportButton({ track }: { track: Track }) {
  const ref = useRef<HTMLInputElement>(null);
  const importFile = async (f: File) => {
    try {
      const notes = smfToNotes(new Uint8Array(await f.arrayBuffer()));
      if (notes.length === 0) {
        alert('No notes found in this MIDI file.');
        return;
      }
      const replace =
        (track.notes?.length ?? 0) === 0 ||
        confirm(`Replace the ${track.notes!.length} existing notes? (Cancel = append)`);
      store.update(() => {
        track.notes = replace ? notes : [...(track.notes ?? []), ...notes];
      });
    } catch (e) {
      alert(`MIDI import failed:\n${e instanceof Error ? e.message : e}`);
    }
  };
  return (
    <>
      <button className="mini-btn" title="Import a .mid file into this track" onClick={() => ref.current?.click()}>
        .mid
      </button>
      <input
        ref={ref}
        type="file"
        accept=".mid,.midi,.smf"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importFile(f);
          e.target.value = '';
        }}
      />
    </>
  );
}

const RULER_H = 28;
const LANE_H = 64;
const HEADER_W = 168;
const EDGE = 7;
/** Default piano-roll key range (C3..C5) when an instrument track has no notes. */
const DEFAULT_KEY_LO = 48;
const DEFAULT_KEY_HI = 72;

type Drag =
  | { kind: 'item-move'; trackId: number; itemId: number; grabBeat: number }
  | { kind: 'item-resize-l'; trackId: number; itemId: number }
  | { kind: 'item-resize-r'; trackId: number; itemId: number }
  | { kind: 'note-move'; trackId: number; noteIndex: number; grabBeat: number; lo: number; hi: number }
  | { kind: 'note-resize-r'; trackId: number; noteIndex: number }
  | { kind: 'anchor'; anchorId: number };

/** Inclusive key range shown for an instrument track's piano roll. */
function keyRange(track: Track): { lo: number; hi: number } {
  const notes = track.notes ?? [];
  if (notes.length === 0) return { lo: DEFAULT_KEY_LO, hi: DEFAULT_KEY_HI };
  let lo = Infinity;
  let hi = -Infinity;
  for (const n of notes) {
    if (n.key < lo) lo = n.key;
    if (n.key > hi) hi = n.key;
  }
  lo -= 2;
  hi += 2;
  // Keep at least an octave visible so single notes aren't full-height.
  while (hi - lo < 12) {
    hi += 1;
    if (hi - lo < 12) lo -= 1;
  }
  return { lo: Math.max(0, lo), hi: Math.min(127, hi) };
}

export function Timeline() {
  const s = useStore();
  const pv = usePreview();
  const section = s.selectedSection!;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [ppb, setPpb] = useState(28); // pixels per beat
  const dragRef = useRef<Drag | null>(null);
  const [hover, setHover] = useState<string>('default');

  const beatsPerBar = section.timeSignature[0] || s.project.timeSignature[0] || 4;
  const bpm = section.bpm || s.project.bpm;
  const widthBeats = Math.max(section.lengthBeats + 8, 16);
  const canvasW = Math.ceil(widthBeats * ppb);
  const canvasH = RULER_H + section.tracks.length * LANE_H + 12;

  const snap = (beat: number, fine = false) => {
    const grid = fine ? 1 / 16 : 1 / 4;
    return Math.round(beat / grid) * grid;
  };

  // ----- drawing ------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvasW * dpr;
    canvas.height = canvasH * dpr;
    canvas.style.width = `${canvasW}px`;
    canvas.style.height = `${canvasH}px`;
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(g);
  });

  function draw(g: CanvasRenderingContext2D) {
    g.fillStyle = '#16181d';
    g.fillRect(0, 0, canvasW, canvasH);

    // lanes
    section.tracks.forEach((_, i) => {
      g.fillStyle = i % 2 ? '#1a1d23' : '#181b21';
      g.fillRect(0, RULER_H + i * LANE_H, canvasW, LANE_H - 2);
    });
    // out-of-section shade
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(section.lengthBeats * ppb, RULER_H, canvasW - section.lengthBeats * ppb, canvasH);

    // grid
    for (let b = 0; b <= widthBeats; b++) {
      const x = b * ppb + 0.5;
      const isBar = b % beatsPerBar === 0;
      g.strokeStyle = isBar ? '#3a3f4b' : '#262a33';
      g.beginPath();
      g.moveTo(x, isBar ? 8 : RULER_H);
      g.lineTo(x, canvasH);
      g.stroke();
      if (isBar) {
        g.fillStyle = '#8a93a6';
        g.font = '10px ui-monospace, monospace';
        g.fillText(String(b / beatsPerBar + 1), x + 3, 12);
      }
    }

    // ruler base line
    g.strokeStyle = '#3a3f4b';
    g.beginPath();
    g.moveTo(0, RULER_H - 0.5);
    g.lineTo(canvasW, RULER_H - 0.5);
    g.stroke();

    // instrument tracks: piano-roll notes
    section.tracks.forEach((track, ti) => {
      if (track.kind !== 'instrument') return;
      const top = RULER_H + ti * LANE_H + 4;
      const h = LANE_H - 12;
      const { lo, hi } = keyRange(track);
      const rowH = h / (hi - lo + 1);
      const notes = track.notes ?? [];
      notes.forEach((n, ni) => {
        const x = n.startBeat * ppb;
        const w = Math.max(n.lengthBeats * ppb, 3);
        const ny = top + (hi - n.key) * rowH;
        const selN =
          s.selection.kind === 'note' &&
          s.selection.sectionId === section.id &&
          s.selection.trackId === track.id &&
          s.selection.noteIndex === ni;
        g.fillStyle = selN ? '#5fd0a0' : `rgba(65,232,165,${0.35 + 0.5 * n.velocity})`;
        g.strokeStyle = selN ? '#b6ffe0' : '#2f9e74';
        roundRect(g, x, ny + 0.5, w, Math.max(rowH - 1, 2), 2);
        g.fill();
        g.stroke();
      });
    });

    // items
    section.tracks.forEach((track, ti) => {
      if (track.kind === 'instrument') return;
      const y = RULER_H + ti * LANE_H;
      for (const item of track.items) {
        const x = item.startBeat * ppb;
        const w = Math.max(item.lengthBeats * ppb, 4);
        const sel =
          s.selection.kind === 'item' &&
          s.selection.sectionId === section.id &&
          s.selection.trackId === track.id &&
          s.selection.itemId === item.id;
        g.fillStyle = sel ? '#3d6fd9' : '#2d4a87';
        g.strokeStyle = sel ? '#7ea7ff' : '#4a6db3';
        roundRect(g, x, y + 4, w, LANE_H - 12, 4);
        g.fill();
        g.stroke();
        drawWaveform(g, item, x, y + 4, w, LANE_H - 12);
        const asset = store.assets.get(item.assetId);
        g.fillStyle = '#dfe6f3';
        g.font = '11px system-ui, sans-serif';
        g.save();
        g.beginPath();
        g.rect(x, y, w, LANE_H);
        g.clip();
        g.fillText(asset?.name ?? `asset ${item.assetId}`, x + 5, y + 16);
        g.restore();
      }
    });

    // anchors
    for (const a of section.anchors) {
      const x = a.beat * ppb;
      g.fillStyle = '#e8b341';
      g.strokeStyle = '#e8b341';
      g.beginPath();
      g.moveTo(x, 2);
      g.lineTo(x + 9, 8);
      g.lineTo(x, 14);
      g.closePath();
      g.fill();
      g.font = '10px system-ui, sans-serif';
      g.fillText(a.name, x + 11, 12);
      g.globalAlpha = 0.5;
      g.beginPath();
      g.moveTo(x + 0.5, 14);
      g.lineTo(x + 0.5, canvasH);
      g.stroke();
      g.globalAlpha = 1;
    }

    // loop start marker
    if (section.loopEnabled && section.loopStartBeats > 0) {
      const x = section.loopStartBeats * ppb;
      g.strokeStyle = '#41e8a5';
      g.setLineDash([4, 3]);
      g.beginPath();
      g.moveTo(x + 0.5, RULER_H);
      g.lineTo(x + 0.5, canvasH);
      g.stroke();
      g.setLineDash([]);
    }

    // playhead
    if (pv.status.sectionId === section.id && pv.player) {
      const x = pv.status.positionBeats * ppb;
      g.strokeStyle = '#ff5d5d';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, canvasH);
      g.stroke();
      g.lineWidth = 1;
    }
  }

  function drawWaveform(
    g: CanvasRenderingContext2D,
    item: Item,
    x: number,
    y: number,
    w: number,
    h: number,
  ) {
    const asset = store.assets.get(item.assetId);
    if (!asset || w < 8) return;
    const framesPerBeat = (asset.sampleRate * 60) / bpm;
    const mid = y + h / 2;
    g.strokeStyle = 'rgba(220,230,255,0.55)';
    g.beginPath();
    const cols = Math.floor(w);
    for (let c = 0; c < cols; c++) {
      const beatInItem = (c / ppb) + 0; // beats from item start at column c
      const f0 = Math.floor((item.offsetBeats + (c / w) * item.lengthBeats) * framesPerBeat);
      const f1 = Math.floor((item.offsetBeats + ((c + 1) / w) * item.lengthBeats) * framesPerBeat);
      void beatInItem;
      if (f0 >= asset.frames) break;
      let min = 1;
      let max = -1;
      const stride = Math.max(1, Math.floor((f1 - f0) / 24));
      for (let f = f0; f < Math.min(f1, asset.frames); f += stride) {
        const v = asset.data[f * asset.channels];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (min > max) continue;
      g.moveTo(x + c + 0.5, mid + min * (h / 2) * 0.9);
      g.lineTo(x + c + 0.5, mid + max * (h / 2) * 0.9 + 0.5);
    }
    g.stroke();
  }

  // ----- interaction ----------------------------------------------------------

  function pos(e: React.PointerEvent | React.MouseEvent | React.DragEvent) {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function hitTest(x: number, y: number) {
    if (y < RULER_H) {
      for (const a of section.anchors) {
        const ax = a.beat * ppb;
        if (x >= ax - 4 && x <= ax + 60) return { kind: 'anchor' as const, anchor: a };
      }
      return { kind: 'ruler' as const };
    }
    const ti = Math.floor((y - RULER_H) / LANE_H);
    const track = section.tracks[ti];
    if (!track) return { kind: 'void' as const };
    if (track.kind === 'instrument') {
      const top = RULER_H + ti * LANE_H + 4;
      const h = LANE_H - 12;
      const { lo, hi } = keyRange(track);
      const rowH = h / (hi - lo + 1);
      const notes = track.notes ?? [];
      for (let ni = notes.length - 1; ni >= 0; ni--) {
        const n = notes[ni];
        const nx = n.startBeat * ppb;
        const nw = Math.max(n.lengthBeats * ppb, 3);
        const ny = top + (hi - n.key) * rowH;
        if (y >= ny - 1 && y <= ny + rowH + 1 && x >= nx - EDGE && x <= nx + nw + EDGE) {
          if (Math.abs(x - (nx + nw)) <= EDGE) return { kind: 'note-r' as const, track, noteIndex: ni };
          if (x >= nx) return { kind: 'note' as const, track, noteIndex: ni };
        }
      }
      const key = Math.round(hi - (y - top) / rowH);
      return { kind: 'inst-lane' as const, track, key: Math.max(0, Math.min(127, key)) };
    }
    for (const item of [...track.items].reverse()) {
      const ix = item.startBeat * ppb;
      const iw = Math.max(item.lengthBeats * ppb, 4);
      if (x >= ix - EDGE && x <= ix + iw + EDGE) {
        if (Math.abs(x - ix) <= EDGE) return { kind: 'item-l' as const, track, item };
        if (Math.abs(x - (ix + iw)) <= EDGE) return { kind: 'item-r' as const, track, item };
        if (x >= ix && x <= ix + iw) return { kind: 'item' as const, track, item };
      }
    }
    return { kind: 'lane' as const, track };
  }

  const onPointerDown = (e: React.PointerEvent) => {
    const { x, y } = pos(e);
    const hit = hitTest(x, y);
    canvasRef.current!.setPointerCapture(e.pointerId);
    const beat = x / ppb;
    switch (hit.kind) {
      case 'anchor':
        dragRef.current = { kind: 'anchor', anchorId: hit.anchor.id };
        break;
      case 'ruler':
        preview.seekBeats(snap(beat, e.shiftKey));
        break;
      case 'item':
        store.touch((st) => {
          st.selection = {
            kind: 'item',
            sectionId: section.id,
            trackId: hit.track.id,
            itemId: hit.item.id,
          };
        });
        dragRef.current = {
          kind: 'item-move',
          trackId: hit.track.id,
          itemId: hit.item.id,
          grabBeat: beat - hit.item.startBeat,
        };
        break;
      case 'item-l':
        dragRef.current = { kind: 'item-resize-l', trackId: hit.track.id, itemId: hit.item.id };
        break;
      case 'item-r':
        dragRef.current = { kind: 'item-resize-r', trackId: hit.track.id, itemId: hit.item.id };
        break;
      case 'note': {
        const note = (hit.track.notes ?? [])[hit.noteIndex];
        const range = keyRange(hit.track);
        store.touch((st) => {
          st.selection = {
            kind: 'note',
            sectionId: section.id,
            trackId: hit.track.id,
            noteIndex: hit.noteIndex,
          };
        });
        dragRef.current = {
          kind: 'note-move',
          trackId: hit.track.id,
          noteIndex: hit.noteIndex,
          grabBeat: beat - (note?.startBeat ?? 0),
          lo: range.lo,
          hi: range.hi,
        };
        break;
      }
      case 'note-r':
        store.touch((st) => {
          st.selection = {
            kind: 'note',
            sectionId: section.id,
            trackId: hit.track.id,
            noteIndex: hit.noteIndex,
          };
        });
        dragRef.current = { kind: 'note-resize-r', trackId: hit.track.id, noteIndex: hit.noteIndex };
        break;
      case 'inst-lane':
        store.touch((st) => {
          st.selection = { kind: 'track', sectionId: section.id, trackId: hit.track.id };
        });
        break;
      case 'lane':
        store.touch((st) => {
          st.selection = { kind: 'track', sectionId: section.id, trackId: hit.track.id };
        });
        break;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = pos(e);
    const drag = dragRef.current;
    if (!drag) {
      const hit = hitTest(x, y);
      setHover(
        hit.kind === 'item-l' || hit.kind === 'item-r' || hit.kind === 'note-r'
          ? 'ew-resize'
          : hit.kind === 'item' || hit.kind === 'note'
            ? 'grab'
            : hit.kind === 'anchor'
              ? 'col-resize'
              : hit.kind === 'inst-lane'
                ? 'crosshair'
                : 'default',
      );
      return;
    }
    const beat = snap(x / ppb, e.shiftKey);
    store.update(() => {
      if (drag.kind === 'anchor') {
        const a = section.anchors.find((v) => v.id === drag.anchorId);
        if (a) a.beat = Math.min(Math.max(0, beat), section.lengthBeats);
        return;
      }
      if (drag.kind === 'note-move' || drag.kind === 'note-resize-r') {
        const track = section.tracks.find((t) => t.id === drag.trackId);
        const note = track?.notes?.[drag.noteIndex];
        if (!note || !track) return;
        if (drag.kind === 'note-resize-r') {
          note.lengthBeats = Math.max(0.25, beat - note.startBeat);
        } else {
          note.startBeat = Math.max(0, snap(x / ppb - drag.grabBeat, e.shiftKey));
          const ti = section.tracks.indexOf(track);
          const top = RULER_H + ti * LANE_H + 4;
          const h = LANE_H - 12;
          const rowH = h / (drag.hi - drag.lo + 1);
          const key = Math.round(drag.hi - (y - top) / rowH);
          note.key = Math.max(0, Math.min(127, key));
        }
        return;
      }
      const track = section.tracks.find((t) => t.id === drag.trackId);
      const item = track?.items.find((i) => i.id === drag.itemId);
      if (!item) return;
      if (drag.kind === 'item-move') {
        item.startBeat = Math.max(0, snap(x / ppb - drag.grabBeat, e.shiftKey));
      } else if (drag.kind === 'item-resize-r') {
        item.lengthBeats = Math.max(0.25, beat - item.startBeat);
      } else if (drag.kind === 'item-resize-l') {
        const end = item.startBeat + item.lengthBeats;
        const newStart = Math.min(Math.max(0, beat), end - 0.25);
        item.offsetBeats = Math.max(0, item.offsetBeats + (newStart - item.startBeat));
        item.startBeat = newStart;
        item.lengthBeats = end - newStart;
      }
    });
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const { x, y } = pos(e);
    const hit = hitTest(x, y);
    if (hit.kind === 'anchor') {
      const name = prompt('Anchor name:', hit.anchor.name);
      if (name) store.update(() => (hit.anchor.name = name));
    } else if (hit.kind === 'ruler') {
      const beat = snap(x / ppb, e.shiftKey);
      store.update((st) => {
        const id = st.nextId(section.anchors.map((a) => a.id));
        section.anchors.push({ id, name: `Anchor_${id}`, beat });
      });
    } else if (hit.kind === 'lane' && store.selectedAssetId !== null) {
      addItemAt(hit.track, x / ppb);
    } else if (hit.kind === 'inst-lane') {
      addNoteAt(hit.track, x / ppb, hit.key);
    }
  };

  function addNoteAt(track: Track, beat: number, key: number) {
    store.update((st) => {
      track.notes ??= [];
      const note: MidiNote = {
        startBeat: Math.max(0, snap(beat)),
        lengthBeats: 1,
        key,
        velocity: 0.8,
        channel: 0,
      };
      track.notes.push(note);
      st.selection = {
        kind: 'note',
        sectionId: section.id,
        trackId: track.id,
        noteIndex: track.notes.length - 1,
      };
    });
  }

  const onContextMenu = (e: React.MouseEvent) => {
    const { x, y } = pos(e);
    const hit = hitTest(x, y);
    if (hit.kind === 'anchor') {
      e.preventDefault();
      if (confirm(`Delete anchor '${hit.anchor.name}'?`)) {
        store.update(() => {
          section.anchors = section.anchors.filter((a) => a.id !== hit.anchor.id);
        });
      }
    }
  };

  function addItemAt(track: Track, beat: number, assetId?: number) {
    const aid = assetId ?? store.selectedAssetId;
    if (aid === null) return;
    const asset = store.assets.get(aid);
    if (!asset) return;
    const assetBeats = (asset.frames / asset.sampleRate) * (bpm / 60);
    store.update((st) => {
      const id = st.nextId(track.items.map((i) => i.id));
      track.items.push({
        id,
        assetId: aid,
        startBeat: Math.max(0, snap(beat)),
        lengthBeats: Math.min(assetBeats, section.lengthBeats),
        offsetBeats: 0,
        gain: 1,
        fadeInBeats: 0,
        fadeOutBeats: 0,
      });
      st.selection = { kind: 'item', sectionId: section.id, trackId: track.id, itemId: id };
    });
  }

  const onDrop = (e: React.DragEvent) => {
    const data = e.dataTransfer.getData('application/x-iam-asset');
    if (!data) return;
    e.preventDefault();
    const { x, y } = pos(e);
    const ti = Math.floor((y - RULER_H) / LANE_H);
    const track = section.tracks[ti];
    if (track) addItemAt(track, x / ppb, Number(data));
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setPpb((p) => Math.min(160, Math.max(6, p * (e.deltaY > 0 ? 0.85 : 1.18))));
  };

  // ----- selected item inspector ---------------------------------------------

  const sel = s.selection;
  const selItem =
    sel.kind === 'item' && sel.sectionId === section.id
      ? section.tracks.find((t) => t.id === sel.trackId)?.items.find((i) => i.id === sel.itemId)
      : undefined;
  const selNote =
    sel.kind === 'note' && sel.sectionId === section.id
      ? section.tracks.find((t) => t.id === sel.trackId)?.notes?.[sel.noteIndex]
      : undefined;

  return (
    <div className="timeline-wrap">
      <div className="timeline-toolbar">
        <span className="dim">
          {section.name} · {section.lengthBeats} beats · {bpm} BPM
          {section.loopEnabled ? ' · loop' : ''}
        </span>
        <label className="field">
          Section BPM
          <input
            type="number"
            placeholder="inherit"
            value={section.bpm || ''}
            onChange={(e) => store.update(() => (section.bpm = Number(e.target.value) || 0))}
            title="0/empty = inherit project BPM"
          />
        </label>
        <label className="field">
          Loop start
          <input
            type="number"
            min={0}
            step={1}
            value={section.loopStartBeats}
            onChange={(e) =>
              store.update(() => (section.loopStartBeats = Math.max(0, Number(e.target.value) || 0)))
            }
          />
        </label>
        <span className="dim hint-inline">
          double-click ruler: add anchor · double-click lane: place selected asset · ctrl+wheel: zoom
        </span>
      </div>
      <div className="timeline-body">
        <div className="track-headers" style={{ width: HEADER_W, marginTop: RULER_H }}>
          {section.tracks.map((t) => (
            <div
              key={t.id}
              className={`track-header ${t.kind === 'instrument' ? 'instrument' : ''}`}
              style={{ height: LANE_H - 2 }}
            >
              <div className="track-title">
                <input
                  value={t.name}
                  onChange={(e) => store.update(() => (t.name = e.target.value))}
                />
                <select
                  className="kind"
                  title="Track type"
                  value={t.kind === 'instrument' ? 'instrument' : 'audio'}
                  onChange={(e) =>
                    store.update(() => {
                      if (e.target.value === 'instrument') {
                        t.kind = 'instrument';
                        t.notes ??= [];
                        t.effects ??= [];
                        if (t.instrument == null)
                          t.instrument = s.project.pluginInstances[0]?.id ?? null;
                      } else {
                        t.kind = 'audio';
                      }
                    })
                  }
                >
                  <option value="audio">audio</option>
                  <option value="instrument">instrument</option>
                </select>
              </div>
              <div className="track-controls">
                <button
                  className={t.muted ? 'mute on' : 'mute'}
                  onClick={() =>
                    store.update(() => {
                      t.muted = !t.muted;
                      preview.setTrackMute(section.id, t.id, t.muted);
                    })
                  }
                >
                  M
                </button>
                <input
                  type="range"
                  min={0}
                  max={1.5}
                  step={0.01}
                  value={t.volume}
                  title={`Volume ${t.volume.toFixed(2)}`}
                  onChange={(e) =>
                    store.update(() => {
                      t.volume = Number(e.target.value);
                      preview.setTrackVolume(section.id, t.id, t.volume);
                    })
                  }
                />
                <input
                  type="range"
                  min={-1}
                  max={1}
                  step={0.05}
                  className="pan"
                  value={t.pan}
                  title={`Pan ${t.pan.toFixed(2)}`}
                  onDoubleClick={() =>
                    store.update(() => {
                      t.pan = 0;
                      preview.setTrackPan(section.id, t.id, 0);
                    })
                  }
                  onChange={(e) =>
                    store.update(() => {
                      t.pan = Number(e.target.value);
                      preview.setTrackPan(section.id, t.id, t.pan);
                    })
                  }
                />
                <button
                  title="Delete track"
                  onClick={() => {
                    const hasContent = t.items.length > 0 || (t.notes?.length ?? 0) > 0;
                    if (hasContent && !confirm(`Delete track '${t.name}' and its content?`)) return;
                    store.update(() => {
                      section.tracks = section.tracks.filter((x) => x.id !== t.id);
                    });
                  }}
                >
                  ✕
                </button>
              </div>
              {t.kind === 'instrument' && (
                <div className="track-inst">
                  <select
                    title="Instrument (plugin instance driven by this track's notes)"
                    value={t.instrument ?? ''}
                    onChange={(e) =>
                      store.update(
                        () => (t.instrument = e.target.value === '' ? null : Number(e.target.value)),
                      )
                    }
                  >
                    <option value="">— synth —</option>
                    {s.project.pluginInstances.map((inst) => {
                      const bank = s.project.plugins.find((p) => p.id === inst.pluginBankId);
                      return (
                        <option key={inst.id} value={inst.id}>
                          {bank?.name ?? `inst ${inst.id}`} #{inst.id}
                        </option>
                      );
                    })}
                  </select>
                  <select
                    title="Add an insert effect to this track"
                    value=""
                    onChange={(e) => {
                      if (!e.target.value) return;
                      const id = Number(e.target.value);
                      store.update(() => {
                        t.effects ??= [];
                        if (!t.effects.includes(id)) t.effects.push(id);
                      });
                    }}
                  >
                    <option value="">＋ fx…</option>
                    {s.project.pluginInstances
                      .filter((inst) => !(t.effects ?? []).includes(inst.id) && inst.id !== t.instrument)
                      .map((inst) => {
                        const bank = s.project.plugins.find((p) => p.id === inst.pluginBankId);
                        return (
                          <option key={inst.id} value={inst.id}>
                            {bank?.name ?? `inst ${inst.id}`} #{inst.id}
                          </option>
                        );
                      })}
                  </select>
                  {(t.effects ?? []).map((id) => {
                    const inst = s.project.pluginInstances.find((i) => i.id === id);
                    const bank = inst && s.project.plugins.find((p) => p.id === inst.pluginBankId);
                    return (
                      <span key={id} className="fx-chip" title="Insert effect">
                        {bank?.name?.replace(/^Z Audio /, '') ?? `#${id}`}
                        <button
                          onClick={() =>
                            store.update(() => (t.effects = (t.effects ?? []).filter((x) => x !== id)))
                          }
                        >
                          ✕
                        </button>
                      </span>
                    );
                  })}
                  <MidImportButton track={t} />
                </div>
              )}
            </div>
          ))}
          <div className="add-track-row">
            <button
              className="add-track"
              onClick={() =>
                store.update((st) => {
                  const id = st.nextId(section.tracks.map((t) => t.id));
                  section.tracks.push({
                    id,
                    name: `Track ${id + 1}`,
                    volume: 1,
                    pan: 0,
                    muted: false,
                    items: [],
                  });
                })
              }
            >
              ＋ Audio
            </button>
            <button
              className="add-track"
              title="Add an instrument (MIDI) track driven by a WCLAP synth"
              onClick={() =>
                store.update((st) => {
                  const id = st.nextId(section.tracks.map((t) => t.id));
                  section.tracks.push({
                    id,
                    name: `Synth ${id + 1}`,
                    volume: 1,
                    pan: 0,
                    muted: false,
                    items: [],
                    kind: 'instrument',
                    instrument: st.project.pluginInstances[0]?.id ?? null,
                    notes: [],
                    effects: [],
                  });
                })
              }
            >
              ＋ Instrument
            </button>
          </div>
        </div>
        <div className="timeline-scroll" ref={scrollRef}>
          <canvas
            ref={canvasRef}
            style={{ cursor: hover }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={onDoubleClick}
            onContextMenu={onContextMenu}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('application/x-iam-asset')) e.preventDefault();
            }}
            onDrop={onDrop}
            onWheel={onWheel}
          />
        </div>
      </div>
      {selItem && (
        <div className="item-inspector">
          <span className="dim">Item</span>
          <label className="field">
            Start
            <input
              type="number"
              step={0.25}
              value={selItem.startBeat}
              onChange={(e) =>
                store.update(() => (selItem.startBeat = Math.max(0, Number(e.target.value) || 0)))
              }
            />
          </label>
          <label className="field">
            Length
            <input
              type="number"
              step={0.25}
              min={0.25}
              value={selItem.lengthBeats}
              onChange={(e) =>
                store.update(
                  () => (selItem.lengthBeats = Math.max(0.25, Number(e.target.value) || 0.25)),
                )
              }
            />
          </label>
          <label className="field">
            Offset
            <input
              type="number"
              step={0.25}
              min={0}
              value={selItem.offsetBeats}
              onChange={(e) =>
                store.update(() => (selItem.offsetBeats = Math.max(0, Number(e.target.value) || 0)))
              }
            />
          </label>
          <label className="field">
            Gain
            <input
              type="number"
              step={0.05}
              min={0}
              value={selItem.gain}
              onChange={(e) =>
                store.update(() => (selItem.gain = Math.max(0, Number(e.target.value) || 0)))
              }
            />
          </label>
          <label className="field">
            Fade in
            <input
              type="number"
              step={0.25}
              min={0}
              value={selItem.fadeInBeats}
              onChange={(e) =>
                store.update(() => (selItem.fadeInBeats = Math.max(0, Number(e.target.value) || 0)))
              }
            />
          </label>
          <label className="field">
            Fade out
            <input
              type="number"
              step={0.25}
              min={0}
              value={selItem.fadeOutBeats}
              onChange={(e) =>
                store.update(
                  () => (selItem.fadeOutBeats = Math.max(0, Number(e.target.value) || 0)),
                )
              }
            />
          </label>
          <span className="dim hint-inline">Delete key removes the item</span>
        </div>
      )}
      {selNote && (
        <div className="item-inspector">
          <span className="dim">Note</span>
          <label className="field">
            Key
            <input
              type="number"
              min={0}
              max={127}
              value={selNote.key}
              onChange={(e) =>
                store.update(
                  () => (selNote.key = Math.max(0, Math.min(127, Number(e.target.value) || 0))),
                )
              }
            />
          </label>
          <label className="field">
            Start
            <input
              type="number"
              step={0.25}
              value={selNote.startBeat}
              onChange={(e) =>
                store.update(() => (selNote.startBeat = Math.max(0, Number(e.target.value) || 0)))
              }
            />
          </label>
          <label className="field">
            Length
            <input
              type="number"
              step={0.25}
              min={0.25}
              value={selNote.lengthBeats}
              onChange={(e) =>
                store.update(
                  () => (selNote.lengthBeats = Math.max(0.25, Number(e.target.value) || 0.25)),
                )
              }
            />
          </label>
          <label className="field">
            Velocity
            <input
              type="number"
              step={0.05}
              min={0}
              max={1}
              value={selNote.velocity}
              onChange={(e) =>
                store.update(
                  () => (selNote.velocity = Math.max(0, Math.min(1, Number(e.target.value) || 0))),
                )
              }
            />
          </label>
          <label className="field">
            Channel
            <input
              type="number"
              min={0}
              max={15}
              value={selNote.channel}
              onChange={(e) =>
                store.update(
                  () => (selNote.channel = Math.max(0, Math.min(15, Number(e.target.value) || 0))),
                )
              }
            />
          </label>
          <span className="dim hint-inline">double-click an instrument lane to add a note · Delete removes it</span>
        </div>
      )}
    </div>
  );
}

function roundRect(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
