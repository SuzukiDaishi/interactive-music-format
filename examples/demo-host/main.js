// Minimal host: treats a .iam.wasm as "just an audio file" with knobs.
// Serve the repository root with any static file server, e.g.
//   npx serve .
// then open /examples/demo-host/.
import { IamPlayer } from '@iam/player';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const log = (s) => {
  logEl.textContent += s + '\n';
  logEl.scrollTop = logEl.scrollHeight;
};

let ctx = null;
let player = null;

async function loadBytes(bytes, name) {
  if (!ctx) ctx = new AudioContext();
  await ctx.resume();
  if (player) {
    player.stop(0);
    player.dispose();
  }
  player = await IamPlayer.load(bytes, ctx);
  player.node.connect(ctx.destination);
  $('title').textContent = `${player.meta.name} (${name})`;
  $('ui').style.display = '';
  log(`loaded '${player.meta.name}' — sections: ${player.meta.sections.map((s) => s.name).join(', ')}`);

  player.onEvent((e) => {
    if (e.kind === 'sectionChanged') log(`♪ section ${e.fromName ?? '∅'} → ${e.toName}`);
    else if (e.kind === 'ended') log('■ ended');
    else if (e.kind === 'emit') log(`✦ emit(${e.a})`);
    else if (e.kind === 'looped') log(`↻ loop ${e.name}`);
  });
  player.onStatus((s) => {
    $('status').textContent = `${s.sectionName ?? '—'} · beat ${s.positionBeats.toFixed(1)}`;
  });

  // Build RTPC controls from module metadata — the host doesn't need to
  // know anything about the music's internals.
  const box = $('rtpcs');
  box.innerHTML = '';
  for (const r of player.meta.rtpcs) {
    const label = document.createElement('label');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = r.name;
    label.appendChild(name);
    if (r.type === 'enum') {
      const sel = document.createElement('select');
      r.variants.forEach((v, i) => sel.add(new Option(v, i)));
      sel.value = String(r.default);
      sel.onchange = () => player.setRtpc(r.name, Number(sel.value));
      label.appendChild(sel);
    } else if (r.type === 'bool') {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = r.default >= 0.5;
      cb.onchange = () => player.setRtpc(r.name, cb.checked);
      label.appendChild(cb);
    } else {
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = r.min;
      slider.max = r.max;
      slider.step = (r.max - r.min) / 200 || 0.01;
      slider.value = r.default;
      const val = document.createElement('span');
      val.textContent = Number(r.default).toFixed(2);
      slider.oninput = () => {
        player.setRtpc(r.name, Number(slider.value));
        val.textContent = Number(slider.value).toFixed(2);
      };
      label.appendChild(slider);
      label.appendChild(val);
    }
    box.appendChild(label);
  }
}

$('load-demo').onclick = async () => {
  try {
    const res = await fetch('../out/adventure_demo.iam.wasm');
    if (!res.ok) throw new Error(`${res.status} — run 'npm run demo' first`);
    await loadBytes(new Uint8Array(await res.arrayBuffer()), 'adventure_demo.iam.wasm');
  } catch (e) {
    log(`load failed: ${e.message}`);
  }
};

const drop = $('drop');
drop.ondragover = (e) => e.preventDefault();
drop.ondrop = async (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) await loadBytes(new Uint8Array(await f.arrayBuffer()), f.name);
};

$('play').onclick = () => player?.play();
$('stop').onclick = () => player?.stop(400);
$('end').onclick = () => {
  try {
    player?.triggerCue('to_ending');
    log('cue ⇒ to_ending (music will finish musically)');
  } catch {
    log('this module has no to_ending cue');
  }
};
$('rate').oninput = (e) => {
  const v = Number(e.target.value);
  player?.setRate(v);
  $('rateval').textContent = `${v.toFixed(2)}×`;
};
