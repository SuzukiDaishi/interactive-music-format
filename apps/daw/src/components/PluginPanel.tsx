/**
 * WebCLAP plugin authoring: manage the plugin bank (embedded `.wclap` bundles),
 * instantiate plugins with parameter values, and order the master effect chain.
 * The preview/export path embeds these into the module's WCLP chunk, and the
 * browser player hosts them automatically (instrument synths + effects).
 */
import { useRef, useState } from 'react';
import { useStore, store } from '../store';
import {
  WCLAP_LIBRARY,
  findLibraryEntry,
  fetchBundleBytes,
} from '../wclapLibrary';

/** Adds a bank plugin from a fetched/embedded bundle and returns its id. */
function addBankPlugin(
  name: string,
  clapPluginId: string,
  bytes: Uint8Array,
): number {
  let id = 0;
  store.update((st) => {
    id = st.nextPluginId();
    st.pluginBundles.set(id, bytes);
    st.project.plugins.push({ id, name, clapPluginId, embedded: true });
  });
  return id;
}

function BankSection() {
  const s = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);

  const addFromLibrary = async (clapPluginId: string) => {
    const entry = findLibraryEntry(clapPluginId);
    if (!entry) return;
    setBusy(true);
    try {
      const bytes = await fetchBundleBytes(entry.url);
      const id = addBankPlugin(entry.name, entry.clapPluginId, bytes);
      store.update((st) => {
        const p = st.project.plugins.find((x) => x.id === id);
        if (p) p.url = entry.url;
      });
    } catch (e) {
      alert(`Add plugin failed:\n${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
      setPick('');
    }
  };

  const addFromFile = async (f: File) => {
    setBusy(true);
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      addBankPlugin(f.name.replace(/\.(wclap\.)?tar\.gz$/i, ''), '', bytes);
    } catch (e) {
      alert(`Load bundle failed:\n${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  const removeBank = (id: number) => {
    if (!confirm('Remove this plugin from the bank? Instances using it are also removed.')) return;
    store.update((st) => {
      const deadInstances = st.project.pluginInstances
        .filter((i) => i.pluginBankId === id)
        .map((i) => i.id);
      st.project.plugins = st.project.plugins.filter((p) => p.id !== id);
      st.pluginBundles.delete(id);
      removeInstances(deadInstances);
    });
  };

  return (
    <div className="plugin-group">
      <div className="panel-subhead">
        <span title="Plugin bank: the WCLAP bundles embedded in this module">Plugin bank</span>
        <span className="plugin-add">
          <select
            value={pick}
            disabled={busy}
            onChange={(e) => {
              if (e.target.value) addFromLibrary(e.target.value);
            }}
          >
            <option value="">{busy ? 'loading…' : '＋ from library…'}</option>
            <optgroup label="Instruments">
              {WCLAP_LIBRARY.filter((e) => e.kind === 'instrument').map((e) => (
                <option key={e.clapPluginId} value={e.clapPluginId}>
                  {e.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Effects">
              {WCLAP_LIBRARY.filter((e) => e.kind === 'effect').map((e) => (
                <option key={e.clapPluginId} value={e.clapPluginId}>
                  {e.name}
                </option>
              ))}
            </optgroup>
          </select>
          <button disabled={busy} title="Load a .wclap.tar.gz file" onClick={() => fileRef.current?.click()}>
            file…
          </button>
        </span>
        <input
          ref={fileRef}
          type="file"
          accept=".gz,.tgz,.tar.gz"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) addFromFile(f);
            e.target.value = '';
          }}
        />
      </div>
      {s.project.plugins.length === 0 && (
        <div className="hint">
          No plugins yet. Add a WCLAP synth or effect from the library, then create an instance below
          and assign it to an instrument track (synth) or the master chain (effect).
        </div>
      )}
      {s.project.plugins.map((p) => (
        <div key={p.id} className="plugin-row">
          <span className="plugin-id">#{p.id}</span>
          <input
            className="plugin-name"
            value={p.name}
            onChange={(e) => store.update(() => (p.name = e.target.value))}
          />
          <input
            className="plugin-clap"
            placeholder="clap plugin id"
            value={p.clapPluginId ?? ''}
            onChange={(e) => store.update(() => (p.clapPluginId = e.target.value || undefined))}
          />
          <span className={`plugin-embed ${p.embedded ? 'on' : ''}`} title={p.embedded ? 'Embedded in the module' : 'Referenced by URL'}>
            {p.embedded ? 'embedded' : 'url'}
          </span>
          <button className="remove" title="Remove plugin" onClick={() => removeBank(p.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/** Removes plugin instances and scrubs every reference to them. */
function removeInstances(ids: number[]) {
  if (ids.length === 0) return;
  const dead = new Set(ids);
  store.project.pluginInstances = store.project.pluginInstances.filter((i) => !dead.has(i.id));
  store.project.masterEffects = store.project.masterEffects.filter((id) => !dead.has(id));
  for (const sec of store.project.sections) {
    for (const t of sec.tracks) {
      if (t.instrument != null && dead.has(t.instrument)) t.instrument = null;
      if (t.effects) t.effects = t.effects.filter((id) => !dead.has(id));
    }
  }
}

function InstanceSection() {
  const s = useStore();
  const bankName = (bankId: number) =>
    s.project.plugins.find((p) => p.id === bankId)?.name ?? `bank ${bankId}`;

  const addInstance = (bankId: number) => {
    store.update((st) => {
      const bank = st.project.plugins.find((p) => p.id === bankId);
      st.project.pluginInstances.push({
        id: st.nextInstanceId(),
        pluginBankId: bankId,
        clapPluginId: bank?.clapPluginId,
        params: [],
      });
    });
  };

  return (
    <div className="plugin-group">
      <div className="panel-subhead">
        <span title="An instance is a configured copy of a bank plugin you can route">Instances</span>
        <select
          value=""
          disabled={s.project.plugins.length === 0}
          onChange={(e) => {
            if (e.target.value) addInstance(Number(e.target.value));
          }}
        >
          <option value="">＋ instance…</option>
          {s.project.plugins.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {s.project.pluginInstances.map((inst) => (
        <div key={inst.id} className="instance-row">
          <div className="instance-head">
            <span className="plugin-id">#{inst.id}</span>
            <span className="dim">{bankName(inst.pluginBankId)}</span>
            <button
              className="mini-btn"
              title="Add a CLAP parameter override"
              onClick={() => store.update(() => inst.params.push({ id: 0, value: 0 }))}
            >
              ＋ param
            </button>
            <button
              className="remove"
              title="Delete instance"
              onClick={() => store.update(() => removeInstances([inst.id]))}
            >
              ✕
            </button>
          </div>
          {inst.params.map((pr, pi) => (
            <div key={pi} className="param-row">
              <input
                className="num"
                type="number"
                title="CLAP param id"
                value={pr.id}
                onChange={(e) => store.update(() => (pr.id = Number(e.target.value) || 0))}
              />
              <input
                className="num"
                type="number"
                step={0.01}
                title="value"
                value={pr.value}
                onChange={(e) => store.update(() => (pr.value = Number(e.target.value) || 0))}
              />
              <button className="remove" onClick={() => store.update(() => inst.params.splice(pi, 1))}>
                ✕
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function MasterSection() {
  const s = useStore();
  const instName = (id: number) => {
    const inst = s.project.pluginInstances.find((i) => i.id === id);
    const bank = inst && s.project.plugins.find((p) => p.id === inst.pluginBankId);
    return bank?.name ?? `instance ${id}`;
  };
  const available = s.project.pluginInstances.filter((i) => !s.project.masterEffects.includes(i.id));

  const move = (idx: number, delta: number) => {
    const j = idx + delta;
    if (j < 0 || j >= s.project.masterEffects.length) return;
    store.update((st) => {
      const arr = st.project.masterEffects;
      [arr[idx], arr[j]] = [arr[j], arr[idx]];
    });
  };

  return (
    <div className="plugin-group">
      <div className="panel-subhead">
        <span title="Effects applied to the final mix, in order">Master effects</span>
        <select
          value=""
          disabled={available.length === 0}
          onChange={(e) => {
            if (e.target.value) store.update(() => s.project.masterEffects.push(Number(e.target.value)));
          }}
        >
          <option value="">＋ effect…</option>
          {available.map((i) => (
            <option key={i.id} value={i.id}>
              {instName(i.id)} #{i.id}
            </option>
          ))}
        </select>
      </div>
      {s.project.masterEffects.map((id, idx) => (
        <div key={idx} className="master-row">
          <span className="dim">{idx + 1}.</span>
          <span className="master-name">{instName(id)} #{id}</span>
          <button className="mini-btn" disabled={idx === 0} onClick={() => move(idx, -1)}>▲</button>
          <button className="mini-btn" disabled={idx === s.project.masterEffects.length - 1} onClick={() => move(idx, 1)}>▼</button>
          <button
            className="remove"
            onClick={() => store.update(() => s.project.masterEffects.splice(idx, 1))}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Note generators (v3): a plugin instance whose CLAP note output drives
 * another instrument instance — generative music lives in the plugin, the
 * host just routes it.
 */
function NoteSourceSection() {
  const s = useStore();
  const sources = s.project.noteSources ?? [];
  const instName = (id: number) => {
    const inst = s.project.pluginInstances.find((i) => i.id === id);
    const bank = inst && s.project.plugins.find((p) => p.id === inst.pluginBankId);
    return `${bank?.name ?? '?'} #${id}`;
  };

  const add = () => {
    store.update((st) => {
      const insts = st.project.pluginInstances;
      if (insts.length < 2) {
        alert('Note routing needs two plugin instances (a generator and a target synth).');
        return;
      }
      st.project.noteSources ??= [];
      st.project.noteSources.push({ generator: insts[0].id, target: insts[1].id });
    });
  };

  return (
    <div className="plugin-group">
      <div className="panel-subhead">
        <span title="Generative WCLAP: the generator's CLAP note output plays the target instrument (its own audio is discarded)">
          Note generators
        </span>
        <button onClick={add}>＋ route</button>
      </div>
      {sources.map((ns, i) => (
        <div key={i} className="master-row">
          <select
            value={ns.generator}
            title="Generator instance (note output captured)"
            onChange={(e) => store.update(() => (ns.generator = Number(e.target.value)))}
          >
            {s.project.pluginInstances.map((inst) => (
              <option key={inst.id} value={inst.id}>
                {instName(inst.id)}
              </option>
            ))}
          </select>
          <span className="dim">♪→</span>
          <select
            value={ns.target}
            title="Target instrument playing the generated notes"
            onChange={(e) => store.update(() => (ns.target = Number(e.target.value)))}
          >
            {s.project.pluginInstances.map((inst) => (
              <option key={inst.id} value={inst.id}>
                {instName(inst.id)}
              </option>
            ))}
          </select>
          <button
            className="remove"
            onClick={() => store.update((st) => st.project.noteSources!.splice(i, 1))}
          >
            ✕
          </button>
        </div>
      ))}
      {sources.length === 0 && (
        <div className="hint">
          Route a generator plugin's MIDI output into a synth instance — generative music driven by
          the plugin (and by RTPCs via param modulation below).
        </div>
      )}
    </div>
  );
}

/** RTPC -> CLAP parameter modulation (v3): game state drives plugin params. */
function ParamModSection() {
  const s = useStore();
  const mods = s.project.paramMods ?? [];
  const instName = (id: number) => {
    const inst = s.project.pluginInstances.find((i) => i.id === id);
    const bank = inst && s.project.plugins.find((p) => p.id === inst.pluginBankId);
    return `${bank?.name ?? '?'} #${id}`;
  };

  const add = () => {
    store.update((st) => {
      const inst = st.project.pluginInstances[0];
      const rtpc = st.project.rtpcs[0];
      if (!inst || !rtpc) {
        alert('Param modulation needs a plugin instance and an RTPC.');
        return;
      }
      st.project.paramMods ??= [];
      st.project.paramMods.push({
        instance: inst.id,
        param: 0,
        rtpc: rtpc.id,
        points: [
          { x: rtpc.min, y: 0 },
          { x: rtpc.max, y: 1 },
        ],
      });
    });
  };

  return (
    <div className="plugin-group">
      <div className="panel-subhead">
        <span title="Map an RTPC to a CLAP parameter with a curve, applied live every block">
          Param modulation
        </span>
        <button onClick={add}>＋ mod</button>
      </div>
      {mods.map((m, i) => (
        <div key={i} className="master-row">
          <select
            value={m.rtpc}
            title="Driving RTPC"
            onChange={(e) => store.update(() => (m.rtpc = Number(e.target.value)))}
          >
            {s.project.rtpcs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <span className="dim">→</span>
          <select
            value={m.instance}
            onChange={(e) => store.update(() => (m.instance = Number(e.target.value)))}
          >
            {s.project.pluginInstances.map((inst) => (
              <option key={inst.id} value={inst.id}>
                {instName(inst.id)}
              </option>
            ))}
          </select>
          <input
            className="num"
            type="number"
            title="CLAP param id"
            value={m.param}
            onChange={(e) => store.update(() => (m.param = Number(e.target.value) || 0))}
          />
          <input
            className="num"
            type="number"
            step={0.05}
            title="value at RTPC min"
            value={m.points[0]?.y ?? 0}
            onChange={(e) => store.update(() => (m.points[0].y = Number(e.target.value) || 0))}
          />
          <span className="dim">..</span>
          <input
            className="num"
            type="number"
            step={0.05}
            title="value at RTPC max"
            value={m.points[m.points.length - 1]?.y ?? 1}
            onChange={(e) =>
              store.update(() => (m.points[m.points.length - 1].y = Number(e.target.value) || 0))
            }
          />
          <button
            className="remove"
            onClick={() => store.update((st) => st.project.paramMods!.splice(i, 1))}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

export function PluginPanel() {
  return (
    <div className="panel plugins">
      <div className="panel-head">
        <span title="WebCLAP plugins: synths for instrument tracks and effects for the master bus">
          Plugins (WebCLAP)
        </span>
      </div>
      <div className="panel-body">
        <BankSection />
        <InstanceSection />
        <NoteSourceSection />
        <ParamModSection />
        <MasterSection />
      </div>
    </div>
  );
}
