//! Braille-wireframe tetrahedron spinner for the 4-line loader.
//!
//! Each terminal cell is a 2x4 braille dot grid, so 4 lines give a 28x16 dot
//! canvas with square dot pitch. Hidden lines are culled via the convex-solid
//! rule (an edge is visible iff either adjacent face is front-facing).

use std::f32::consts::TAU;

pub(crate) const W: usize = 14; // spinner cells per line
pub(crate) const H: usize = 4;
const DW: usize = W * 2; // braille dot columns
const DH: usize = H * 4; // braille dot rows
const CAM: f32 = 7.0; // camera distance for perspective

// Regular tetrahedron, apex up, centroid at the origin, all 6 edges sqrt(3):
// base triangle of circumradius 1 at y = -sqrt(2)/4, apex at y = 3*sqrt(2)/4.
const APEX_Y: f32 = 1.060_660_2;
const BASE_Y: f32 = -0.353_553_4;

// Four triangular faces; order matches the EDGES adjacency below.
const FACES: [(usize, usize, usize); 4] = [
    (1, 2, 3), // base
    (0, 1, 2), // sides
    (0, 2, 3),
    (0, 3, 1),
];

// Each edge with its two adjacent faces (indices into FACES).
const EDGES: [(usize, usize, usize, usize); 6] = [
    (1, 2, 0, 1),
    (2, 3, 0, 2),
    (3, 1, 0, 3),
    (0, 1, 1, 3),
    (0, 2, 1, 2),
    (0, 3, 2, 3),
];

fn rotate(p: [f32; 3], rx: f32, ry: f32, rz: f32) -> [f32; 3] {
    let (sx, cx) = rx.sin_cos();
    let (sy, cy) = ry.sin_cos();
    let (sz, cz) = rz.sin_cos();
    // yaw (y axis), then pitch (x axis), then roll (z axis)
    let (x, y, z) = (p[0] * cy + p[2] * sy, p[1], -p[0] * sy + p[2] * cy);
    let (x, y, z) = (x, y * cx - z * sx, y * sx + z * cx);
    let (x, y, z) = (x * cz - y * sz, x * sz + y * cz, z);
    [x, y, z]
}

// Vert 0 is the apex; 1-3 the base triangle.
fn rotated_vertices(rx: f32, ry: f32, rz: f32) -> [[f32; 3]; 4] {
    let mut v = [[0.0f32; 3]; 4];
    v[0] = rotate([0.0, APEX_Y, 0.0], rx, ry, rz);
    for k in 0..3 {
        let a = k as f32 * TAU / 3.0;
        v[k + 1] = rotate([a.sin(), BASE_Y, a.cos()], rx, ry, rz);
    }
    v
}

fn sub3(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

// A face is visible when its outward normal points toward the camera.
fn face_visibility(v: &[[f32; 3]; 4]) -> [bool; 4] {
    let mut visible = [false; 4];
    for (fi, &(ia, ib, ic)) in FACES.iter().enumerate() {
        let (a, b, c) = (v[ia], v[ib], v[ic]);
        let e1 = sub3(b, a);
        let e2 = sub3(c, a);
        let mut n = cross(e1, e2);
        let center = [
            a[0] + (e1[0] + e2[0]) / 3.0,
            a[1] + (e1[1] + e2[1]) / 3.0,
            a[2] + (e1[2] + e2[2]) / 3.0,
        ];
        if dot(n, center) < 0.0 {
            n = [-n[0], -n[1], -n[2]];
        }
        visible[fi] = dot(n, [-center[0], -center[1], CAM - center[2]]) > 0.0;
    }
    visible
}

/// The four spinner lines at time `t` seconds: the tumble pose advances on
/// all three axes at different velocities. `ascii` draws the tetrahedron
/// with plain ASCII strokes, for consoles whose font has no braille block.
pub(crate) fn frame(t: f32, ascii: bool) -> [String; 4] {
    if ascii {
        return render_ascii(t);
    }
    render_wire(0.85 + t * 0.9, 1.0 + t * 2.0, 0.3 + t * 0.55, 7.2, 8.0)
}

// ASCII tetrahedron in sharp glyphs graded by depth: '#' near, '%' mid, '*'
// far, so edges receding from the camera visibly thin out. All three are
// full-cell characters, which keeps the shape connected where slope-matched
// strokes ('/', '|', '\') fall apart at this resolution. The pose spins
// about the vertical axis with a slight tilt instead of tumbling:
// 14x4 characters cannot keep arbitrary poses readable, a triangle
// silhouette with sweeping inner edges stays one. The tilt nutates a
// little (slow pitch and roll wobble) so the apex, which sits on the
// spin axis, does not render as a frozen pair of cells.
fn render_ascii(t: f32) -> [String; 4] {
    let v = rotated_vertices(
        0.18 + 0.12 * (t * 1.3).sin(),
        1.0 - t * 2.2,
        0.22 * (t * 0.9).sin(),
    );
    let visible = face_visibility(&v);

    const SX: f32 = 3.6; // cols per world unit
    const SY: f32 = 2.0; // rows per world unit, near half of SX for 1:2 cells
    const CC: f32 = W as f32 / 2.0; // center col
    const CR: f32 = 2.3; // center row
    const GLYPH: [char; 4] = [' ', '*', '%', '#'];

    // per cell, the densest rank of any edge crossing it: near edges win.
    // Edges step along their major axis, one cell per step, so every stroke
    // stays a single cell wide.
    let mut grid = [[0u8; W]; H];
    let mut mark = |c: i32, r: i32, z: f32| {
        if c < 0 || c >= W as i32 || r < 0 || r >= H as i32 {
            return;
        }
        let rank: u8 = if z > 0.35 {
            3
        } else if z > -0.35 {
            2
        } else {
            1
        };
        let cell = &mut grid[r as usize][c as usize];
        *cell = (*cell).max(rank);
    };
    for &(ia, ib, fa, fb) in EDGES.iter() {
        if !visible[fa] && !visible[fb] {
            continue;
        }
        let pr = |p: [f32; 3]| {
            let f = CAM / (CAM - p[2]);
            (p[0] * f * SX + CC, -p[1] * f * SY + CR)
        };
        let (x0, y0) = pr(v[ia]);
        let (x1, y1) = pr(v[ib]);
        let (z0, z1) = (v[ia][2], v[ib][2]);
        let (dx, dy) = (x1 - x0, y1 - y0);
        if dx == 0.0 && dy == 0.0 {
            continue;
        }
        if dy.abs() >= dx.abs() {
            let (lo, hi) = (y0.min(y1).floor() as i32, y0.max(y1).floor() as i32);
            for r in lo..=hi {
                let t = ((r as f32 + 0.5 - y0) / dy).clamp(0.0, 1.0);
                mark((x0 + dx * t).floor() as i32, r, z0 + (z1 - z0) * t);
            }
        } else {
            let (lo, hi) = (x0.min(x1).floor() as i32, x0.max(x1).floor() as i32);
            for c in lo..=hi {
                let t = ((c as f32 + 0.5 - x0) / dx).clamp(0.0, 1.0);
                mark(c, (y0 + dy * t).floor() as i32, z0 + (z1 - z0) * t);
            }
        }
    }
    std::array::from_fn(|r| grid[r].iter().map(|&g| GLYPH[g as usize]).collect())
}

// s: dots per world unit (braille dot pitch is square, so one scale for both
// axes). rc: dot row of the object center.
fn render_wire(rx: f32, ry: f32, rz: f32, s: f32, rc: f32) -> [String; 4] {
    let v = rotated_vertices(rx, ry, rz);
    let visible = face_visibility(&v);

    let mut dots = [[false; DW]; DH];
    for &(ia, ib, fa, fb) in EDGES.iter() {
        if !visible[fa] && !visible[fb] {
            continue;
        }
        const M: usize = 96;
        for m in 0..=M {
            let t = m as f32 / M as f32;
            let p = [
                v[ia][0] + (v[ib][0] - v[ia][0]) * t,
                v[ia][1] + (v[ib][1] - v[ia][1]) * t,
                v[ia][2] + (v[ib][2] - v[ia][2]) * t,
            ];
            let f = CAM / (CAM - p[2]);
            let sc = (p[0] * f * s + DW as f32 * 0.5).floor() as i32;
            let sr = (-p[1] * f * s + rc).floor() as i32;
            if sc < 0 || sc >= DW as i32 || sr < 0 || sr >= DH as i32 {
                continue;
            }
            dots[sr as usize][sc as usize] = true;
        }
    }

    // pack 2x4 dot blocks into braille characters
    const BITS: [[u32; 2]; 4] = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
    std::array::from_fn(|r| {
        let mut line = String::with_capacity(W * 4);
        for c in 0..W {
            let mut bits = 0u32;
            for dy in 0..4 {
                for dx in 0..2 {
                    if dots[r * 4 + dy][c * 2 + dx] {
                        bits |= BITS[dy][dx];
                    }
                }
            }
            line.push(if bits == 0 {
                ' '
            } else {
                char::from_u32(0x2800 + bits).unwrap()
            });
        }
        line
    })
}
