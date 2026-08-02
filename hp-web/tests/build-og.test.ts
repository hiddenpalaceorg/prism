import assert from "node:assert/strict";
import { test } from "node:test";
import { selectBuildOgImages } from "../src/lib/build-og";

test("selectBuildOgImages selects up to four front media first", () => {
  assert.deepEqual(
    selectBuildOgImages(
      [
        { image: "front-1", label: "front" },
        { image: "front-2", label: "front" },
        { image: "front-3", label: "front" },
        { image: "front-4", label: "front" },
        { image: "insert", label: "other" },
      ],
      ["asset"],
    ),
    ["front-1", "front-2", "front-3", "front-4"],
  );
});

test("selectBuildOgImages places a sleeve after front media and before assets", () => {
  assert.deepEqual(
    selectBuildOgImages(
      [
        { image: "sleeve", label: "other" },
        { image: "front", label: "front" },
        { image: "other-media", label: null },
      ],
      ["asset-1", "asset-2"],
    ),
    ["front", "sleeve", "asset-1", "asset-2"],
  );
});

test("selectBuildOgImages never selects back media", () => {
  assert.deepEqual(
    selectBuildOgImages(
      [
        { image: "back", label: "back" },
        { image: "insert", label: "other" },
      ],
      ["asset-1", "asset-2", "asset-3"],
    ),
    ["insert", "asset-1", "asset-2", "asset-3"],
  );
});
