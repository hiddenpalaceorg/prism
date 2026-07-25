import { test } from "node:test";
import assert from "node:assert/strict";
import { inferMediaLabel, isMediaKind, isMediaLabel, sniffMedia } from "../src/lib/media";

test("inferMediaLabel reads the front/back convention out of filenames", () => {
  assert.equal(inferMediaLabel("Earthworm Jim Front.png"), "front");
  assert.equal(inferMediaLabel("Earthworm Jim Sega Genesis ROM Image Back.png"), "back");
  assert.equal(inferMediaLabel("front.jpg"), "front");
  assert.equal(inferMediaLabel("FRONT COVER.png"), "front");
  assert.equal(inferMediaLabel("disc_front_scan.png"), "front");
  assert.equal(inferMediaLabel("back-of-case.jpg"), "back");
});

test("inferMediaLabel does not fire inside larger words", () => {
  assert.equal(inferMediaLabel("backyard.png"), "other");
  assert.equal(inferMediaLabel("frontier-demo.png"), "other");
  assert.equal(inferMediaLabel("IMG_2041.jpg"), "other");
});

test("inferMediaLabel prefers front when a name carries both words", () => {
  assert.equal(inferMediaLabel("front and back.png"), "front");
});

test("media kind and label guards accept only known values", () => {
  assert.equal(isMediaKind("physical"), true);
  assert.equal(isMediaKind("photo"), false);
  assert.equal(isMediaLabel("front"), true);
  assert.equal(isMediaLabel("side"), false);
  assert.equal(isMediaLabel(null), false);
});

test("sniffMedia identifies the accepted containers by magic bytes", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.deepEqual(sniffMedia(png), { contentType: "image/png", video: false });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(sniffMedia(jpeg), { contentType: "image/jpeg", video: false });
  assert.equal(sniffMedia(Buffer.from("not an image at all!")), null);
});
