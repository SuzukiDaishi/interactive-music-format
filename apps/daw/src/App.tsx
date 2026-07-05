import { useEffect } from 'react';
import { TopBar } from './components/TopBar';
import { SectionList } from './components/SectionList';
import { AssetPanel } from './components/AssetPanel';
import { Timeline } from './components/Timeline';
import { RtpcPanel } from './components/RtpcPanel';
import { CuePanel } from './components/CuePanel';
import { PluginPanel } from './components/PluginPanel';
import { BlendPanel } from './components/BlendPanel';
import { ScriptGraphPanel } from './components/ScriptGraphPanel';
import { EventLog } from './components/EventLog';
import { store, useStore } from './store';
import { loadDemoProject } from './demo';

export function App() {
  const s = useStore();

  useEffect(() => {
    // Start with something audible on first launch.
    if (store.project.sections.length === 0) loadDemoProject();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      const sel = store.selection;
      if (sel.kind === 'item') {
        store.update((st) => {
          const section = st.project.sections.find((x) => x.id === sel.sectionId);
          const track = section?.tracks.find((t) => t.id === sel.trackId);
          if (track) track.items = track.items.filter((i) => i.id !== sel.itemId);
          st.selection = { kind: 'none' };
        });
        e.preventDefault();
      } else if (sel.kind === 'note') {
        store.update((st) => {
          const section = st.project.sections.find((x) => x.id === sel.sectionId);
          const track = section?.tracks.find((t) => t.id === sel.trackId);
          if (track?.notes) track.notes.splice(sel.noteIndex, 1);
          st.selection = { kind: 'none' };
        });
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <TopBar />
      <div className="main">
        <div className="col left">
          <SectionList />
          <AssetPanel />
        </div>
        <div className="col center">
          <div className="center-tabs">
            <button
              className={s.centerView === 'timeline' ? 'tab active' : 'tab'}
              onClick={() => store.touch((st) => (st.centerView = 'timeline'))}
            >
              Timeline
            </button>
            <button
              className={s.centerView === 'graph' ? 'tab active' : 'tab'}
              onClick={() => store.touch((st) => (st.centerView = 'graph'))}
              title="Visual scripting: triggers → logic → actions"
            >
              Script Graph
            </button>
          </div>
          {s.centerView === 'graph' ? (
            <ScriptGraphPanel />
          ) : s.selectedSection ? (
            <Timeline key={s.selectedSection.id} />
          ) : (
            <div className="placeholder">Add or select a section to edit its timeline</div>
          )}
        </div>
        <div className="col right">
          <RtpcPanel />
          <BlendPanel />
          <PluginPanel />
          <CuePanel />
          <EventLog />
        </div>
      </div>
    </div>
  );
}
