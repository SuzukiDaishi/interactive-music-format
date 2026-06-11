import { useRef, useState } from 'react';
import { useStore, store } from '../store';
import { importAudioFile } from '../audio';

export function AssetPanel() {
  const s = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const importFiles = async (files: FileList) => {
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        const audio = await importAudioFile(f, store.project.bankSampleRate);
        store.update((st) => {
          const id = st.nextAssetId();
          st.assets.set(id, { id, ...audio });
          st.selectedAssetId = id;
        });
      }
    } catch (e) {
      alert(`Import failed:\n${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <span>Assets</span>
        <button onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? '…' : '＋ Import'}
        </button>
      </div>
      <div className="panel-body">
        {[...s.assets.values()].map((a) => (
          <div
            key={a.id}
            className={`asset-row ${s.selectedAssetId === a.id ? 'selected' : ''}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-iam-asset', String(a.id));
              store.touch((st) => (st.selectedAssetId = a.id));
            }}
            onClick={() => store.touch((st) => (st.selectedAssetId = a.id))}
            title="Drag onto a timeline lane to place"
          >
            <span className="grow">{a.name}</span>
            <span className="dim">
              {(a.frames / a.sampleRate).toFixed(1)}s {a.channels === 2 ? 'st' : 'mo'}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                const used = store.project.sections.some((sec) =>
                  sec.tracks.some((t) => t.items.some((i) => i.assetId === a.id)),
                );
                if (used && !confirm(`Asset '${a.name}' is used by items. Delete anyway?`)) return;
                store.update((st) => {
                  st.assets.delete(a.id);
                  for (const sec of st.project.sections) {
                    for (const t of sec.tracks) {
                      t.items = t.items.filter((i) => i.assetId !== a.id);
                    }
                  }
                });
              }}
            >
              ✕
            </button>
          </div>
        ))}
        {s.assets.size === 0 && (
          <div className="hint">Import audio files (wav/mp3/m4a/ogg…) to place them on tracks.</div>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) importFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}
