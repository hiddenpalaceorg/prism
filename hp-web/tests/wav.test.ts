import { test } from "node:test";
import assert from "node:assert/strict";
import { wavBrowserPlayable, wavFormatTag } from "../src/lib/wav";

// Hand-rolled WAV headers: RIFF(size) WAVE, then chunks of id(4) size(4) data.

function chunk(id: string, data: Buffer): Buffer {
  const hdr = Buffer.alloc(8);
  hdr.write(id, 0, 4, "latin1");
  hdr.writeUInt32LE(data.length, 4);
  return Buffer.concat([hdr, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function riff(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from("WAVE", "latin1"), ...chunks]);
  const hdr = Buffer.alloc(8);
  hdr.write("RIFF", 0, 4, "latin1");
  hdr.writeUInt32LE(body.length, 4);
  return Buffer.concat([hdr, body]);
}

function fmt(tag: number): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt16LE(tag, 0); // wFormatTag
  b.writeUInt16LE(1, 2); // channels
  b.writeUInt32LE(44100, 4); // sample rate
  b.writeUInt32LE(88200, 8); // byte rate
  b.writeUInt16LE(2, 12); // block align
  b.writeUInt16LE(16, 14); // bits per sample
  return b;
}

/** WAVE_FORMAT_EXTENSIBLE fmt whose SubFormat GUID opens with `subTag`. */
function fmtExtensible(subTag: number): Buffer {
  const b = Buffer.alloc(40);
  b.writeUInt16LE(0xfffe, 0);
  b.writeUInt16LE(2, 2);
  b.writeUInt32LE(48000, 4);
  b.writeUInt32LE(384000, 8);
  b.writeUInt16LE(8, 12);
  b.writeUInt16LE(32, 14);
  b.writeUInt16LE(22, 16); // cbSize
  b.writeUInt16LE(32, 18); // valid bits per sample
  b.writeUInt32LE(0x3, 20); // channel mask
  b.writeUInt16LE(subTag, 24); // SubFormat GUID, leading format-tag bytes
  return b;
}

const data = chunk("data", Buffer.alloc(64));

test("wavFormatTag reads the fmt chunk's codec", () => {
  assert.equal(wavFormatTag(riff(chunk("fmt ", fmt(0x0001)), data)), 0x0001);
  assert.equal(wavFormatTag(riff(chunk("fmt ", fmt(0x0069)), data)), 0x0069);
  assert.equal(wavFormatTag(riff(chunk("fmt ", fmt(0x0011)), data)), 0x0011);
});

test("wavFormatTag resolves WAVE_FORMAT_EXTENSIBLE to its SubFormat", () => {
  assert.equal(wavFormatTag(riff(chunk("fmt ", fmtExtensible(0x0001)), data)), 0x0001);
  assert.equal(wavFormatTag(riff(chunk("fmt ", fmtExtensible(0x0002)), data)), 0x0002);
});

test("wavFormatTag skips leading chunks to find fmt", () => {
  const junk = chunk("LIST", Buffer.alloc(26, 0x20));
  assert.equal(wavFormatTag(riff(junk, chunk("fmt ", fmt(0x0069)), data)), 0x0069);
  // Odd-sized chunks are word-aligned, and the padding must not derail the walk.
  const odd = chunk("LIST", Buffer.alloc(7, 0x20));
  assert.equal(wavFormatTag(riff(odd, chunk("fmt ", fmt(0x0001)), data)), 0x0001);
});

test("wavFormatTag needs only the leading bytes of the file", () => {
  const whole = riff(chunk("fmt ", fmt(0x0069)), data);
  // Everything after the tag's two bytes (RIFF 12 + chunk header 8 + 2) is optional.
  assert.equal(wavFormatTag(whole.subarray(0, 22)), 0x0069);
});

test("wavFormatTag is null on non-WAVs and truncated headers", () => {
  assert.equal(wavFormatTag(Buffer.from("OggS....not a wav...")), null);
  assert.equal(wavFormatTag(Buffer.alloc(0)), null);
  const whole = riff(chunk("fmt ", fmt(0x0069)), data);
  assert.equal(wavFormatTag(whole.subarray(0, 21)), null); // fmt tag cut off
  assert.equal(wavFormatTag(riff(data)), null); // no fmt chunk at all
});

test("wavBrowserPlayable passes native codecs and unparseable heads only", () => {
  for (const tag of [0x0001, 0x0003, 0x0006, 0x0007]) {
    assert.equal(wavBrowserPlayable(riff(chunk("fmt ", fmt(tag)), data)), true, `tag ${tag}`);
  }
  assert.equal(wavBrowserPlayable(riff(chunk("fmt ", fmt(0x0069)), data)), false); // Xbox ADPCM
  assert.equal(wavBrowserPlayable(riff(chunk("fmt ", fmt(0x0011)), data)), false); // IMA ADPCM
  assert.equal(wavBrowserPlayable(riff(chunk("fmt ", fmt(0x0002)), data)), false); // MS ADPCM
  assert.equal(wavBrowserPlayable(riff(chunk("fmt ", fmtExtensible(0x0002)), data)), false);
  // Unparseable falls back to serving the raw bytes.
  assert.equal(wavBrowserPlayable(Buffer.from("garbage")), true);
});

test("wavFormatTag parses a real Xbox ADPCM header", () => {
  // The opening bytes of an actual Xbox build's WAV (Hunter, mc3ec01.wav).
  const head = Buffer.from(
    "52494646684f010057415645666d7420" +
      "140000006900010044ac0000e6600000" +
      "240004000200400064617461404f0100",
    "hex"
  );
  assert.equal(wavFormatTag(head), 0x0069);
  assert.equal(wavBrowserPlayable(head), false);
});
