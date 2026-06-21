/**
 * AudioWorklet processor source for IAM playback.
 *
 * Kept as a self-contained source string so hosts don't need to serve a
 * separate worklet file: the player registers it via a Blob URL. The compiled
 * engine module + extracted pack are passed through processorOptions, along with
 * (optionally) compiled WCLAP plugin modules and their routing.
 *
 * WCLAP plugins are hosted *in the worklet* (one worklet, minimum latency): the
 * engine renders the PCM mix and a sample-accurate MIDI stream, which is routed
 * into instrument synths and master effects here. AudioWorklet has no module
 * imports, so the small CLAP host below is inlined. Any plugin failure disables
 * the rack and falls back to engine PCM rather than breaking playback.
 */

export const IAM_PROCESSOR_NAME = 'iam-player-processor';

export const IAM_WORKLET_SOURCE = `
// --- inline WCLAP/CLAP host -------------------------------------------------
function uleb(n){const o=[];do{let b=n&0x7f;n>>>=7;if(n)b|=0x80;o.push(b);}while(n);return o;}
function buildTrampoline(){
  const types=[[[0x7f,0x7f],[0x7f]],[[0x7f],[]],[[0x7f],[0x7f]]];
  const fns=[['get_extension',0],['req_restart',1],['req_process',1],['req_callback',1],['inev_size',2],['inev_get',0],['outev_push',0]];
  const enc=new TextEncoder();
  const sec=(id,p)=>[id,...uleb(p.length),...p];
  let t=[...uleb(types.length)];for(const[p,r]of types){t.push(0x60,...uleb(p.length),...p,...uleb(r.length),...r);}
  let im=[...uleb(fns.length)];for(const[n,ti]of fns){const m=enc.encode('h'),nm=enc.encode(n);im.push(...uleb(m.length),...m,...uleb(nm.length),...nm,0,...uleb(ti));}
  let fn=[...uleb(fns.length)];for(const[,ti]of fns)fn.push(...uleb(ti));
  let ex=[...uleb(fns.length)];for(let i=0;i<fns.length;i++){const nm=enc.encode('t_'+fns[i][0]);ex.push(...uleb(nm.length),...nm,0,...uleb(fns.length+i));}
  let cd=[...uleb(fns.length)];for(let i=0;i<fns.length;i++){const np=types[fns[i][1]][0].length;let b=[0];for(let p=0;p<np;p++)b.push(0x20,...uleb(p));b.push(0x10,...uleb(i),0x0b);cd.push(...uleb(b.length),...b);}
  return new WebAssembly.Module(new Uint8Array([0,0x61,0x73,0x6d,1,0,0,0,...sec(1,t),...sec(2,im),...sec(3,fn),...sec(7,ex),...sec(10,cd)]));
}
function makeInstance(module, opts){
  const inst=new WebAssembly.Instance(module,{});
  const ex=inst.exports; if(ex._initialize)ex._initialize();
  const mem=ex.memory, table=ex.__indirect_function_table;
  const dv=()=>new DataView(mem.buffer);
  const malloc=(n)=>ex.malloc(n);
  const cstr=(s)=>{const b=new TextEncoder().encode(s);const p=malloc(b.length+1);new Uint8Array(mem.buffer,p,b.length+1).set([...b,0]);return p;};
  let inEventPtrs=[]; let events=[]; const activeNotes=new Set();
  const imports={h:{get_extension:()=>0,req_restart:()=>{},req_process:()=>{},req_callback:()=>{},inev_size:()=>inEventPtrs.length,inev_get:(c,i)=>inEventPtrs[i]||0,outev_push:()=>1}};
  const tramp=new WebAssembly.Instance(opts.trampoline,imports).exports;
  const order=['get_extension','req_restart','req_process','req_callback','inev_size','inev_get','outev_push'];
  const base=table.length; table.grow(order.length); const idx={};
  order.forEach((n,i)=>{table.set(base+i,tramp['t_'+n]);idx[n]=base+i;});
  const d=dv(), hostPtr=malloc(64);
  d.setUint32(hostPtr,1,true);d.setUint32(hostPtr+4,2,true);d.setUint32(hostPtr+8,2,true);d.setUint32(hostPtr+12,0,true);
  d.setUint32(hostPtr+16,cstr('iam'),true);d.setUint32(hostPtr+20,cstr('iam'),true);d.setUint32(hostPtr+24,cstr('-'),true);d.setUint32(hostPtr+28,cstr('1'),true);
  d.setUint32(hostPtr+32,idx.get_extension,true);d.setUint32(hostPtr+36,idx.req_restart,true);d.setUint32(hostPtr+40,idx.req_process,true);d.setUint32(hostPtr+44,idx.req_callback,true);
  const eg=ex.clap_entry, entryPtr=(typeof eg==='object')?eg.value:eg;
  table.get(dv().getUint32(entryPtr+12,true))(cstr('/wclap'));
  const facPtr=table.get(dv().getUint32(entryPtr+20,true))(cstr('clap.plugin-factory'));
  let pid=opts.clapPluginId;
  if(!pid){const desc=table.get(dv().getUint32(facPtr+4,true))(facPtr,0);const ip=dv().getUint32(desc+12,true);const u=new Uint8Array(mem.buffer);pid='';let q=ip;while(u[q])pid+=String.fromCharCode(u[q++]);}
  const plug=table.get(dv().getUint32(facPtr+8,true))(facPtr,hostPtr,cstr(pid));
  const pfn=(off)=>table.get(dv().getUint32(plug+off,true));
  pfn(8)(plug); pfn(16)(plug,opts.sampleRate,1,opts.maxFrames); pfn(24)(plug);
  const N=opts.maxFrames;
  const outL=malloc(N*4),outR=malloc(N*4),inL=malloc(N*4),inR=malloc(N*4);
  const outCh=malloc(8);dv().setUint32(outCh,outL,true);dv().setUint32(outCh+4,outR,true);
  const aOut=malloc(24);dv().setUint32(aOut,outCh,true);dv().setUint32(aOut+8,2,true);
  const inChP=malloc(8);dv().setUint32(inChP,inL,true);dv().setUint32(inChP+4,inR,true);
  const aIn=malloc(24);dv().setUint32(aIn,inChP,true);dv().setUint32(aIn+8,2,true);
  const inEv=malloc(12);dv().setUint32(inEv+4,idx.inev_size,true);dv().setUint32(inEv+8,idx.inev_get,true);
  const outEv=malloc(8);dv().setUint32(outEv+4,idx.outev_push,true);
  const POOL=512,STRIDE=48,evPool=malloc(POOL*STRIDE);
  const proc=malloc(64);
  dv().setUint32(proc+16,opts.audioInputs?aIn:0,true);dv().setUint32(proc+20,aOut,true);
  dv().setUint32(proc+24,opts.audioInputs,true);dv().setUint32(proc+28,1,true);
  dv().setUint32(proc+32,inEv,true);dv().setUint32(proc+36,outEv,true);
  function note(status,key,ch,vel,time){const e=new Uint8Array(40);const v=new DataView(e.buffer);v.setUint32(0,40,true);v.setUint32(4,time,true);v.setUint16(10,status,true);v.setInt32(16,-1,true);v.setInt16(22,ch,true);v.setInt16(24,key,true);v.setFloat64(32,vel,true);events.push({time,bytes:e});}
  function setParam(id,value,time){const e=new Uint8Array(48);const v=new DataView(e.buffer);v.setUint32(0,48,true);v.setUint32(4,time,true);v.setUint16(10,5,true);v.setUint32(16,id>>>0,true);v.setInt32(24,-1,true);v.setInt16(28,-1,true);v.setInt16(30,-1,true);v.setInt16(32,-1,true);v.setFloat64(40,value,true);events.push({time,bytes:e});}
  for(const p of (opts.params||[]))setParam(p.id,p.value,0);
  return {
    audioInputs:opts.audioInputs,
    noteOn:(k,ch,vel,t)=>{note(1,k,ch,vel,t);activeNotes.add(k|(ch<<8));},
    noteOff:(k,ch,t)=>{note(0,k,ch,0,t);activeNotes.delete(k|(ch<<8));},
    allNotesOff:(t)=>{for(const k of[...activeNotes]){note(0,k&0xff,(k>>8)&0xff,0,t);activeNotes.delete(k);}},
    setParam,
    process:(frames,iL,iR)=>{
      events.sort((a,b)=>a.time-b.time); inEventPtrs=[];
      const c=Math.min(events.length,POOL);
      for(let i=0;i<c;i++){const e=events[i];const ptr=evPool+i*STRIDE;const t=Math.min(Math.max(0,e.time),frames-1);new DataView(e.bytes.buffer).setUint32(4,t,true);new Uint8Array(mem.buffer,ptr,e.bytes.length).set(e.bytes);inEventPtrs.push(ptr);}
      events=[];
      if(opts.audioInputs&&iL&&iR){new Float32Array(mem.buffer,inL,frames).set(iL.subarray(0,frames));new Float32Array(mem.buffer,inR,frames).set(iR.subarray(0,frames));}
      dv().setUint32(proc+8,frames,true); pfn(36)(plug,proc);
      return {left:new Float32Array(mem.buffer,outL,frames),right:new Float32Array(mem.buffer,outR,frames)};
    }
  };
}

class IamProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ex = null;
    this.outPtr = 0;
    this.outCap = 0;
    this.eventPtr = 0;
    this.midiPtr = 0;
    this.tick = 0;
    this.rack = null;
    this.bufL = new Float32Array(128);
    this.bufR = new Float32Array(128);
    this.port.onmessage = (e) => this.onMessage(e.data);
    try {
      const { module, pack, plugins, routing } = options.processorOptions;
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
      this.midiPtr = ex.iam_alloc(16);
      this.ex = ex;
      if (plugins && plugins.length && ex.iam_poll_midi) {
        try { this.buildRack(plugins, routing); } catch (e) { this.rack = null; }
      }
      this.port.postMessage({ type: 'ready' });
    } catch (err) {
      this.port.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
  }

  buildRack(plugins, routing) {
    const trampoline = buildTrampoline();
    const map = new Map();
    for (const p of plugins) {
      const inst = makeInstance(p.module, {
        sampleRate, maxFrames: 128, clapPluginId: p.clapPluginId,
        params: p.params, audioInputs: p.audioInputs, trampoline,
      });
      map.set(p.instanceId, inst);
    }
    this.rack = { map, routing: routing || { instruments: [], masterEffects: [] } };
  }

  drainMidi() {
    const ex = this.ex;
    const out = [];
    const view = () => new DataView(ex.memory.buffer, this.midiPtr, 16);
    while (ex.iam_poll_midi(this.midiPtr) !== 0) {
      const v = view();
      out.push({
        instanceId: v.getUint32(0, true), frameOffset: v.getUint32(4, true),
        status: v.getUint8(8), key: v.getUint8(9), velocity: v.getFloat32(12, true),
      });
    }
    return out;
  }

  chain(effects, l, r, frames) {
    let cl = l, cr = r;
    for (const id of effects) {
      const fx = this.rack.map.get(id);
      if (!fx) continue;
      const o = fx.process(frames, cl, cr);
      cl = o.left; cr = o.right;
    }
    return { l: cl, r: cr };
  }

  mixRack(frames) {
    const L = this.bufL, R = this.bufR, rk = this.rack;
    // dispatch MIDI
    for (const e of this.drainMidi()) {
      if (e.status === 0 && e.instanceId === 0xffffffff) {
        for (const inst of rk.map.values()) inst.allNotesOff(e.frameOffset);
        continue;
      }
      const inst = rk.map.get(e.instanceId);
      if (!inst) continue;
      if (e.status === 1) inst.noteOn(e.key, 0, e.velocity, e.frameOffset);
      else if (e.status === 0) inst.noteOff(e.key, 0, e.frameOffset);
    }
    for (const ins of rk.routing.instruments) {
      const inst = rk.map.get(ins.instanceId);
      if (!inst) continue;
      const dry = inst.process(frames);
      const wet = this.chain(ins.effects, dry.left, dry.right, frames);
      for (let i = 0; i < frames; i++) { L[i] += wet.l[i]; R[i] += wet.r[i]; }
    }
    const m = this.chain(rk.routing.masterEffects, L, R, frames);
    if (m.l !== L) for (let i = 0; i < frames; i++) { L[i] = m.l[i]; R[i] = m.r[i]; }
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
    if (this.rack) {
      if (this.bufL.length < frames) { this.bufL = new Float32Array(frames); this.bufR = new Float32Array(frames); }
      const L = this.bufL, R = this.bufR;
      for (let i = 0; i < frames; i++) { L[i] = buf[i * 2]; R[i] = buf[i * 2 + 1]; }
      try {
        this.mixRack(frames);
        for (let i = 0; i < frames; i++) { l[i] = L[i]; if (out.length > 1) r[i] = R[i]; }
      } catch (e) {
        this.rack = null; // disable rack on error, fall back to PCM
        for (let i = 0; i < frames; i++) { l[i] = buf[i * 2]; if (out.length > 1) r[i] = buf[i * 2 + 1]; }
      }
    } else {
      for (let i = 0; i < frames; i++) {
        l[i] = buf[i * 2];
        if (out.length > 1) r[i] = buf[i * 2 + 1];
      }
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
