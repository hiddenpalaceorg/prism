import { test } from "node:test";
import assert from "node:assert/strict";
import { writePsdBuffer } from "ag-psd";
import { PNG } from "pngjs";
import { psdConvertible, psdToPng } from "../src/lib/psd";

// Fixtures are generated with ag-psd's writer: a layered 4x4 document whose
// composite (the flattened frame Photoshop embeds) is solid red over blue.

function rgba(w: number, h: number, [r, g, b, a]: number[]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return { width: w, height: h, data };
}

function layeredPsd({ withComposite = true } = {}) {
  return {
    width: 4,
    height: 4,
    children: [
      { name: "bg", top: 0, left: 0, bottom: 4, right: 4, imageData: rgba(4, 4, [0, 0, 255, 255]) },
      { name: "fg", top: 0, left: 0, bottom: 2, right: 2, imageData: rgba(2, 2, [255, 0, 0, 255]) },
      { name: "off", hidden: true, top: 2, left: 2, bottom: 4, right: 4, imageData: rgba(2, 2, [0, 255, 0, 255]) },
    ],
    ...(withComposite ? { imageData: rgba(4, 4, [255, 0, 0, 255]) } : {}),
  };
}

test("psdConvertible covers exactly the photoshop mime", () => {
  assert.equal(psdConvertible("image/vnd.adobe.photoshop"), true);
  assert.equal(psdConvertible("image/png"), false);
  assert.equal(psdConvertible("application/pdf"), false);
});

test("psdToPng decodes the embedded composite", () => {
  const bytes = Buffer.from(writePsdBuffer(layeredPsd()));
  const png = PNG.sync.read(psdToPng(bytes));
  assert.equal(png.width, 4);
  assert.equal(png.height, 4);
  assert.deepEqual([...png.data.subarray(0, 4)], [255, 0, 0, 255]);
});

test("psdToPng re-flattens visible layers when the composite is missing", () => {
  const bytes = Buffer.from(writePsdBuffer(layeredPsd({ withComposite: false })));
  const png = PNG.sync.read(psdToPng(bytes));
  // fg (red) covers the top-left quadrant, bg (blue) the rest; the hidden
  // layer must not paint its green quadrant.
  assert.deepEqual([...png.data.subarray(0, 4)], [255, 0, 0, 255]);
  const bottomRight = ((3 * png.width + 3) * 4);
  assert.deepEqual([...png.data.subarray(bottomRight, bottomRight + 4)], [0, 0, 255, 255]);
});

test("psdToPng throws on junk input", () => {
  assert.throws(() => psdToPng(Buffer.from("not a psd at all")));
});

// --- CMYK (hand-rolled path: ag-psd refuses mode 4) --------------------------

/** Minimal 8-bit CMYK PSD: raw-compression composite + optional layer stack.
 *  Channel values are stored Photoshop-style, i.e. inverted (255 = no ink). */
function cmykPsd({
  width,
  height,
  composite,
  layers = [],
}: {
  width: number;
  height: number;
  /** [C,M,Y,K] stored (inverted) values for a solid composite. */
  composite: number[];
  layers?: {
    name: string;
    top: number;
    left: number;
    rows: number;
    cols: number;
    cmyk: number[]; // stored (inverted) solid fill
    alpha?: number;
    opacity?: number;
    hidden?: boolean;
  }[];
}): Buffer {
  const u16 = (n: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(n);
    return b;
  };
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const i32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n);
    return b;
  };

  const records: Buffer[] = [];
  const channelData: Buffer[] = [];
  for (const l of layers) {
    const plane = l.rows * l.cols;
    const chLen = 2 + plane; // compression header + raw bytes
    const ids = [-1, 0, 1, 2, 3];
    const name = Buffer.from(l.name, "latin1");
    const pascal = Buffer.concat([Buffer.from([name.length]), name]);
    const pad = (pascal.length % 4 ? 4 - (pascal.length % 4) : 0);
    const extra = Buffer.concat([u32(0), u32(0), pascal, Buffer.alloc(pad)]);
    records.push(
      Buffer.concat([
        i32(l.top), i32(l.left), i32(l.top + l.rows), i32(l.left + l.cols),
        u16(ids.length),
        ...ids.map((id) => Buffer.concat([u16(id & 0xffff), u32(chLen)])),
        Buffer.from("8BIMnorm", "latin1"),
        Buffer.from([l.opacity ?? 255, 0, l.hidden ? 2 : 0, 0]),
        u32(extra.length),
        extra,
      ])
    );
    const values: Record<number, number> = {
      [-1]: l.alpha ?? 255, 0: l.cmyk[0], 1: l.cmyk[1], 2: l.cmyk[2], 3: l.cmyk[3],
    };
    for (const id of ids) {
      channelData.push(Buffer.concat([u16(0), Buffer.alloc(plane, values[id])]));
    }
  }

  let layerInfo = Buffer.alloc(0);
  if (layers.length > 0) {
    const body = Buffer.concat([u16(layers.length), ...records, ...channelData]);
    layerInfo = Buffer.concat([u32(body.length), body]);
  }
  const layerSection = Buffer.concat([u32(layerInfo.length), layerInfo]);

  const plane = width * height;
  const image = Buffer.concat([
    u16(0),
    ...composite.map((v) => Buffer.alloc(plane, v)),
  ]);

  return Buffer.concat([
    Buffer.from("8BPS", "latin1"), u16(1), Buffer.alloc(6),
    u16(4), u32(height), u32(width), u16(8), u16(4),
    u32(0), // color mode data
    u32(0), // image resources
    layerSection,
    image,
  ]);
}

const pixel = (png: ReturnType<typeof PNG.sync.read>, x: number, y: number) => [
  ...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3),
];

test("psdToPng converts a flattened CMYK composite", () => {
  // Solid blue: C+M full ink, no Y, no K → stored (inverted) [0,0,255,255].
  const png = PNG.sync.read(psdToPng(cmykPsd({ width: 3, height: 2, composite: [0, 0, 255, 255] })));
  assert.equal(png.width, 3);
  assert.deepEqual(pixel(png, 1, 1), [0, 0, 255]);
});

test("psdToPng flattens visible CMYK layers and honors hidden ones", () => {
  const png = PNG.sync.read(
    psdToPng(
      cmykPsd({
        width: 4,
        height: 4,
        composite: [255, 255, 255, 255], // blank white, as saved without compat
        layers: [
          { name: "red", top: 0, left: 0, rows: 2, cols: 2, cmyk: [255, 0, 0, 255] },
          { name: "off", top: 2, left: 2, rows: 2, cols: 2, cmyk: [0, 255, 255, 255], hidden: true },
        ],
      })
    )
  );
  assert.deepEqual(pixel(png, 0, 0), [255, 0, 0]); // visible layer painted
  assert.deepEqual(pixel(png, 3, 3), [255, 255, 255]); // hidden layer did not
});

test("psdToPng flattens an all-hidden CMYK stack as if visible", () => {
  // The corpus's press files: blank composite AND every layer hidden — the
  // flatten must reveal the artwork anyway.
  const png = PNG.sync.read(
    psdToPng(
      cmykPsd({
        width: 2,
        height: 2,
        composite: [255, 255, 255, 255],
        layers: [{ name: "art", top: 0, left: 0, rows: 2, cols: 2, cmyk: [255, 0, 0, 255], hidden: true }],
      })
    )
  );
  assert.deepEqual(pixel(png, 0, 0), [255, 0, 0]);
});
