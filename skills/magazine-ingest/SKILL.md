---
name: magazine-ingest
description: Extract structured metadata from a scanned gaming-magazine PDF (issue identity, per-page extracts with bounding boxes, translations) and post it to the prism magazine index. Use when asked to "ingest a magazine", "extract magazine metadata", "analyze this magazine pdf", "add this issue to the magazine index", "process this magazine scan", "sweep this issue", "do the next magazine", "upload the magazine extracts", or to resume, QA, or re-run a previous magazine ingest.
---

# Ingest a scanned gaming magazine

Five resumable passes turn one PDF into a fully indexed issue on the prism web
app: render, identity, sweep, translation, QA, upload. Every pass checkpoints
into a per-issue work dir, so an interrupted session resumes by re-running the
pass, nothing already done reruns.

Scripts live in `skills/magazine-ingest/scripts/` (run them from the repo
root; to make this a triggerable agent skill, copy this directory into your
agent's skills directory). The two image
scripts need Pillow; run them as

```sh
uv run --no-project --with pillow python3 skills/magazine-ingest/scripts/render.py ...
uv run --no-project --with pillow python3 skills/magazine-ingest/scripts/crop.py ...
```

(plain `python3` works when Pillow is installed). `post.py` is stdlib-only:
`python3 skills/magazine-ingest/scripts/post.py ...`.

## Work dir

One dir per issue, somewhere that survives the whole run, the session
scratchpad or `/tmp`, e.g. `<scratchpad>/mag/<issue-slug>/`:

```
<workdir>/
  pages/p-<n>.jpg     analysis render, n = 1-based pdf index, long edge ~1600px
  grid/p-<n>.jpg      same render + labeled 10x10 coordinate grid
  issue.json          pass-1 identity (+ issue_id once created server-side)
  pages-NNN.jsonl     pass-2 checkpoints, one extract per line
                      (NNN = zero-padded first pdf index of the batch)
  qa/                 pass-4 sample crops
```

## Pass 0, setup (render)

NEVER Read a magazine PDF directly: many exceed the 100MB Read cap, and pages
must be viewed as rendered images anyway. Always read the rendered JPEGs.

```sh
uv run --no-project --with pillow python3 skills/magazine-ingest/scripts/render.py <pdf> <workdir>
```

Renders every page to `pages/p-<n>.jpg` plus a gridded copy in `grid/`.
Flags: `--pages A-B` for a range, `--grid-only` to redraw grids,
`--dpi-target` (default 1600). Prefers `pdftoppm` (poppler); falls back to
Ghostscript resolved from `$GHOSTSCRIPT_BIN`, then `gs`, then
`/opt/homebrew/opt/ghostscript/bin/gs`, each candidate's `-h` banner must
actually say Ghostscript (on macOS a bare `gs` is often git-spice).
Idempotent: already-rendered pages are skipped.

## Pass 1, identity (issue.json)

Read the cover, TOC, masthead/colophon, and back cover renders. Write
`<workdir>/issue.json`:

```json
{
  "magazine": {
    "slug": "supergame", "title": "Supergame", "aliases": ["SuperGame"],
    "country": "BR", "language": "pt-br", "publisher": "Editora Nova Cultural"
  },
  "issue": {
    "slug": "01", "label": "Ano 1 No 1", "volume": "1", "number": "1",
    "whole_number": "1",
    "cover_date": "1991-08-01", "cover_date_precision": "month",
    "price_raw": "Cr$ 480,00", "publisher_raw": "Editora Nova Cultural Ltda.",
    "binding": "ltr", "page_count": 68,
    "source_url": "https://.../Supergame_BR_01.pdf",
    "supplements": [{ "title": "Poster gigante", "present": true }],
    "page_labels": { "3": "3", "4": "4", "56": "supp:2" }
  }
}
```

Field notes (wire format: `IssueInput`/`MagazineInput` in
`hp-web/src/lib/mag/kinds.ts`):

- `magazine.slug`: lowercase `[a-z0-9-]`, stable across every issue of the
  magazine. `country` is the ISO code, `language` bcp47 lowercase.
- `issue.slug`: `[a-z0-9-]` ≤64, `"022"`, `"1991-08"`, `"01"` style.
  `label` is the printed issue designation, verbatim.
- `cover_date` is full ISO `YYYY-MM-DD`; **month precision is normal** for
  magazines (day `01` as placeholder + `"cover_date_precision": "month"`).
- `price_raw` verbatim as printed, currency marks intact.
- `binding`: `rtl` for right-to-left page order (Japanese magazines), else
  `ltr`.
- `source_url`: when the scan corpus ships a `manifest.tsv` (columns: url,
  filename, size), look the scan's filename up there.
- `supplements`: bound-in extras (posters, mini-guides, supplement booklets);
  `present: false` when the printed issue had it but this scan lacks it.
- `page_labels`: printed page label per pdf index (string keys, 1-based).
  **Verify the printed-number-to-pdf-index rule on 4-5 spot pages** spread
  through the issue before writing labels down, cover offsets, unnumbered ad
  pages, and pages missing from the scan all shift the rule. Bound-in
  supplements with their own pagination get scoped labels: `"supp:N"`.

## Pass 2, sweep (pages-NNN.jsonl)

Work in batches of 6-10 pages. Per batch: read the analysis images
`pages/p-<n>.jpg`, consult `grid/p-<n>.jpg` for coordinates, and write one
JSON line per extract (the wire format below) to `<workdir>/pages-NNN.jsonl`.
The file is the checkpoint: a batch whose file exists and is complete never
reruns.

- One extract = one addressable unit: one capsule review, one tip, one
  letter, one ad, one chart. A review roundup page is many extracts; a
  six-page interview is one.
- Every page gets full coverage, everything on the page belongs to some
  extract. Page furniture (folios, running headers/footers, decorative rules)
  is never extracted and never blocks coverage.
- Do not extract-then-forget: keep `seq` and `client_key` assigned as you go
  (conventions below).

## Pass 3, translation

- `summary_en` (1-2 sentences, English) is REQUIRED for every extract in
  every language, English included.
- For non-English issues, fill `text_en` with a full English translation for
  every extract and set `"translation": "machine"`.
- Sweep subagents should fill `summary_en` (and `text_en` on non-English
  issues) inline during pass 2; pass 3 is then a gap-fill sweep over the
  checkpoints for anything missing.

## Pass 4, QA

```sh
uv run --no-project --with pillow python3 skills/magazine-ingest/scripts/crop.py <workdir> <workdir>/pages-*.jsonl --sample 0.1
```

cuts every region of ~10% of the extracts (stable sample) into
`<workdir>/qa/<client_key>-r<i>.png` and prints a manifest line per crop
(client_key, kind, title, path). Then:

- Re-read each crop image and confirm it contains what its extract claims
  (right piece, headline and images inside the box). Widen or fix boxes that
  miss: edit the JSONL line, then re-crop just that file with `--all` to
  confirm.
- Cross-check ad extracts against the advertiser index when the magazine
  prints one (EGM does): every advertiser/page in the `ad_index` extract
  should have a matching `ad` extract.
- List pages with zero extracts and TOC sections with no extracts;
  investigate each one (blank page? furniture-only? page missing from the
  scan? missed sweep?). Fix or note the reason before uploading.

## Pass 5, upload

`post.py` subcommands, in order (auth and `--base` below):

```sh
P=skills/magazine-ingest/scripts/post.py
python3 $P magazine <workdir>/issue.json          # upsert magazine by slug
python3 $P issue    <workdir>/issue.json          # upsert issue; writes issue_id back
python3 $P pdf      <workdir>/issue.json <pdf>    # chunked upload + sha256 verify
python3 $P extracts <workdir>/issue.json <workdir>/pages-*.jsonl
python3 $P status   <workdir>/issue.json --wait   # poll until pages+crops done
```

- `magazine` must run before `issue`, a typo'd magazine slug 404s instead of
  minting a magazine. Optional magazine/issue fields that are omitted keep
  their stored values, so re-upserts cannot blank a moderator's edits.
- `pdf` opens a session (`POST .../pdf {size}` -> token), PUTs 8MB chunks to
  `.../pdf/<token>?offset=N`, resumes from the server's offset on 409,
  retries each chunk up to 5 times with backoff on 5xx/timeouts, and verifies
  the returned sha256 against the local file. Server caps: 1 GiB per PDF,
  32MB per chunk.
- `extracts` posts batches of up to 50 (server MAX_BATCH), prints per-item
  results, writes `<input>.results.jsonl` next to each input, and exits
  nonzero if any item errored (`skipped: "moderated"` is fine).
- `status --wait` polls every 5s until `pages_rendered = pages_total` and
  `crops_done = crops_total`, then prints the final status and the issue URL.

Finish with a report to the user: extract counts by kind, every skipped/error
item, and the issue URL `/magazines/<magazine-slug>/<issue-slug>`.

## Extract wire format

Must match `hp-web/src/lib/mag/kinds.ts` exactly (`ExtractInput`), read it
if in doubt. One JSONL line per extract:

```json
{
  "client_key": "p23-review-sonic-the-hedgehog",
  "kind": "review", "section": "Review Crew", "seq": 2301,
  "title": "Sonic The Hedgehog", "language": "en",
  "text_original": "…verbatim transcription…",
  "text_en": "…full translation (non-English only)…", "translation": "machine",
  "summary_en": "One to two English sentences.",
  "data": { "…kind-specific payload…": "see Policy" },
  "is_fictional": false, "sponsored": false, "content_warning": "…",
  "regions": [{ "pdf_index": 23, "x": 0.05, "y": 0.1, "w": 0.44, "h": 0.38 }],
  "games": [{ "name": "Sonic the Hedgehog", "system": "Sega Mega Drive",
              "role": "subject", "title_printed": "SONIC THE HEDGEHOG" }],
  "people": [{ "name": "Sushi-X", "kind": "persona", "role": "reviewer" }],
  "systems": ["Sega Mega Drive"],
  "tags": [{ "kind": "company", "name": "Sega" }]
}
```

- `client_key`: `p<pdf_index>-<kind>-<short-slug>` (pdf index of the first
  region). Stable across re-runs, derive it from the content, never from a
  counter, and unique within the issue (disambiguate with `-2`, `-3` when a
  page has two same-kind, same-slug units). ≤200 chars. Re-posting the same
  key updates the row (idempotent).
- `kind`, one of: `cover`, `toc`, `masthead`, `editorial`, `letters`, `news`,
  `rumor`, `preview`, `review`, `feature`, `interview`, `strategy`, `tips`,
  `chart`, `high_scores`, `calendar`, `contest`, `poster`, `comic`,
  `fiction`, `column`, `ad`, `ad_index`, `next_issue`, `form`, `other`.
- `seq`: global reading order within the issue, page order, then
  top-to-bottom, left-to-right on the page. rtl-bound magazines still use pdf
  page order. Convention that stays stable across parallel batches:
  `seq = pdf_index_of_first_region * 100 + position_on_page` (0-99).
- `section`: the printed department/section name when there is one
  ("Review Crew", "ファンレター").
- Bounding boxes (`regions`): normalized 0-1, origin top-left of the page
  render, read off the gridded copy. Cover the WHOLE visual unit, headline,
  body, images, credited photos. Multi-page pieces (spread ads, articles with
  jumps) are ONE extract with multiple ordered regions. Max 12 regions per
  extract (server cap), split a longer piece into `-pt1`/`-pt2` extracts at
  a sensible boundary, keeping seq order.
- Size caps (server): text_original/text_en 200k chars, summary_en 2k, title
  500, section 200, data 200KB JSON, games ≤300, people ≤50, systems ≤20,
  tags ≤50, batch ≤50.

## Policy

### Verbatim transcription

- Transcription is verbatim: printed errors stay ("Komani", "PSYCHIC
  WORLDS"), no `[sic]`, no silent fixes. Canonical names live in the entity
  links: `games[].name` is canonical, `title_printed` carries what the page
  printed.
- FULL verbatim transcription everywhere, including mail-order price lists
  and dense tables. They are real data: transcribe them in `text_original`
  AND put the structured rows in `data.entries`.

### Kind-specific data payloads

Omit whatever the page does not show (score-less magazines exist). The
conventional arrays (`scores`, `axes`, `entries`, `products`, `prizes`) must
be arrays of objects, the server rejects other shapes.

- review: `data.scores` `[{reviewer, value, scale}]`, `data.average`
  `{value, scale}`, radar charts as `data.axes` `[{name, value, scale}]`,
  `data.subject_type` game|hardware|accessory|music.
- fact boxes (on previews/reviews): `data.fact_box` `{maker, system_printed,
  release_raw, price_raw, cart_size_mbit, genre_printed, levels, difficulty,
  players, backup, completion_pct}`.
- chart: `data.entries` `[{rank, prev_rank, title_printed, points, comment}]`
  + `data.chart_type`, `data.source`, `data.period`.
- high_scores: `data.entries` `[{player, location, title_printed, event,
  value, value_type}]` + `data.source`.
- ad: `data.advertiser`, `data.ad_type`
  (product|retail_mailorder|classified|house|consumer|school|service),
  `data.products` `[{title_printed, system_printed, release_raw, price_raw}]`,
  `data.phones`, `data.reader_service_no`, `data.agency`.
- interview: `data.interviewees`, `data.interviewer`, `data.format`,
  `data.series`.
- contest: `data.subkind`, `data.prizes`, `data.deadlines`,
  `data.entry_method`, `data.legal`.
- provenance for charts/tips/scores: `data.source`, `shop_survey`,
  `reader_mail`, `hotline`, `club`, `press_release`.

### System canonicalization

`games[].system` and `systems[]` use the prism games table's exact strings:

`"Sega Mega Drive"` (Genesis/Mega Drive/メガドライブ), `"Sega Master System"`,
`"Game Gear"`, `"Sega CD"` (Mega-CD), `"Sega 32X"`, `"NES"` (also Famicom),
`"SNES"` (also Super Famicom), `"Game Boy"`, `"TurboGrafx-16"` (also PC
Engine), `"TurboGrafx-CD"`, `"Atari Lynx"`, `"Neo Geo"`, `"Arcade"`,
`"Amiga"`, `"PC"`.

Keep the printed regional name in the text and in
`system_printed`/`title_printed` fields.

### Game links

`role`: `subject` (the piece is about it), `mentioned` (referenced in
passing), `listed` (one row of a chart/calendar/price list).

### People links

- Create `people` links only for staff, industry figures, and stable
  pseudonymous personas (`kind: "persona"`, Sushi-X, Quartermann,
  超人バロムI, O Chefe). Organizations like the U.S. National Video Game Team
  get `kind: "organization"`.
- CJK names need a romanized lowercase slug (e.g. `"masayuki-yamamoto"`) plus
  `name_original` in the native script.
- NEVER create people links for private individuals: readers credited on
  letters, tips, high scores, and fan art stay in `text_original`/`data`
  only.

### Flags

- `is_fictional`: deliberate fake/humor content and fiction serials.
- `sponsored`: co-branded editorial ("EGM and Vic Tokai present").
- `content_warning`: short text for period slurs and similar.

### Language

- `language` per extract, bcp47 lowercase: `"en"`, `"ja"`, `"pt-br"`. An
  English pull-quote inside a Japanese magazine is still part of a `"ja"`
  extract.

## Cost and fan-out

A 40-page issue runs ~300k tokens; a 140-page Japanese issue up to ~1M
(translation included). Sweep batches may be delegated to parallel subagents,
one batch per agent (opus-class models are sufficient for sweeps), each
writing its own `pages-NNN.jsonl` in the shared work dir, with the
orchestrator merging and sanity-checking the checkpoints. The identity pass
(1) and QA pass (4) always stay with the orchestrator. Give each subagent the
work-dir path, its page range, the wire format, and the policy sections
above.

The work dir is shared, so each subagent must keep its helper scripts and QA
renders in a private subdirectory named for its batch (for example
`qa-004/`). Two agents writing `zoom.py` at the work-dir root overwrite each
other mid-run; only the `pages-NNN.jsonl` checkpoints (already unique per
batch) belong at the root.

## Auth and target

`post.py` resolves the moderation token from the `PRISM_MODERATION_TOKEN`
env var, then `~/.config/prism/moderation-token`. The token is sent as
`x-moderation-token` and never printed.

`--base` sets the app URL, default `https://hiddenpalace.org` (the
production instance; `PRISM_WEB_URL` env overrides the default), or
`--base http://localhost:6800` for local runs.

## Failure modes

- **Per-item batch results**, each extract lands or fails independently:
  `{client_key, id, action: inserted|updated}` or `{client_key, skipped:
  moderated|error, error}`. One malformed item never sinks the batch; fix the
  JSONL line and re-post (client_keys are idempotent).
- **`skipped: "moderated"`**, a moderator amended or rejected that row;
  re-ingest only replaces `status='auto'` rows. This is CORRECT, not an
  error. Leave those rows alone.
- **Resume after interruption**, rendered pages, `issue.json`, and the
  JSONL checkpoints persist; re-run the interrupted pass. Re-posting whole
  checkpoint files is safe: already-ingested keys report `updated`. For a
  clean from-scratch re-ingest, `post.py reset` (a confirmed
  `DELETE .../extracts?only=auto`) then re-post; moderated rows survive by
  design.
- **PDF upload interrupted**, within a run, 409s resume at the server's
  offset. A re-run of `post.py pdf` starts a fresh session from byte 0;
  harmless (blobs are content-addressed) but a full re-upload.
- **Rendering stalls after a server restart**, the status poll self-heals:
  GET status re-kicks the render/crop job when work is pending and nothing is
  running. Keep `status --wait` polling; nothing else to do. If the job
  repeatedly reports `state: "failed"` with the same error, stop and report
  it.
- **HTTP 401**, moderation token missing/stale; set
  `PRISM_MODERATION_TOKEN` or create the token file.
- **`issue` returns 404 "no such magazine"**, run `post.py magazine` first
  (deliberate: a typo'd slug must not mint a magazine).
- **HTTP 400 on an extract**, the server names the invalid field (unknown
  kind, bad language tag, degenerate region after clamping, oversized text).
  Fix that line, re-post the file.
- **HTTP 413**, batch >50 (post.py already splits) or PDF over the 1 GiB
  cap. **HTTP 415 "not a pdf"**, the first chunk lacked the `%PDF-` magic;
  wrong file.
