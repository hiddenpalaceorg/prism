-- Gaming magazine metadata: normalized magazines and issues, page renders,
-- per-section extracts with bounding boxes, entity links (games via the shared
-- games table, people/personas, systems, tags), and a moderation audit trail.
--
-- The whole magazine family is ingested through the moderator API and then
-- moderated in place, so on the production server it is PROD-ONLY DATA with
-- the same never-wipe rules as build_media (see 006-user-media.sql): never
-- drop, truncate, or reload from a local dump; schema changes stay additive.
--
-- Conventions:
--   extract.kind is app-validated (src/lib/mag/kinds.ts), not a CHECK, so new
--   kinds are one array edit. extract.status: auto|amended|rejected —
--   'auto' rows are machine output and may be replaced by re-ingest;
--   amended/rejected rows are moderator data and must survive re-ingest.
--   Region coordinates are normalized 0-1 floats over the rendered page,
--   origin top-left. Blob keys live under the mag/ namespace.
--
-- Idempotent, safe to re-run. Apply to every prism DB:
--   psql -d <db> -f db/migrations/012-magazines.sql

CREATE TABLE IF NOT EXISTS magazines (
    id           BIGSERIAL PRIMARY KEY,
    slug         TEXT NOT NULL UNIQUE,
    title        TEXT NOT NULL,
    aliases      TEXT[] NOT NULL DEFAULT '{}',
    country      TEXT NOT NULL DEFAULT '',
    language     TEXT NOT NULL DEFAULT '',       -- dominant content language, bcp47
    publisher    TEXT NOT NULL DEFAULT '',
    pages_public BOOLEAN NOT NULL DEFAULT TRUE,  -- full page renders public (crops are always public)
    notes        TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS magazine_issue (
    id            BIGSERIAL PRIMARY KEY,
    magazine_id   BIGINT NOT NULL REFERENCES magazines(id),
    slug          TEXT NOT NULL,                 -- per-magazine token: "022", "1991-08", "01"
    label         TEXT NOT NULL,                 -- display: "Issue 22", "1991年8月号", "Ano 1 Nº 1"
    volume        TEXT,
    number        TEXT,
    whole_number  TEXT,                          -- JP 通巻 etc.
    cover_date    DATE,
    cover_date_precision TEXT CHECK (cover_date_precision IN ('day','month','year')),
    price_raw     TEXT,                          -- verbatim, all currencies
    publisher_raw TEXT,                          -- as printed in this issue
    page_count    INT,
    binding       TEXT NOT NULL DEFAULT 'ltr' CHECK (binding IN ('ltr','rtl')),
    pdf_sha256    TEXT,                          -- source PDF blob (mag/ ns); moderator-only, never public
    pdf_size      BIGINT,
    source_url    TEXT,                          -- provenance (manifest.tsv)
    supplements   JSONB NOT NULL DEFAULT '[]',   -- advertised furoku: [{title, present}]
    status        TEXT NOT NULL DEFAULT 'new',   -- new|rendering|extracted|reviewed (convention)
    notes         TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (magazine_id, slug)
);

CREATE TABLE IF NOT EXISTS magazine_page (
    id            BIGSERIAL PRIMARY KEY,
    issue_id      BIGINT NOT NULL REFERENCES magazine_issue(id) ON DELETE CASCADE,
    pdf_index     INT NOT NULL,                  -- 1-based page in the source PDF
    printed_label TEXT,                          -- "4", "supp:6"; NULL = unnumbered
    width         INT,                           -- render pixels
    height        INT,
    image_sha256  TEXT,                          -- page render (mag/ ns); NULL until rendered
    rendered_at   TIMESTAMPTZ,
    UNIQUE (issue_id, pdf_index)
);

-- One extract = one addressable unit: a capsule review, a tip, a letter, an
-- ad. Verbatim transcription (printed errors preserved) lives here; canonical
-- identity lives in the link tables. Kind-specific structure (score grids,
-- chart entries, ad products...) is app-validated JSONB in data.
CREATE TABLE IF NOT EXISTS magazine_extract (
    id              BIGSERIAL PRIMARY KEY,
    issue_id        BIGINT NOT NULL REFERENCES magazine_issue(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL,               -- src/lib/mag/kinds.ts
    section         TEXT,                        -- branded recurring section as printed ("Review Crew")
    seq             INT NOT NULL DEFAULT 0,      -- reading order within the issue
    title           TEXT,
    language        TEXT NOT NULL DEFAULT '',    -- bcp47 of the original text
    text_original   TEXT NOT NULL DEFAULT '',
    text_en         TEXT,                        -- NULL for English originals (UI falls back)
    translation     TEXT CHECK (translation IN ('machine','human')),
    summary_en      TEXT,                        -- 1-2 English sentences for cards/snippets
    data            JSONB NOT NULL DEFAULT '{}',
    is_fictional    BOOLEAN NOT NULL DEFAULT FALSE,
    sponsored       BOOLEAN NOT NULL DEFAULT FALSE,
    content_warning TEXT,
    client_key      TEXT,                        -- ingest idempotency key (skill-chosen)
    status          TEXT NOT NULL DEFAULT 'auto', -- auto|amended|rejected (convention)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mag_extract_client_key
    ON magazine_extract(issue_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mag_extract_issue   ON magazine_extract(issue_id);
CREATE INDEX IF NOT EXISTS idx_mag_extract_kind    ON magazine_extract(kind);
CREATE INDEX IF NOT EXISTS idx_mag_extract_status  ON magazine_extract(status) WHERE status <> 'auto';
-- Search: FTS over the original ('simple' — config-neutral) and the English
-- side; trigram carries substring/exact matching, which is also the only
-- effective path for CJK text ('simple' cannot tokenize it).
CREATE INDEX IF NOT EXISTS idx_mag_extract_fts_orig ON magazine_extract
    USING gin (to_tsvector('simple', coalesce(title,'') || ' ' || text_original));
CREATE INDEX IF NOT EXISTS idx_mag_extract_fts_en ON magazine_extract
    USING gin (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(text_en,'') || ' ' || coalesce(summary_en,'')));
CREATE INDEX IF NOT EXISTS idx_mag_extract_trgm_orig ON magazine_extract
    USING gin (text_original gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_mag_extract_trgm_en ON magazine_extract
    USING gin (text_en gin_trgm_ops);

-- Where an extract sits on the page(s): 1..N ordered rectangles (spread ads,
-- articles continuing across pages, interleaved campaigns).
CREATE TABLE IF NOT EXISTS extract_region (
    id          BIGSERIAL PRIMARY KEY,
    extract_id  BIGINT NOT NULL REFERENCES magazine_extract(id) ON DELETE CASCADE,
    page_id     BIGINT NOT NULL REFERENCES magazine_page(id) ON DELETE CASCADE,
    seq         INT NOT NULL DEFAULT 0,
    x           REAL NOT NULL,
    y           REAL NOT NULL,
    w           REAL NOT NULL,
    h           REAL NOT NULL,
    crop_sha256 TEXT,                            -- png crop (mag/ ns); NULL until cropped
    UNIQUE (extract_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_extract_region_page ON extract_region(page_id);

-- People, pseudonymous personas (Sushi-X, Quartermann, 超人バロムI), and
-- organizations-as-author (U.S. National Video Game Team). Printed reader
-- names are NOT entity-ized (they stay in extract text/data only).
CREATE TABLE IF NOT EXISTS people (
    id            BIGSERIAL PRIMARY KEY,
    slug          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    name_original TEXT,                          -- native-script form
    kind          TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('person','persona','organization')),
    aliases       TEXT[] NOT NULL DEFAULT '{}',
    notes         TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS extract_person (
    extract_id BIGINT NOT NULL REFERENCES magazine_extract(id) ON DELETE CASCADE,
    person_id  BIGINT NOT NULL REFERENCES people(id),
    role       TEXT NOT NULL DEFAULT 'mentioned', -- interviewee|interviewer|author|artist|subject|mentioned|reviewer
    PRIMARY KEY (extract_id, person_id, role)
);
CREATE INDEX IF NOT EXISTS idx_extract_person_person ON extract_person(person_id);

-- Links into the SHARED games table (upsert by (name, system) like builds):
-- a game page shows its builds and its magazine coverage. title_printed keeps
-- the as-printed variant ("PSYCHIC WORLDS") next to the canonical link.
CREATE TABLE IF NOT EXISTS extract_game (
    extract_id    BIGINT NOT NULL REFERENCES magazine_extract(id) ON DELETE CASCADE,
    game_id       BIGINT NOT NULL REFERENCES games(id),
    role          TEXT NOT NULL DEFAULT 'subject', -- subject|mentioned|listed
    title_printed TEXT,
    PRIMARY KEY (extract_id, game_id)
);
CREATE INDEX IF NOT EXISTS idx_extract_game_game ON extract_game(game_id);

CREATE TABLE IF NOT EXISTS extract_system (
    extract_id BIGINT NOT NULL REFERENCES magazine_extract(id) ON DELETE CASCADE,
    system     TEXT NOT NULL,                    -- canonical prism system string
    PRIMARY KEY (extract_id, system)
);
CREATE INDEX IF NOT EXISTS idx_extract_system_system ON extract_system(system);

-- Companies, events, hardware, series, topics — everything searchable that is
-- not a game, person, or system.
CREATE TABLE IF NOT EXISTS mag_tag (
    id   BIGSERIAL PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'topic' CHECK (kind IN ('company','event','hardware','series','topic')),
    name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS extract_tag (
    extract_id BIGINT NOT NULL REFERENCES magazine_extract(id) ON DELETE CASCADE,
    tag_id     BIGINT NOT NULL REFERENCES mag_tag(id),
    PRIMARY KEY (extract_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_extract_tag_tag ON extract_tag(tag_id);

-- Moderation audit trail: one row per amend/reject/restore, field patches as
-- {field: [old, new]}. The extract row carries the current state; this table
-- carries who changed what, when.
CREATE TABLE IF NOT EXISTS extract_revision (
    id         BIGSERIAL PRIMARY KEY,
    extract_id BIGINT NOT NULL REFERENCES magazine_extract(id) ON DELETE CASCADE,
    editor     TEXT NOT NULL,                    -- wiki username, or "token"
    change     JSONB NOT NULL,
    note       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_extract_revision_extract ON extract_revision(extract_id, id DESC);
