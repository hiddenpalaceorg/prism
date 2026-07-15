import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { bmpToPng, pngConvertible, WEB_SAFE_IMAGE } from "../src/lib/imgpng";

// Hand-crafted 2x1 24bpp BMP: left pixel pure red, right pixel pure blue
// (rows are BGR on disk, padded to 4 bytes) — pins the ABGR→RGBA swizzle.
function tinyBmp(): Buffer {
  const row = Buffer.from([0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0, 0]);
  const dib = Buffer.alloc(40);
  dib.writeUInt32LE(40, 0); // header size
  dib.writeInt32LE(2, 4); // width
  dib.writeInt32LE(1, 8); // height
  dib.writeUInt16LE(1, 12); // planes
  dib.writeUInt16LE(24, 14); // bpp
  dib.writeUInt32LE(row.length, 20); // image size
  const hdr = Buffer.alloc(14);
  hdr.write("BM");
  hdr.writeUInt32LE(14 + 40 + row.length, 2);
  hdr.writeUInt32LE(54, 10); // pixel data offset
  return Buffer.concat([hdr, dib, row]);
}

test("bmpToPng keeps channel order and makes 24bpp opaque", () => {
  const png = PNG.sync.read(bmpToPng(tinyBmp()));
  assert.equal(png.width, 2);
  assert.equal(png.height, 1);
  assert.deepEqual([...png.data.subarray(0, 4)], [255, 0, 0, 255]); // red, opaque
  assert.deepEqual([...png.data.subarray(4, 8)], [0, 0, 255, 255]); // blue, opaque
});

// 2x1 32bpp BMP with a 124-byte V5 header and standard-mask BI_BITFIELDS
// (what sips/Photoshop write) — pins the header normalization: bmp-js alone
// mis-decodes these by reading extended-header bytes as pixels.
function tinyBmpV5(): Buffer {
  const row = Buffer.from([0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0x00, 0xff]); // BGRA: red, blue
  const dib = Buffer.alloc(124);
  dib.writeUInt32LE(124, 0); // V5 header size
  dib.writeInt32LE(2, 4); // width
  dib.writeInt32LE(1, 8); // height
  dib.writeUInt16LE(1, 12); // planes
  dib.writeUInt16LE(32, 14); // bpp
  dib.writeUInt32LE(3, 16); // BI_BITFIELDS
  dib.writeUInt32LE(row.length, 20);
  dib.writeUInt32LE(0xff0000, 40); // R mask
  dib.writeUInt32LE(0xff00, 44); // G mask
  dib.writeUInt32LE(0xff, 48); // B mask
  dib.writeUInt32LE(0xff000000, 52); // A mask
  const hdr = Buffer.alloc(14);
  hdr.write("BM");
  hdr.writeUInt32LE(14 + 124 + row.length, 2);
  hdr.writeUInt32LE(14 + 124, 10); // pixel data offset past the V5 header
  return Buffer.concat([hdr, dib, row]);
}

test("bmpToPng handles V5-header bitfields BMPs (sips/Photoshop output)", () => {
  const png = PNG.sync.read(bmpToPng(tinyBmpV5()));
  assert.equal(png.width, 2);
  assert.deepEqual([...png.data.subarray(0, 4)], [255, 0, 0, 255]); // red
  assert.deepEqual([...png.data.subarray(4, 8)], [0, 0, 255, 255]); // blue
});

test("bmpToPng rejects exotic channel masks", () => {
  const weird = tinyBmpV5();
  weird.writeUInt32LE(0xf800, 14 + 40); // RGB565-style red mask
  assert.throws(() => bmpToPng(weird), /masks/);
});

test("bmpToPng throws on garbage and absurd dimensions", () => {
  assert.throws(() => bmpToPng(Buffer.from("not a bmp")));
  const huge = tinyBmp();
  huge.writeInt32LE(1_000_000, 18); // width
  huge.writeInt32LE(1_000_000, 22); // height
  assert.throws(() => bmpToPng(huge), /dimensions/);
});

test("web-safe and convertible mime classification", () => {
  for (const m of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
    assert.ok(WEB_SAFE_IMAGE.test(m), m);
  }
  for (const m of ["image/bmp", "image/x-icon", "image/svg+xml", "image/tiff"]) {
    assert.ok(!WEB_SAFE_IMAGE.test(m), m);
  }
  assert.ok(pngConvertible("image/bmp"));
  assert.ok(!pngConvertible("image/x-icon"));
  assert.ok(!pngConvertible("image/svg+xml"));
});
