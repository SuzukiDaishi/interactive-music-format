/**
 * AudioWorklet processor source for IAM playback.
 *
 * Kept as a self-contained source string so hosts don't need to serve a
 * separate worklet file: the player registers it via a Blob URL. The
 * compiled WebAssembly.Module and the extracted pack bytes are passed in
 * through processorOptions (both are structured-cloneable).
 */

export const IAM_PROCESSOR_NAME = 'iam-player-processor';

export const IAM_WORKLET_SOURCE = `
class IamProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ex = null;
    this.outPtr = 0;
    this.outCap = 0;
    this.eventPtr = 0;
    this.tick = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
    try {
      const { module, pack } = options.processorOptions;
      const instance = new WebAssembly.Instance(module, {});
      const ex = instance.exports;
      const ptr = ex.iam_alloc(pack.length);
      new Uint8Array(ex.memory.buffer, ptr, pack.length).set(pack);
      const rc = ex.iam_load_pack(ptr, pack.length);
      ex.iam_free(ptr, pack.length);
      if (rc !== 0) throw new Error('iam_load_pack failed: ' + rc);
      const rc2 = ex.iam_init(sampleRate, 2);
      if (rc2 !== 0) throw new Error('iam_init failed: ' + rc2);
      this.eventPtr = ex.iam_alloc(16);
      this.ex = ex;
      this.port.postMessage({ type: 'ready' });
    } catch (err) {
      this.port.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
  }

  onMessage(m) {
    const ex = this.ex;
    if (!ex) return;
    switch (m.type) {
      case 'play': ex.iam_play(); break;
      case 'playSection': ex.iam_play_section(m.section >>> 0, m.anchor >>> 0); break;
      case 'stop': ex.iam_stop(m.fadeMs || 0); break;
      case 'pause': ex.iam_pause(); break;
      case 'resume': ex.iam_resume(); break;
      case 'rate': ex.iam_set_rate(m.value); break;
      case 'seek': ex.iam_seek_beats(m.beats); break;
      case 'seed': ex.iam_set_seed(m.value >>> 0); break;
      case 'rtpc': ex.iam_set_rtpc(m.id >>> 0, m.value); break;
      case 'cue': ex.iam_trigger_cue(m.id >>> 0); break;
    }
  }

  process(inputs, outputs) {
    const ex = this.ex;
    const out = outputs[0];
    if (!ex || out.length === 0) return true;
    const frames = out[0].length;
    const need = frames * 2 * 4;
    if (need > this.outCap) {
      if (this.outPtr) ex.iam_free(this.outPtr, this.outCap);
      this.outCap = need;
      this.outPtr = ex.iam_alloc(need);
    }
    ex.iam_process(this.outPtr, frames);
    const buf = new Float32Array(ex.memory.buffer, this.outPtr, frames * 2);
    const l = out[0];
    const r = out.length > 1 ? out[1] : out[0];
    for (let i = 0; i < frames; i++) {
      l[i] = buf[i * 2];
      if (out.length > 1) r[i] = buf[i * 2 + 1];
    }
    // Drain events + send a status tick roughly every 8 blocks (~21ms).
    let events = null;
    const view = () => new DataView(ex.memory.buffer, this.eventPtr, 16);
    while (ex.iam_poll_event(this.eventPtr) !== 0) {
      const v = view();
      if (!events) events = [];
      events.push({
        type: v.getUint32(0, true),
        a: v.getUint32(4, true),
        b: v.getUint32(8, true),
        c: v.getFloat32(12, true),
      });
    }
    this.tick++;
    if (events || this.tick % 8 === 0) {
      this.port.postMessage({
        type: 'tick',
        events: events || [],
        section: ex.iam_get_section() >>> 0,
        beats: ex.iam_get_position_beats(),
        playing: ex.iam_is_playing() !== 0,
        rate: ex.iam_get_rate(),
      });
    }
    return true;
  }
}
registerProcessor('${IAM_PROCESSOR_NAME}', IamProcessor);
`;
