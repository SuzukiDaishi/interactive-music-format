import { useRef } from 'react';
import { useStore, store } from '../store';
import { usePreview, preview } from '../preview';
import { importIamWasm, downloadBytes } from '../audio';
import { loadDemoProject } from '../demo';
import { emptyProject, mergeProjects } from '@iam/pack';

export function TopBar() {
  const s = useStore();
  const pv = usePreview();
  const fileRef = useRef<HTMLInputElement>(null);
  const mergeRef = useRef<HTMLInputElement>(null);

  const exportModule = async () => {
    try {
      const bytes = await preview.buildModule('pcm16');
      const name = s.project.name.replace(/[^\w-]+/g, '_').toLowerCase() || 'module';
      downloadBytes(bytes, `${name}.iam.wasm`);
    } catch (e) {
      alert(`Export failed:\n${e instanceof Error ? e.message : e}`);
    }
  };

  const openFile = async (f: File) => {
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const { project, assets, bundles } = importIamWasm(bytes);
      store.loadProject(project, assets, bundles);
    } catch (e) {
      alert(`Open failed:\n${e instanceof Error ? e.message : e}`);
    }
  };

  /**
   * Imports another project's sections/assets/plugins/logic into this one
   * (all ids remapped) so track transitions can pull content from it.
   */
  const mergeFile = async (f: File) => {
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const { project, assets, bundles } = importIamWasm(bytes);
      store.update((st) => {
        const res = mergeProjects(st.project, project);
        for (const a of assets) {
          const newId = res.assetIdMap.get(a.id);
          if (newId !== undefined) st.assets.set(newId, { ...a, id: newId });
        }
        for (const [srcId, data] of bundles) {
          const newId = res.pluginIdMap.get(srcId);
          if (newId !== undefined && !st.pluginBundles.has(newId)) {
            st.pluginBundles.set(newId, data);
          }
        }
      });
      alert(`Merged '${project.name}': sections/assets/plugins imported with new ids.`);
    } catch (e) {
      alert(`Merge failed:\n${e instanceof Error ? e.message : e}`);
    }
  };

  const newProject = () => {
    if (!confirm('Start a new empty project? Unsaved changes are lost.')) return;
    store.loadProject(emptyProject('New Project'), []);
  };

  return (
    <div className="topbar">
      <span className="logo">IAM Studio</span>
      <input
        className="name-input"
        value={s.project.name}
        onChange={(e) => store.update((st) => (st.project.name = e.target.value))}
      />
      <label className="field">
        BPM
        <input
          type="number"
          min={20}
          max={300}
          value={s.project.bpm}
          onChange={(e) => store.update((st) => (st.project.bpm = Number(e.target.value) || 120))}
        />
      </label>
      <label className="field">
        Meter
        <input
          type="number"
          min={1}
          max={16}
          value={s.project.timeSignature[0]}
          onChange={(e) =>
            store.update((st) => (st.project.timeSignature[0] = Number(e.target.value) || 4))
          }
        />
        /
        <input
          type="number"
          min={1}
          max={16}
          value={s.project.timeSignature[1]}
          onChange={(e) =>
            store.update((st) => (st.project.timeSignature[1] = Number(e.target.value) || 4))
          }
        />
      </label>

      <div className="transport">
        <button
          className="primary"
          disabled={pv.building}
          onClick={() => preview.play()}
          title="Build the module and play from the start section"
        >
          {pv.building ? 'Building…' : s.dirty ? '▶ Build & Play' : '▶ Play'}
        </button>
        <button onClick={() => preview.stop(150)}>⏹</button>
        <button onClick={() => (pv.status.playing ? preview.pause() : preview.resume())}>
          {pv.status.playing ? '⏸' : '⏵'}
        </button>
        <label className="field rate">
          Rate {pv.rate.toFixed(2)}×
          <input
            type="range"
            min={-2}
            max={2}
            step={0.05}
            value={pv.rate}
            onChange={(e) => preview.setRate(Number(e.target.value))}
            onDoubleClick={() => preview.setRate(1)}
            title="Playback rate (negative = reverse). Double-click to reset."
          />
        </label>
        <span className="status">
          {pv.status.sectionName ?? '—'} · beat {pv.status.positionBeats.toFixed(1)}
        </span>
      </div>

      <div className="spacer" />
      <button onClick={newProject}>New</button>
      <button onClick={loadDemoProject}>Demo</button>
      <button onClick={() => fileRef.current?.click()}>Open .iam.wasm</button>
      <button
        onClick={() => mergeRef.current?.click()}
        title="Import another project's sections/assets/plugins into this one (track transitions can then borrow its audio)"
      >
        Merge .iam.wasm
      </button>
      <button className="primary" onClick={exportModule}>
        Export .iam.wasm
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".wasm"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) openFile(f);
          e.target.value = '';
        }}
      />
      <input
        ref={mergeRef}
        type="file"
        accept=".wasm"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) mergeFile(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}
