//! TGA (Truevision Targa) → BMP conversion.
//!
//! Stock Windows has no TGA handler, so the Windows GUI stages TGA image
//! assets as 32bpp BMP before handing them to the shell. Covers what game
//! dumps carry: 8bpp grayscale and color-mapped, 15/16bpp, 24/32bpp, raw and
//! RLE, either vertical origin.

/// Refuse to decode absurd dimensions (decode allocates width*height*4 up
/// front, and headers are attacker-controlled bytes). Matches the web
/// converter's cap (web/src/lib/imgpng.ts).
const MAX_PIXELS: u32 = 32_000_000;

struct Decoded {
    width: usize,
    height: usize,
    /// RGBA, row 0 = top.
    data: Vec<u8>,
}

/// Expand a 5-bit channel to 8 bits by bit replication.
fn scale5(c: u16) -> u8 {
    ((c << 3) | (c >> 2)) as u8
}

/// One pixel or palette entry in the file's layout → RGBA. Formats without an
/// alpha channel yield 0 — decode() flips an all-zero alpha plane to opaque.
fn unpack(p: &[u8], bits: u8) -> [u8; 4] {
    match bits {
        15 | 16 => {
            let v = u16::from_le_bytes([p[0], p[1]]);
            [scale5(v >> 10 & 31), scale5(v >> 5 & 31), scale5(v & 31), 0]
        }
        24 => [p[2], p[1], p[0], 0],
        _ => [p[2], p[1], p[0], p[3]], // 32
    }
}

fn decode(b: &[u8]) -> Result<Decoded, String> {
    if b.len() < 18 {
        return Err("not a TGA".into());
    }
    let id_len = b[0] as usize;
    let cmap_type = b[1];
    let image_type = b[2];
    let cmap_first = u16::from_le_bytes([b[3], b[4]]) as usize;
    let cmap_len = u16::from_le_bytes([b[5], b[6]]) as usize;
    let cmap_bits = b[7];
    let width = u16::from_le_bytes([b[12], b[13]]) as u32;
    let height = u16::from_le_bytes([b[14], b[15]]) as u32;
    let depth = b[16];
    let desc = b[17];

    if cmap_type > 1 || !matches!(image_type, 1 | 2 | 3 | 9 | 10 | 11) {
        return Err("not a TGA".into());
    }
    if !matches!(depth, 8 | 15 | 16 | 24 | 32) {
        return Err(format!("unsupported TGA depth {depth}"));
    }
    if width == 0 || height == 0 || width * height > MAX_PIXELS {
        return Err(format!("TGA dimensions out of range: {width}x{height}"));
    }
    let color_mapped = matches!(image_type, 1 | 9);
    let gray = matches!(image_type, 3 | 11);
    if color_mapped && (cmap_type != 1 || depth != 8) {
        return Err("unsupported color-mapped TGA layout".into());
    }

    let mut off = 18 + id_len;

    // The palette rides along even when a truecolor image merely carries one;
    // decode entries to RGBA only when pixels actually index into it.
    let mut palette: Vec<[u8; 4]> = Vec::new();
    if cmap_type == 1 {
        if !matches!(cmap_bits, 15 | 16 | 24 | 32) {
            return Err(format!("unsupported TGA palette depth {cmap_bits}"));
        }
        let entry_bytes = (cmap_bits as usize).div_ceil(8);
        let end = off + cmap_len * entry_bytes;
        if end > b.len() {
            return Err("truncated TGA".into());
        }
        if color_mapped {
            palette = (0..cmap_len)
                .map(|i| unpack(&b[off + i * entry_bytes..], cmap_bits))
                .collect();
        }
        off = end;
    }

    let bpp = (depth as usize).div_ceil(8);
    let count = (width * height) as usize;

    // Bound the up-front allocation: a valid stream must carry at least this many
    // bytes of pixel data, so a tiny (18-byte) header can't force a huge zero-fill
    // before the pixel loop ever validates the stream — a decode-bomb guard. RLE
    // encodes at best 128 pixels per packet (1 header byte + one pixel's bytes).
    let avail = b.len().checked_sub(off).ok_or("truncated TGA")?;
    let min_bytes = if image_type >= 9 {
        count.div_ceil(128) * (1 + bpp)
    } else {
        count * bpp
    };
    if avail < min_bytes {
        return Err("truncated TGA".into());
    }

    let mut px = vec![0u8; count * 4]; // RGBA in file scan order

    let to_rgba = |p: &[u8]| -> Result<[u8; 4], String> {
        if color_mapped {
            let idx = (p[0] as usize)
                .checked_sub(cmap_first)
                .and_then(|i| palette.get(i))
                .ok_or("TGA palette index out of range")?;
            Ok(*idx)
        } else if gray {
            Ok([p[0], p[0], p[0], 0])
        } else {
            Ok(unpack(p, depth))
        }
    };

    if image_type >= 9 {
        // RLE: header byte per packet — bit 7 = run, low 7 bits = count-1.
        let mut i = 0;
        while i < count {
            let hdr = *b.get(off).ok_or("truncated TGA")?;
            off += 1;
            let n = (hdr as usize & 0x7f) + 1;
            if i + n > count {
                return Err("corrupt TGA RLE stream".into());
            }
            if hdr & 0x80 != 0 {
                let rgba = to_rgba(b.get(off..off + bpp).ok_or("truncated TGA")?)?;
                off += bpp;
                for j in i..i + n {
                    px[j * 4..j * 4 + 4].copy_from_slice(&rgba);
                }
            } else {
                for j in i..i + n {
                    let rgba = to_rgba(b.get(off..off + bpp).ok_or("truncated TGA")?)?;
                    off += bpp;
                    px[j * 4..j * 4 + 4].copy_from_slice(&rgba);
                }
            }
            i += n;
        }
    } else {
        for j in 0..count {
            let rgba = to_rgba(b.get(off..off + bpp).ok_or("truncated TGA")?)?;
            off += bpp;
            px[j * 4..j * 4 + 4].copy_from_slice(&rgba);
        }
    }

    // Alpha-less formats decode with alpha 0 everywhere; that means opaque,
    // not an invisible image (same convention as the web BMP converter).
    if px.iter().skip(3).step_by(4).all(|&a| a == 0) {
        px.iter_mut().skip(3).step_by(4).for_each(|a| *a = 255);
    }

    // Reorder scan lines to top-down; descriptor bit 5 = top origin,
    // bit 4 = right-to-left.
    let (w, h) = (width as usize, height as usize);
    let top_origin = desc & 0x20 != 0;
    let right_to_left = desc & 0x10 != 0;
    let mut data = vec![0u8; count * 4];
    for row in 0..h {
        let y = if top_origin { row } else { h - 1 - row };
        for col in 0..w {
            let x = if right_to_left { w - 1 - col } else { col };
            let src = (row * w + col) * 4;
            let dst = (y * w + x) * 4;
            data[dst..dst + 4].copy_from_slice(&px[src..src + 4]);
        }
    }
    Ok(Decoded { width: w, height: h, data })
}

/// Decode a TGA and re-encode as a 32bpp bottom-up BMP. Errors on malformed
/// input — callers fall back to staging the raw file.
pub fn tga_to_bmp(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let img = decode(bytes)?;
    let row_bytes = img.width * 4; // 32bpp rows need no padding
    let pixel_bytes = row_bytes * img.height;
    let mut out = Vec::with_capacity(54 + pixel_bytes);
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&((54 + pixel_bytes) as u32).to_le_bytes());
    out.extend_from_slice(&[0; 4]); // reserved
    out.extend_from_slice(&54u32.to_le_bytes()); // pixel data offset
    out.extend_from_slice(&40u32.to_le_bytes()); // BITMAPINFOHEADER
    out.extend_from_slice(&(img.width as i32).to_le_bytes());
    out.extend_from_slice(&(img.height as i32).to_le_bytes()); // positive = bottom-up
    out.extend_from_slice(&1u16.to_le_bytes()); // planes
    out.extend_from_slice(&32u16.to_le_bytes()); // bpp
    out.extend_from_slice(&0u32.to_le_bytes()); // BI_RGB
    out.extend_from_slice(&(pixel_bytes as u32).to_le_bytes());
    out.extend_from_slice(&[0; 16]); // ppm + palette counts, all zero
    for y in (0..img.height).rev() {
        let row = &img.data[y * row_bytes..(y + 1) * row_bytes];
        for p in row.chunks_exact(4) {
            out.extend_from_slice(&[p[2], p[1], p[0], p[3]]);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 18-byte header for a bare truecolor TGA.
    fn header(image_type: u8, w: u16, h: u16, depth: u8, desc: u8) -> Vec<u8> {
        let mut hd = vec![0u8; 18];
        hd[2] = image_type;
        hd[12..14].copy_from_slice(&w.to_le_bytes());
        hd[14..16].copy_from_slice(&h.to_le_bytes());
        hd[16] = depth;
        hd[17] = desc;
        hd
    }

    /// BGRA pixel at (x, y from top) of a 32bpp bottom-up BMP.
    fn bmp_px(bmp: &[u8], w: usize, h: usize, x: usize, y: usize) -> [u8; 4] {
        let o = 54 + ((h - 1 - y) * w + x) * 4;
        [bmp[o], bmp[o + 1], bmp[o + 2], bmp[o + 3]]
    }

    #[test]
    fn raw_24bpp_bottom_origin() {
        // 2x2, bottom origin: file rows are bottom-up. Top-left ends up red.
        let mut tga = header(2, 2, 2, 24, 0);
        tga.extend_from_slice(&[
            0, 255, 0, 255, 255, 255, // bottom row: green, white (BGR)
            0, 0, 255, 255, 0, 0, // top row: red, blue
        ]);
        let bmp = tga_to_bmp(&tga).unwrap();
        assert_eq!(&bmp[..2], b"BM");
        assert_eq!(bmp_px(&bmp, 2, 2, 0, 0), [0, 0, 255, 255]); // red
        assert_eq!(bmp_px(&bmp, 2, 2, 1, 0), [255, 0, 0, 255]); // blue
        assert_eq!(bmp_px(&bmp, 2, 2, 0, 1), [0, 255, 0, 255]); // green
    }

    #[test]
    fn rle_32bpp_top_origin_alpha() {
        // 3x1 RLE, top origin: a run of two half-transparent reds + one literal blue.
        let mut tga = header(10, 3, 1, 32, 0x20);
        tga.extend_from_slice(&[0x81, 0, 0, 255, 128, 0x00, 255, 0, 0, 255]);
        let bmp = tga_to_bmp(&tga).unwrap();
        assert_eq!(bmp_px(&bmp, 3, 1, 0, 0), [0, 0, 255, 128]);
        assert_eq!(bmp_px(&bmp, 3, 1, 1, 0), [0, 0, 255, 128]);
        assert_eq!(bmp_px(&bmp, 3, 1, 2, 0), [255, 0, 0, 255]);
    }

    #[test]
    fn color_mapped_8bpp() {
        // 2x1 indexed: palette entry 0 = magenta, 1 = cyan (24-bit BGR entries).
        let mut tga = header(1, 2, 1, 8, 0x20);
        tga[1] = 1; // color map present
        tga[5..7].copy_from_slice(&2u16.to_le_bytes());
        tga[7] = 24;
        tga.extend_from_slice(&[255, 0, 255, 255, 255, 0]);
        tga.extend_from_slice(&[0, 1]);
        let bmp = tga_to_bmp(&tga).unwrap();
        assert_eq!(bmp_px(&bmp, 2, 1, 0, 0), [255, 0, 255, 255]); // magenta
        assert_eq!(bmp_px(&bmp, 2, 1, 1, 0), [255, 255, 0, 255]); // cyan
    }

    #[test]
    fn sixteen_bpp_scaling() {
        // 1x1, 16bpp ARGB1555 pure white — 5-bit channels must scale to 255.
        let mut tga = header(2, 1, 1, 16, 0x20);
        tga.extend_from_slice(&0x7fffu16.to_le_bytes());
        let bmp = tga_to_bmp(&tga).unwrap();
        assert_eq!(bmp_px(&bmp, 1, 1, 0, 0), [255, 255, 255, 255]);
    }

    #[test]
    fn rejects_garbage() {
        assert!(tga_to_bmp(b"not a tga at all").is_err());
        let mut huge = header(2, 65535, 65535, 24, 0);
        huge.extend_from_slice(&[0; 3]);
        assert!(tga_to_bmp(&huge).is_err());
        // Truncated pixel data.
        let short = header(2, 4, 4, 24, 0);
        assert!(tga_to_bmp(&short).is_err());
    }

    #[test]
    fn rle_bomb_rejected_before_alloc() {
        // Large (but under the pixel cap) RLE dimensions with almost no data:
        // must be rejected up front, not zero-fill a huge buffer first.
        let mut bomb = header(10, 4000, 4000, 24, 0);
        bomb.extend_from_slice(&[0x80, 1, 2, 3]); // one packet, nowhere near enough
        assert!(tga_to_bmp(&bomb).is_err());
    }
}
