import { useEffect, useRef } from 'react';
import { usePreview, preview } from '../preview';

export function EventLog() {
  const pv = usePreview();
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [pv.log.length]);

  return (
    <div className="panel log">
      <div className="panel-head">
        <span>Events</span>
        <button onClick={() => preview.clearLog()}>clear</button>
      </div>
      <div className="panel-body log-body" ref={bodyRef}>
        {pv.error && <div className="expr-error">{pv.error}</div>}
        {pv.log.map((e, i) => (
          <div key={i} className="log-line">
            <span className="dim">{e.time}</span> {e.text}
          </div>
        ))}
        {pv.log.length === 0 && !pv.error && (
          <div className="hint">Engine events (transitions, cues, loops…) appear here during preview.</div>
        )}
      </div>
    </div>
  );
}
