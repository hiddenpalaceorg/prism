import assert from "node:assert/strict";
import { test } from "node:test";
import { selectBuildOgImages } from "../src/lib/build-og";

test("selectBuildOgImages selects up to three front media first", () => {
  assert.deepEqual(
    selectBuildOgImages(
      [
        { image: "front-1", label: "front" },
        { image: "front-2", label: "front" },
        { image: "front-3", label: "front" },
        { image: "insert", label: "other" },
      ],
      ["asset"],
    ),
    ["front-1", "front-2", "front-3"],
  );
});

test("selectBuildOgImages uses one insert before image assets", () => {
  assert.deepEqual(
    selectBuildOgImages(
      [
        { image: "insert-1", label: "other" },
        { image: "front", label: "front" },
        { image: "insert-2", label: null },
      ],
      ["asset-1", "asset-2"],
    ),
    ["front", "insert-1", "asset-1"],
  );
});

test("selectBuildOgImages never selects back media", () => {
  assert.deepEqual(
    selectBuildOgImages(
      [
        { image: "back", label: "back" },
        { image: "insert", label: "other" },
      ],
      ["asset-1", "asset-2"],
    ),
    ["insert", "asset-1", "asset-2"],
  );
});
