//! Cue VM: a tiny stack machine over f32 used for cue rule conditions.
//!
//! Opcodes (see docs/03_cue_vm_spec.md):
//!   0x01 PUSH    <f32>          push immediate
//!   0x02 RTPC    <u32 id>       push RTPC value (bool->0/1, enum->variant index)
//!   0x03 SPECIAL <u8 id>        push runtime value:
//!          0 current_section_id  1 position_beats  2 current_bar
//!          3 playing(0/1)        4 rand01          5 rate    6 time_sec
//!   0x10 ADD  0x11 SUB  0x12 MUL  0x13 DIV  0x14 NEG
//!   0x20 LT   0x21 LE   0x22 GT   0x23 GE   0x24 EQ   0x25 NE
//!   0x30 AND  0x31 OR   0x32 NOT
//!
//! Comparison/logical results are 1.0 or 0.0. Truthiness: |x| > 1e-9.
//! Errors (underflow, unknown opcode, truncated stream) evaluate to false.

pub const SPECIAL_SECTION: u8 = 0;
pub const SPECIAL_POSITION_BEATS: u8 = 1;
pub const SPECIAL_BAR: u8 = 2;
pub const SPECIAL_PLAYING: u8 = 3;
pub const SPECIAL_RAND: u8 = 4;
pub const SPECIAL_RATE: u8 = 5;
pub const SPECIAL_TIME: u8 = 6;

pub trait VmEnv {
    fn rtpc(&mut self, id: u32) -> f32;
    fn special(&mut self, id: u8) -> f32;
}

const MAX_STACK: usize = 64;
const EPS: f32 = 1e-9;

#[inline]
fn truthy(v: f32) -> bool {
    v.abs() > EPS
}

#[inline]
fn b2f(b: bool) -> f32 {
    if b {
        1.0
    } else {
        0.0
    }
}

/// Evaluates condition bytecode. An empty program is "always true".
pub fn eval(code: &[u8], env: &mut dyn VmEnv) -> bool {
    if code.is_empty() {
        return true;
    }
    match eval_value(code, env) {
        Some(v) => truthy(v),
        None => false,
    }
}

/// Evaluates value bytecode (v3 dynamic action parameters), returning the
/// single f32 left on the stack. Empty or malformed programs yield None.
pub fn eval_num(code: &[u8], env: &mut dyn VmEnv) -> Option<f32> {
    if code.is_empty() {
        return None;
    }
    eval_value(code, env)
}

fn eval_value(code: &[u8], env: &mut dyn VmEnv) -> Option<f32> {
    let mut stack = [0f32; MAX_STACK];
    let mut sp: usize = 0;
    let mut pc: usize = 0;

    macro_rules! push {
        ($v:expr) => {{
            if sp >= MAX_STACK {
                return None;
            }
            stack[sp] = $v;
            sp += 1;
        }};
    }
    macro_rules! pop {
        () => {{
            if sp == 0 {
                return None;
            }
            sp -= 1;
            stack[sp]
        }};
    }
    macro_rules! bin {
        ($f:expr) => {{
            let b = pop!();
            let a = pop!();
            let f = $f;
            push!(f(a, b));
        }};
    }

    while pc < code.len() {
        let op = code[pc];
        pc += 1;
        match op {
            0x01 => {
                if pc + 4 > code.len() {
                    return None;
                }
                let v = f32::from_le_bytes([code[pc], code[pc + 1], code[pc + 2], code[pc + 3]]);
                pc += 4;
                push!(v);
            }
            0x02 => {
                if pc + 4 > code.len() {
                    return None;
                }
                let id =
                    u32::from_le_bytes([code[pc], code[pc + 1], code[pc + 2], code[pc + 3]]);
                pc += 4;
                push!(env.rtpc(id));
            }
            0x03 => {
                if pc >= code.len() {
                    return None;
                }
                let id = code[pc];
                pc += 1;
                push!(env.special(id));
            }
            0x10 => bin!(|a: f32, b: f32| a + b),
            0x11 => bin!(|a: f32, b: f32| a - b),
            0x12 => bin!(|a: f32, b: f32| a * b),
            0x13 => bin!(|a: f32, b: f32| if b.abs() > EPS { a / b } else { 0.0 }),
            0x14 => {
                let a = pop!();
                push!(-a);
            }
            0x20 => bin!(|a: f32, b: f32| b2f(a < b)),
            0x21 => bin!(|a: f32, b: f32| b2f(a <= b)),
            0x22 => bin!(|a: f32, b: f32| b2f(a > b)),
            0x23 => bin!(|a: f32, b: f32| b2f(a >= b)),
            0x24 => bin!(|a: f32, b: f32| b2f((a - b).abs() <= EPS)),
            0x25 => bin!(|a: f32, b: f32| b2f((a - b).abs() > EPS)),
            0x30 => bin!(|a: f32, b: f32| b2f(truthy(a) && truthy(b))),
            0x31 => bin!(|a: f32, b: f32| b2f(truthy(a) || truthy(b))),
            0x32 => {
                let a = pop!();
                push!(b2f(!truthy(a)));
            }
            _ => return None,
        }
    }
    if sp == 1 {
        Some(stack[0])
    } else {
        None
    }
}
