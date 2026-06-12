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
        <span title="Sections are the musical states (e.g. Explore, Battle) the engine switches between">
          Sections
        </span>
        <button title="Add a new section" onClick={addSection}>
          ＋ Add
        </button>
      </div>
      <div className="panel-body">
        {s.project.sections.map((sec) => {
          const isStart = s.project.startSectionId === sec.id;
          return (
            <div
              key={sec.id}
              className={`section-card ${s.selectedSectionId === sec.id ? 'selected' : ''}`}
              onClick={() => store.touch((st) => (st.selectedSectionId = sec.id))}
              title="Click to edit this section in the timeline"
            >
              <div className="section-card-main">
                {isStart && (
                  <span className="start-badge" title="Playback starts from this section">
                    ★
                  </span>
                )}
                <input
                  className="grow"
                  value={sec.name}
                  onChange={(e) => store.update(() => (sec.name = e.target.value))}
                  onClick={(e) => e.stopPropagation()}
                />
                <button
                  className="icon-btn"
                  title="Preview this section"
                  onClick={(e) => {
                    e.stopPropagation();
                    preview.play(sec.id);
                  }}
                >
                  ▶
                </button>
                <button
                  className="icon-btn"
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
              <div className="section-card-meta" onClick={(e) => e.stopPropagation()}>
                <label className="meta-toggle" title="Playback starts from this section">
                  <input
                    type="radio"
                    name="start-section"
                    checked={isStart}
                    onChange={() => store.update((st) => (st.project.startSectionId = sec.id))}
                  />
                  Start
                </label>
                <label className="meta-toggle" title="Repeat this section until a transition happens">
                  <input
                    type="checkbox"
                    checked={sec.loopEnabled}
                    onChange={(e) => store.update(() => (sec.loopEnabled = e.target.checked))}
                  />
                  Loop
                </label>
                <label className="meta-field" title="Section length in beats">
                  Length
                  <input
                    className="num"
                    type="number"
                    min={1}
                    value={sec.lengthBeats}
                    onChange={(e) =>
                      store.update(() => (sec.lengthBeats = Math.max(1, Number(e.target.value) || 1)))
                    }
                  />
                  beats
                </label>
              </div>
            </div>
          );
        })}
        {s.project.sections.length === 0 && (
          <div className="hint">
            No sections yet — click <b>＋ Add</b> above. Sections are the musical states (e.g.
            Explore, Battle) the engine switches between.
          </div>
        )}
      </div>
    </div>
  );
}
