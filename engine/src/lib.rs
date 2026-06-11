//! Interactive Audio Module (IAM) engine — WASM C ABI surface.
//!
//! Host call order:
//!   1. ptr = iam_alloc(pack_len)        copy IAMP pack bytes into memory
//!   2. iam_load_pack(ptr, pack_len)     parse & take ownership of the pack
//!   3. iam_init(sample_rate, channels)  configure output (1 or 2 channels)
//!   4. iam_play() / iam_set_rtpc(..) / iam_trigger_cue(..)
//!   5. buf = iam_alloc(frames*ch*4); iam_process(buf, frames) per audio block
//!
//! All exports use only scalar arguments; no wasm-bindgen required.

mod pack;
mod runtime;
mod vm;

use runtime::Runtime;
use std::alloc::{alloc, dealloc, Layout};

pub const ABI_VERSION: u32 = 1;

struct State {
    pack_bytes: Option<Vec<u8>>,
    runtime: Option<Runtime>,
}

static mut STATE: State = State {
    pack_bytes: None,
    runtime: None,
};

#[allow(static_mut_refs)]
fn state() -> &'static mut State {
    // WASM (this build) is single-threaded; exclusive access is guaranteed
    // by the host calling convention.
    unsafe { &mut STATE }
}

#[no_mangle]
pub extern "C" fn iam_abi_version() -> u32 {
    ABI_VERSION
}

#[no_mangle]
pub extern "C" fn iam_alloc(size: u32) -> *mut u8 {
    if size == 0 {
        return core::ptr::null_mut();
    }
    unsafe { alloc(Layout::from_size_align_unchecked(size as usize, 8)) }
}

#[no_mangle]
pub extern "C" fn iam_free(ptr: *mut u8, size: u32) {
    if ptr.is_null() || size == 0 {
        return;
    }
    unsafe { dealloc(ptr, Layout::from_size_align_unchecked(size as usize, 8)) }
}

/// Returns 0 on success, negative error code on failure.
#[no_mangle]
pub extern "C" fn iam_load_pack(ptr: *const u8, len: u32) -> i32 {
    if ptr.is_null() || len == 0 {
        return -1;
    }
    let bytes = unsafe { core::slice::from_raw_parts(ptr, len as usize) }.to_vec();
    match pack::parse(&bytes) {
        Ok(_) => {
            let st = state();
            st.pack_bytes = Some(bytes);
            st.runtime = None;
            0
        }
        Err(e) => match e {
            pack::PackError::TooShort => -2,
            pack::PackError::BadMagic => -3,
            pack::PackError::BadVersion => -4,
            pack::PackError::Corrupt => -5,
            pack::PackError::MissingChunk => -6,
            pack::PackError::BadReference => -7,
        },
    }
}

/// Returns 0 on success. Must be called after `iam_load_pack`.
#[no_mangle]
pub extern "C" fn iam_init(sample_rate: u32, channels: u32) -> i32 {
    if sample_rate == 0 || !(1..=2).contains(&channels) {
        return -1;
    }
    let st = state();
    let Some(bytes) = &st.pack_bytes else {
        return -2;
    };
    let Ok(p) = pack::parse(bytes) else {
        return -3;
    };
    st.runtime = Some(Runtime::new(p, sample_rate, channels));
    0
}

fn rt() -> Option<&'static mut Runtime> {
    state().runtime.as_mut()
}

#[no_mangle]
pub extern "C" fn iam_play() {
    if let Some(r) = rt() {
        r.play();
    }
}

#[no_mangle]
pub extern "C" fn iam_play_section(section_id: u32, anchor_id: u32) {
    if let Some(r) = rt() {
        r.play_section(section_id, anchor_id);
    }
}

#[no_mangle]
pub extern "C" fn iam_stop(fade_ms: f32) {
    if let Some(r) = rt() {
        r.stop(fade_ms);
    }
}

#[no_mangle]
pub extern "C" fn iam_pause() {
    if let Some(r) = rt() {
        r.pause();
    }
}

#[no_mangle]
pub extern "C" fn iam_resume() {
    if let Some(r) = rt() {
        r.resume();
    }
}

#[no_mangle]
pub extern "C" fn iam_is_playing() -> u32 {
    rt().map(|r| r.is_playing() as u32).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn iam_process(out_ptr: *mut f32, frames: u32) {
    let Some(r) = rt() else {
        return;
    };
    if out_ptr.is_null() || frames == 0 {
        return;
    }
    let ch = if r.is_stereo() { 2 } else { 1 };
    let out =
        unsafe { core::slice::from_raw_parts_mut(out_ptr, frames as usize * ch) };
    r.process(out, frames as usize);
}

#[no_mangle]
pub extern "C" fn iam_trigger_cue(cue_id: u32) {
    if let Some(r) = rt() {
        r.trigger_cue(cue_id);
    }
}

#[no_mangle]
pub extern "C" fn iam_set_rtpc(rtpc_id: u32, value: f32) {
    if let Some(r) = rt() {
        r.set_rtpc(rtpc_id, value);
    }
}

#[no_mangle]
pub extern "C" fn iam_get_rtpc(rtpc_id: u32) -> f32 {
    rt().map(|r| r.get_rtpc(rtpc_id)).unwrap_or(0.0)
}

#[no_mangle]
pub extern "C" fn iam_set_rate(rate: f32) {
    if let Some(r) = rt() {
        r.set_rate(rate);
    }
}

#[no_mangle]
pub extern "C" fn iam_get_rate() -> f32 {
    rt().map(|r| r.rate()).unwrap_or(1.0)
}

#[no_mangle]
pub extern "C" fn iam_seek_beats(beats: f32) {
    if let Some(r) = rt() {
        r.seek_beats(beats);
    }
}

#[no_mangle]
pub extern "C" fn iam_set_seed(seed: u32) {
    if let Some(r) = rt() {
        r.set_seed(seed);
    }
}

#[no_mangle]
pub extern "C" fn iam_get_section() -> u32 {
    rt().map(|r| r.current_section()).unwrap_or(pack::NONE_ID)
}

#[no_mangle]
pub extern "C" fn iam_get_position_beats() -> f32 {
    rt().map(|r| r.position_beats()).unwrap_or(0.0)
}

#[no_mangle]
pub extern "C" fn iam_get_position_samples() -> f64 {
    rt().map(|r| r.position_samples()).unwrap_or(0.0)
}

/// Writes a 16-byte event record { u32 type, u32 a, u32 b, f32 c } to
/// `out_ptr` and returns 1, or returns 0 when the queue is empty.
#[no_mangle]
pub extern "C" fn iam_poll_event(out_ptr: *mut u8) -> u32 {
    let Some(r) = rt() else {
        return 0;
    };
    let Some(ev) = r.poll_event() else {
        return 0;
    };
    if out_ptr.is_null() {
        return 0;
    }
    unsafe {
        let p = out_ptr as *mut u32;
        p.write_unaligned(ev.ty);
        p.add(1).write_unaligned(ev.a);
        p.add(2).write_unaligned(ev.b);
        (p.add(3) as *mut f32).write_unaligned(ev.c);
    }
    1
}
