import { useStore, store } from '../store';
import { preview } from '../preview';
import {
  Binding,
  BindingTrigger,
  checkExpression,
  Cue,
  CueAction,
  TimingName,
} from '@iam/pack';

const TIMINGS: TimingName[] = ['immediate', 'nextBeat', 'nextBar', 'sectionEnd'];

function SectionSelect({
  value,
  onChange,
  allowNull,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  allowNull?: boolean;
}) {
  const s = useStore();
  return (
    <select
      value={value === null ? 'null' : value}
      onChange={(e) => onChange(e.target.value === 'null' ? null : Number(e.target.value))}
    >
      {allowNull && <option value="null">any</option>}
      {s.project.sections.map((sec) => (
        <option key={sec.id} value={sec.id}>
          {sec.name}
        </option>
      ))}
    </select>
  );
}

function AnchorSelect({
  sectionId,
  value,
  onChange,
}: {
  sectionId: number;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  const s = useStore();
  const sec = s.project.sections.find((x) => x.id === sectionId);
  return (
    <select
      value={value === null ? 'null' : value}
      onChange={(e) => onChange(e.target.value === 'null' ? null : Number(e.target.value))}
    >
      <option value="null">start</option>
      {(sec?.anchors ?? []).map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );
}

function TimingSelect({ value, onChange }: { value: TimingName; onChange: (t: TimingName) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as TimingName)}>
      {TIMINGS.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

function defaultAction(type: CueAction['type']): CueAction {
  const firstSection = store.project.sections[0]?.id ?? 0;
  switch (type) {
    case 'goto':
      return {
        type,
        section: firstSection,
        anchor: null,
        timing: 'nextBar',
        transition: 'crossfade',
        fadeMs: 300,
      };
    case 'gotoRandom':
      return {
        type,
        timing: 'nextBar',
        transition: 'crossfade',
        fadeMs: 300,
        targets: [{ section: firstSection, anchor: null, weight: 1 }],
      };
    case 'play':
      return { type, section: firstSection, anchor: null };
    case 'stop':
      return { type, timing: 'sectionEnd', fadeMs: 300 };
    case 'setTrackGain':
      return {
        type,
        section: firstSection,
        track: store.project.sections[0]?.tracks[0]?.id ?? 0,
        gain: 1,
        fadeMs: 300,
      };
    case 'setLoop':
      return { type, section: firstSection, enabled: false };
    case 'emit':
      return { type, code: 0 };
    case 'setRtpc':
      return { type, rtpc: store.project.rtpcs[0]?.id ?? 0, value: 0 };
    case 'oneShot':
      return { type, asset: [...store.assets.keys()][0] ?? 0, gain: 1, timing: 'immediate' };
  }
}

function ActionEditor({ action, onRemove }: { action: CueAction; onRemove: () => void }) {
  const s = useStore();
  const u = (fn: () => void) => store.update(fn);
  return (
    <div className="action-row">
      <span className="action-type">{action.type}</span>
      {action.type === 'goto' && (
        <>
          <SectionSelect value={action.section} onChange={(v) => u(() => (action.section = v ?? 0))} />
          <AnchorSelect
            sectionId={action.section}
            value={action.anchor}
            onChange={(v) => u(() => (action.anchor = v))}
          />
          <TimingSelect value={action.timing} onChange={(v) => u(() => (action.timing = v))} />
          <select
            value={action.transition}
            onChange={(e) => u(() => (action.transition = e.target.value as 'cut' | 'crossfade'))}
          >
            <option value="cut">cut</option>
            <option value="crossfade">crossfade</option>
          </select>
          {action.transition === 'crossfade' && (
            <input
              className="num"
              type="number"
              min={0}
              title="fade ms"
              value={action.fadeMs}
              onChange={(e) => u(() => (action.fadeMs = Number(e.target.value) || 0))}
            />
          )}
        </>
      )}
      {action.type === 'gotoRandom' && (
        <div className="stack">
          <div>
            <TimingSelect value={action.timing} onChange={(v) => u(() => (action.timing = v))} />
            <select
              value={action.transition}
              onChange={(e) => u(() => (action.transition = e.target.value as 'cut' | 'crossfade'))}
            >
              <option value="cut">cut</option>
              <option value="crossfade">crossfade</option>
            </select>
            <input
              className="num"
              type="number"
              min={0}
              title="fade ms"
              value={action.fadeMs}
              onChange={(e) => u(() => (action.fadeMs = Number(e.target.value) || 0))}
            />
            <button
              onClick={() =>
                u(() =>
                  action.targets.push({
                    section: store.project.sections[0]?.id ?? 0,
                    anchor: null,
                    weight: 1,
                  }),
                )
              }
            >
              ＋ target
            </button>
          </div>
          {action.targets.map((t, i) => (
            <div key={i}>
              <SectionSelect value={t.section} onChange={(v) => u(() => (t.section = v ?? 0))} />
              <AnchorSelect
                sectionId={t.section}
                value={t.anchor}
                onChange={(v) => u(() => (t.anchor = v))}
              />
              <input
                className="num"
                type="number"
                min={0}
                step={0.1}
                title="weight"
                value={t.weight}
                onChange={(e) => u(() => (t.weight = Number(e.target.value) || 0))}
              />
              <button onClick={() => u(() => action.targets.splice(i, 1))}>✕</button>
            </div>
          ))}
        </div>
      )}
      {action.type === 'play' && (
        <>
          <SectionSelect value={action.section} onChange={(v) => u(() => (action.section = v ?? 0))} />
          <AnchorSelect
            sectionId={action.section}
            value={action.anchor}
            onChange={(v) => u(() => (action.anchor = v))}
          />
        </>
      )}
      {action.type === 'stop' && (
        <>
          <TimingSelect value={action.timing} onChange={(v) => u(() => (action.timing = v))} />
          <input
            className="num"
            type="number"
            min={0}
            title="fade ms"
            value={action.fadeMs}
            onChange={(e) => u(() => (action.fadeMs = Number(e.target.value) || 0))}
          />
        </>
      )}
      {action.type === 'setTrackGain' && (
        <>
          <SectionSelect value={action.section} onChange={(v) => u(() => (action.section = v ?? 0))} />
          <select
            value={action.track}
            onChange={(e) => u(() => (action.track = Number(e.target.value)))}
          >
            {(s.project.sections.find((x) => x.id === action.section)?.tracks ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <input
            className="num"
            type="number"
            min={0}
            step={0.05}
            title="gain"
            value={action.gain}
            onChange={(e) => u(() => (action.gain = Number(e.target.value) || 0))}
          />
          <input
            className="num"
            type="number"
            min={0}
            title="fade ms"
            value={action.fadeMs}
            onChange={(e) => u(() => (action.fadeMs = Number(e.target.value) || 0))}
          />
        </>
      )}
      {action.type === 'setLoop' && (
        <>
          <SectionSelect value={action.section} onChange={(v) => u(() => (action.section = v ?? 0))} />
          <label className="mini">
            <input
              type="checkbox"
              checked={action.enabled}
              onChange={(e) => u(() => (action.enabled = e.target.checked))}
            />
            loop
          </label>
        </>
      )}
      {action.type === 'emit' && (
        <input
          className="num"
          type="number"
          title="event code"
          value={action.code}
          onChange={(e) => u(() => (action.code = Number(e.target.value) || 0))}
        />
      )}
      {action.type === 'setRtpc' && (
        <>
          <select
            value={action.rtpc}
            onChange={(e) => u(() => (action.rtpc = Number(e.target.value)))}
          >
            {s.project.rtpcs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <input
            className="num"
            type="number"
            step={0.05}
            value={action.value}
            onChange={(e) => u(() => (action.value = Number(e.target.value) || 0))}
          />
        </>
      )}
      {action.type === 'oneShot' && (
        <>
          <select
            value={action.asset}
            onChange={(e) => u(() => (action.asset = Number(e.target.value)))}
          >
            {[...s.assets.values()].map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <input
            className="num"
            type="number"
            min={0}
            step={0.05}
            title="gain"
            value={action.gain}
            onChange={(e) => u(() => (action.gain = Number(e.target.value) || 0))}
          />
          <TimingSelect value={action.timing} onChange={(v) => u(() => (action.timing = v))} />
        </>
      )}
      <button className="remove" onClick={onRemove}>
        ✕
      </button>
    </div>
  );
}

function BindingEditor({ binding, onRemove }: { binding: Binding; onRemove: () => void }) {
  const s = useStore();
  const u = (fn: () => void) => store.update(fn);
  const t = binding.trigger;

  const setType = (type: BindingTrigger['type']) => {
    u(() => {
      const firstSection = s.project.sections[0]?.id ?? 0;
      switch (type) {
        case 'rtpcChanged':
          binding.trigger = { type, rtpc: s.project.rtpcs[0]?.id ?? 0 };
          break;
        case 'sectionStart':
        case 'sectionEnd':
        case 'bar':
        case 'beat':
          binding.trigger = { type, section: null };
          break;
        case 'anchorReached':
          binding.trigger = {
            type,
            section: firstSection,
            anchor: s.project.sections[0]?.anchors[0]?.id ?? 0,
          };
          break;
        case 'moduleStart':
          binding.trigger = { type };
          break;
      }
    });
  };

  return (
    <div className="binding-row">
      <select value={t.type} onChange={(e) => setType(e.target.value as BindingTrigger['type'])}>
        <option value="rtpcChanged">RTPC changed</option>
        <option value="sectionStart">section start</option>
        <option value="sectionEnd">section end</option>
        <option value="anchorReached">anchor reached</option>
        <option value="bar">every bar</option>
        <option value="beat">every beat</option>
        <option value="moduleStart">module start</option>
      </select>
      {t.type === 'rtpcChanged' && (
        <select value={t.rtpc} onChange={(e) => u(() => (t.rtpc = Number(e.target.value)))}>
          {s.project.rtpcs.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      )}
      {(t.type === 'sectionStart' || t.type === 'sectionEnd' || t.type === 'bar' || t.type === 'beat') && (
        <SectionSelect allowNull value={t.section} onChange={(v) => u(() => (t.section = v))} />
      )}
      {t.type === 'anchorReached' && (
        <>
          <SectionSelect value={t.section} onChange={(v) => u(() => (t.section = v ?? 0))} />
          <select value={t.anchor} onChange={(e) => u(() => (t.anchor = Number(e.target.value)))}>
            {(s.project.sections.find((x) => x.id === t.section)?.anchors ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </>
      )}
      <span className="dim">→</span>
      <select
        value={binding.cue}
        onChange={(e) => u(() => (binding.cue = Number(e.target.value)))}
      >
        {s.project.cues.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <button className="remove" onClick={onRemove}>
        ✕
      </button>
    </div>
  );
}

export function CuePanel() {
  const s = useStore();
  const cue: Cue | null = s.project.cues.find((c) => c.id === s.selectedCueId) ?? null;

  const addCue = () => {
    store.update((st) => {
      const id = st.nextCueId();
      st.project.cues.push({
        id,
        name: `cue_${id}`,
        rules: [{ condition: '', stopIfMatched: true, actions: [] }],
      });
      st.selectedCueId = id;
    });
  };

  return (
    <div className="panel cues">
      <div className="panel-head">
        <span>Cues & Triggers</span>
        <button onClick={addCue}>＋</button>
      </div>
      <div className="panel-body">
        <div className="cue-tabs">
          {s.project.cues.map((c) => (
            <button
              key={c.id}
              className={`cue-tab ${s.selectedCueId === c.id ? 'selected' : ''}`}
              onClick={() => store.touch((st) => (st.selectedCueId = c.id))}
            >
              {c.name}
            </button>
          ))}
        </div>
        {cue && (
          <div className="cue-editor">
            <div className="cue-row">
              <input
                value={cue.name}
                onChange={(e) => store.update(() => (cue.name = e.target.value))}
              />
              <button onClick={() => preview.triggerCue(cue.name)} title="Fire this cue in the running preview">
                ⚡ Trigger
              </button>
              <button
                onClick={() => {
                  if (!confirm(`Delete cue '${cue.name}'?`)) return;
                  store.update((st) => {
                    st.project.cues = st.project.cues.filter((c) => c.id !== cue.id);
                    st.project.bindings = st.project.bindings.filter((b) => b.cue !== cue.id);
                    st.selectedCueId = st.project.cues[0]?.id ?? null;
                  });
                }}
              >
                ✕
              </button>
            </div>
            {cue.rules.map((rule, ri) => {
              const err = checkExpression(rule.condition, s.project);
              return (
                <div key={ri} className="rule">
                  <div className="rule-head">
                    <span className="dim">if</span>
                    <input
                      className={`cond ${err ? 'error' : ''}`}
                      placeholder="always (e.g. intensity >= 0.7 && section != 'Battle_High')"
                      value={rule.condition}
                      onChange={(e) => store.update(() => (rule.condition = e.target.value))}
                    />
                    <label className="mini" title="Stop evaluating further rules when this matches">
                      <input
                        type="checkbox"
                        checked={rule.stopIfMatched}
                        onChange={(e) => store.update(() => (rule.stopIfMatched = e.target.checked))}
                      />
                      stop
                    </label>
                    <button onClick={() => store.update(() => cue.rules.splice(ri, 1))}>✕</button>
                  </div>
                  {err && <div className="expr-error">{err}</div>}
                  {rule.actions.map((a, ai) => (
                    <ActionEditor
                      key={ai}
                      action={a}
                      onRemove={() => store.update(() => rule.actions.splice(ai, 1))}
                    />
                  ))}
                  <div className="add-action">
                    <select
                      value=""
                      onChange={(e) => {
                        const t = e.target.value as CueAction['type'];
                        if (t) store.update(() => rule.actions.push(defaultAction(t)));
                      }}
                    >
                      <option value="">＋ action…</option>
                      <option value="goto">goto</option>
                      <option value="gotoRandom">goto (random)</option>
                      <option value="play">play section</option>
                      <option value="stop">stop</option>
                      <option value="setTrackGain">set track gain</option>
                      <option value="setLoop">set loop</option>
                      <option value="oneShot">one-shot</option>
                      <option value="setRtpc">set RTPC</option>
                      <option value="emit">emit event</option>
                    </select>
                  </div>
                </div>
              );
            })}
            <button
              onClick={() =>
                store.update(() => cue.rules.push({ condition: '', stopIfMatched: true, actions: [] }))
              }
            >
              ＋ rule
            </button>
          </div>
        )}
        <div className="bindings">
          <div className="panel-subhead">
            <span>Trigger bindings</span>
            <button
              disabled={s.project.cues.length === 0}
              onClick={() =>
                store.update((st) =>
                  st.project.bindings.push({
                    trigger: { type: 'moduleStart' },
                    cue: st.selectedCueId ?? st.project.cues[0].id,
                  }),
                )
              }
            >
              ＋
            </button>
          </div>
          {s.project.bindings.map((b, i) => (
            <BindingEditor
              key={i}
              binding={b}
              onRemove={() => store.update((st) => st.project.bindings.splice(i, 1))}
            />
          ))}
          {s.project.bindings.length === 0 && (
            <div className="hint">
              Bindings connect triggers (RTPC change, section end, anchors…) to cues. Cues can also
              be fired manually by the host.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
