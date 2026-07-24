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
