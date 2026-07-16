"use client";

// Compact SoundCloud-style audio embed: play/pause button + peak-bar waveform
// with click-to-seek. Computing peaks needs the whole file (Web Audio decodes
// full buffers only), so the decode is lazy: when the embed scrolls into view
// for small files, or on first play. The decode fetch warms the browser's HTTP
// cache — blobs are immutable — so the <audio> element's own load is free.
// Files whose codec the browser can't decode still play natively if possible;
// the waveform just stays a flat placeholder.

import { useCallback, useEffect, useRef, useState } from "react";
import { assetUrl, humanSize, type ViewableAsset } from "./AssetViewer";
import { useOpenAsset } from "./AssetViewerHost";

const BARS = 160;
// Auto-decode on scroll-into-view only below this size, so a page of embeds
// can't pull tens of MB unasked; bigger files decode on first play.
const AUTO_DECODE_MAX = 8 * 1024 * 1024;

const PLAYED = "#0ea5e9"; // sky-500 — legible on light and dark
const UNPLAYED = "rgba(148, 163, 184, 0.45)"; // slate-400 @ 45%

function computePeaks(buf: AudioBuffer, bars: number): Float32Array {
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const out = new Float32Array(bars);
  const per = Math.max(1, Math.floor(ch0.length / bars));
  for (let i = 0; i < bars; i++) {
    const start = i * per;
    const end = Math.min(start + per, ch0.length);
    // Stride-sample the bucket — an exact max over millions of samples per bar
    // buys nothing visually.
    const stride = Math.max(1, Math.floor((end - start) / 512));
    let peak = 0;
    for (let j = start; j < end; j += stride) {
      const v = Math.abs(ch1 ? (ch0[j] + ch1[j]) / 2 : ch0[j]);
      if (v > peak) peak = v;
    }
    out[i] = peak;
  }
  let max = 0;
  for (const v of out) if (v > max) max = v;
  if (max > 0) for (let i = 0; i < out.length; i++) out[i] /= max;
  return out;
}

function fmtTime(s: number): string {
  if (!isFinite(s)) return "–:––";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export default function AudioEmbed({ asset }: { asset: ViewableAsset }) {
  const url = assetUrl(asset);
  const openAsset = useOpenAsset();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const peaksRef = useRef<Float32Array | null>(null);
  const progressRef = useRef(0); // 0..1 played fraction
  const pendingSeekRef = useRef<number | null>(null); // fraction, applied once metadata arrives
  const decodeStartedRef = useRef(false);

  const [playing, setPlaying] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [time, setTime] = useState(0);
  const [failed, setFailed] = useState(false);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const peaks = peaksRef.current;
    const progress = progressRef.current;
    const gap = 1;
    const bw = Math.max(1, w / BARS - gap);
    for (let i = 0; i < BARS; i++) {
      // Flat mid-height placeholder until real peaks arrive.
      const p = peaks ? peaks[i] : 0.25;
      const bh = Math.max(2, p * (h - 2));
      ctx.fillStyle = (i + 0.5) / BARS <= progress ? PLAYED : UNPLAYED;
      ctx.fillRect((i * w) / BARS, (h - bh) / 2, bw, bh);
    }
  }, []);

  const decode = useCallback(async () => {
    if (decodeStartedRef.current) return;
    decodeStartedRef.current = true;
    setDecoding(true);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      // OfflineAudioContext decodes without tripping autoplay policies.
      const ctx = new OfflineAudioContext(1, 1, 44100);
      const audioBuf = await ctx.decodeAudioData(buf);
      peaksRef.current = computePeaks(audioBuf, BARS);
      setDuration((d) => d ?? audioBuf.duration);
    } catch {
      // Codec the browser can't decode (or fetch hiccup): keep the placeholder
      // bars — native playback may still work.
    } finally {
      setDecoding(false);
      draw();
    }
  }, [url, draw]);

  // Small files build their waveform when scrolled into view.
  useEffect(() => {
    if (asset.size > AUTO_DECODE_MAX) return;
    const el = rootRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        obs.disconnect();
        void decode();
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [asset.size, decode]);

  // Redraw on resize; initial draw renders the placeholder.
  useEffect(() => {
    draw();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const obs = new ResizeObserver(() => draw());
    obs.observe(canvas);
    return () => obs.disconnect();
  }, [draw]);

  // Progress sweep while playing, off React state (state only for the m:ss label).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const a = audioRef.current;
      if (a && isFinite(a.duration) && a.duration > 0) {
        progressRef.current = a.currentTime / a.duration;
        setTime((t) => (Math.floor(a.currentTime) === Math.floor(t) ? t : a.currentTime));
        draw();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, draw]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      void decode();
      void a.play().catch(() => setFailed(true));
    } else {
      a.pause();
    }
  };

  const seek = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const a = audioRef.current;
    if (!canvas || !a) return;
    const rect = canvas.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    if (isFinite(a.duration) && a.duration > 0) {
      a.currentTime = frac * a.duration;
      progressRef.current = frac;
      draw();
    } else {
      // Metadata not loaded yet: remember the spot and start playback to get it.
      pendingSeekRef.current = frac;
      toggle();
    }
  };

  const name = asset.path.split("/").pop() || asset.path;

  return (
    <div
      ref={rootRef}
      className="flex items-center gap-2.5 rounded border border-neutral-200 px-2.5 py-1.5 dark:border-neutral-800"
    >
      <button
        onClick={toggle}
        aria-label={playing ? `Pause ${name}` : `Play ${name}`}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sky-600 text-white hover:bg-sky-500"
      >
        {playing ? (
          <svg viewBox="0 0 16 16" className="h-3 w-3 fill-current" aria-hidden>
            <path d="M4 2h3v12H4zM9 2h3v12H9z" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" className="ml-0.5 h-3 w-3 fill-current" aria-hidden>
            <path d="M4 2.5v11l9-5.5z" />
          </svg>
        )}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2 text-[11px]">
          {/* The name deep-links the asset in the viewer; the embed itself
              stays play/seek only. */}
          <button
            onClick={() => openAsset(asset.path)}
            title={asset.path}
            className="truncate font-mono text-neutral-600 hover:text-sky-700 hover:underline dark:text-neutral-300 dark:hover:text-sky-400"
          >
            {name}
          </button>
          <span className="shrink-0 tabular-nums text-neutral-400">
            {failed
              ? "playback failed"
              : duration != null
                ? `${fmtTime(time)} / ${fmtTime(duration)}`
                : humanSize(asset.size)}
          </span>
        </div>
        <canvas
          ref={canvasRef}
          onClick={seek}
          className={`mt-0.5 h-7 w-full cursor-pointer ${decoding ? "animate-pulse" : ""}`}
          role="slider"
          aria-label={`Seek within ${name}`}
          aria-valuemin={0}
          aria-valuemax={duration != null ? Math.round(duration) : 0}
          aria-valuenow={Math.round(time)}
        />
      </div>
      <audio
        ref={audioRef}
        src={url}
        preload="none"
        className="hidden"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => setFailed(true)}
        onLoadedMetadata={(e) => {
          const a = e.currentTarget;
          if (isFinite(a.duration)) setDuration(a.duration);
          if (pendingSeekRef.current != null && isFinite(a.duration)) {
            a.currentTime = pendingSeekRef.current * a.duration;
            pendingSeekRef.current = null;
          }
        }}
      />
    </div>
  );
}
