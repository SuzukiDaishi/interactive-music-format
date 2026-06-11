import { useStore, store } from '../store';
import { preview } from '../preview';
import { Section } from '@iam/pack';

function addSection() {
  store.update((s) => {
    const id = s.nextSectionId();
    const section: Section = {
      id,
      name: `Section_${id}`,
      bpm: 0,
      timeSignature: [0, 0],
      loopEnabled: true,
      lengthBeats: 16,
      loopStartBeats: 0,
      tracks: [
        { id: 0, name: 'Track 1', volume: 1, pan: 0, muted: false, items: [] },
      ],
      anchors: [{ id: 0, name: 'Entry', beat: 0 }],
    };
    s.project.sections.push(section);
    s.selectedSectionId = id;
    if (s.project.startSectionId === null) s.project.startSectionId = id;
  });
}

export function SectionList() {
  const s = useStore();
  return (
    <div className="panel">
      <div className="panel-head">
        <span>Sections</span>
        <button onClick={addSection}>＋</button>
      </div>
      <div className="panel-body">
        {s.project.sections.map((sec) => (
          <div
            key={sec.id}
            className={`section-row ${s.selectedSectionId === sec.id ? 'selected' : ''}`}
            onClick={() => store.touch((st) => (st.selectedSectionId = sec.id))}
          >
            <input
              type="radio"
              name="start-section"
              checked={s.project.startSectionId === sec.id}
              title="Start section"
              onChange={() => store.update((st) => (st.project.startSectionId = sec.id))}
              onClick={(e) => e.stopPropagation()}
            />
            <input
              className="grow"
              value={sec.name}
              onChange={(e) => store.update(() => (sec.name = e.target.value))}
              onClick={(e) => e.stopPropagation()}
            />
            <label className="mini" title="Loop section" onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={sec.loopEnabled}
                onChange={(e) => store.update(() => (sec.loopEnabled = e.target.checked))}
              />
              ↻
            </label>
            <input
              className="num"
              type="number"
              min={1}
              title="Length in beats"
              value={sec.lengthBeats}
              onChange={(e) =>
                store.update(() => (sec.lengthBeats = Math.max(1, Number(e.target.value) || 1)))
              }
              onClick={(e) => e.stopPropagation()}
            />
            <button
              title="Preview this section"
              onClick={(e) => {
                e.stopPropagation();
                preview.play(sec.id);
              }}
            >
              ▶
            </button>
            <button
              title="Delete section"
              onClick={(e) => {
                e.stopPropagation();
                if (!confirm(`Delete section '${sec.name}'?`)) return;
                store.update((st) => {
                  st.project.sections = st.project.sections.filter((x) => x.id !== sec.id);
                  if (st.project.startSectionId === sec.id) {
                    st.project.startSectionId = st.project.sections[0]?.id ?? null;
                  }
                  if (st.selectedSectionId === sec.id) {
                    st.selectedSectionId = st.project.sections[0]?.id ?? null;
                  }
                });
              }}
            >
              ✕
            </button>
          </div>
        ))}
        {s.project.sections.length === 0 && (
          <div className="hint">No sections yet — press ＋ to add one.</div>
        )}
      </div>
    </div>
  );
}
