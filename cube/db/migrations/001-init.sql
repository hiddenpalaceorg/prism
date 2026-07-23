-- cube core schema. Idempotent and additive: safe to re-apply, never drops
-- or rewrites data (prod rule: cube_* tables are server-authored user data
-- and must join the deploy preserve/restore set in the PR that adds them).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- IMMUTABLE cast helpers so expression indexes serve typed sorts/ranges.
-- Bodies must be TRULY immutable (make_date/split_part, never to_date or
-- ::date) or Postgres refuses to inline the function and every row pays a
-- real call — measured 68ms vs 12ms on the 500k-row perf spike. Non-STRICT
-- on purpose: strictness can also block inlining, and the CASE is null-safe.
-- Inputs are ISO partial dates (YYYY[-MM[-DD]]); schema validation guarantees
-- calendar-valid values, the regexes only guard shape.
CREATE OR REPLACE FUNCTION cube_date(t TEXT) RETURNS date
  IMMUTABLE PARALLEL SAFE LANGUAGE sql
  AS $$ SELECT CASE
    WHEN t ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$'
      THEN make_date(split_part(t, '-', 1)::int, split_part(t, '-', 2)::int, split_part(t, '-', 3)::int)
    WHEN t ~ '^\d{4}-(0[1-9]|1[0-2])$'
      THEN make_date(split_part(t, '-', 1)::int, split_part(t, '-', 2)::int, 1)
    WHEN t ~ '^\d{4}$'
      THEN make_date(t::int, 1, 1)
    ELSE NULL END $$;

CREATE OR REPLACE FUNCTION cube_num(t TEXT) RETURNS numeric
  IMMUTABLE PARALLEL SAFE LANGUAGE sql
  AS $$ SELECT CASE WHEN t ~ '^-?\d+(\.\d+)?$' THEN t::numeric ELSE NULL END $$;

CREATE TABLE IF NOT EXISTS cube_page (
    id              BIGSERIAL PRIMARY KEY,
    ns              TEXT NOT NULL DEFAULT 'main',
    slug            TEXT NOT NULL,
    title           TEXT NOT NULL,
    display_title   TEXT,
    path            TEXT UNIQUE,
    current_rev_id  BIGINT,
    is_redirect     BOOLEAN NOT NULL DEFAULT FALSE,
    protection      JSONB NOT NULL DEFAULT '{}',
    visibility      TEXT NOT NULL DEFAULT 'public',
    deleted_at      TIMESTAMPTZ,
    search_doc      TEXT NOT NULL DEFAULT '',
    search_tsv      tsvector GENERATED ALWAYS AS
                      (to_tsvector('simple', left(title || ' ' || search_doc, 200000))) STORED,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (ns, slug),
    CHECK (visibility IN ('public', 'moderator'))
);
CREATE INDEX IF NOT EXISTS idx_cube_page_title_trgm ON cube_page USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_cube_page_tsv ON cube_page USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_cube_page_updated ON cube_page (updated_at DESC);

CREATE TABLE IF NOT EXISTS cube_revision (
    id                BIGSERIAL PRIMARY KEY,
    page_id           BIGINT NOT NULL REFERENCES cube_page(id),
    parent_rev_id     BIGINT REFERENCES cube_revision(id),
    author_id         BIGINT,
    author_name       TEXT NOT NULL,
    comment           TEXT NOT NULL DEFAULT '',
    minor             BOOLEAN NOT NULL DEFAULT FALSE,
    content           TEXT NOT NULL,
    content_sha256    TEXT NOT NULL,
    wikitext_fallback BOOLEAN NOT NULL DEFAULT FALSE,
    mw_rev_id         BIGINT,
    suppressed        TEXT[] NOT NULL DEFAULT '{}',
    ip_meta           TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cube_rev_page ON cube_revision (page_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_cube_rev_created ON cube_revision (created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cube_rev_mw ON cube_revision (mw_rev_id) WHERE mw_rev_id IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE cube_page
    ADD CONSTRAINT fk_cube_page_current_rev FOREIGN KEY (current_rev_id) REFERENCES cube_revision(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS cube_redirect (
    from_page_id BIGINT PRIMARY KEY REFERENCES cube_page(id) ON DELETE CASCADE,
    to_ns        TEXT NOT NULL,
    to_slug      TEXT NOT NULL,
    fragment     TEXT
);
CREATE INDEX IF NOT EXISTS idx_cube_redirect_to ON cube_redirect (to_ns, to_slug);

CREATE TABLE IF NOT EXISTS cube_page_object (
    id        BIGSERIAL PRIMARY KEY,
    page_id   BIGINT NOT NULL REFERENCES cube_page(id) ON DELETE CASCADE,
    component TEXT NOT NULL,
    ordinal   INT NOT NULL,
    data      JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cpo_page ON cube_page_object (page_id);
CREATE INDEX IF NOT EXISTS idx_cpo_component ON cube_page_object (component);
CREATE INDEX IF NOT EXISTS idx_cpo_gin ON cube_page_object USING gin (data jsonb_path_ops);
-- Hot-field expression indexes are site-owned (emitted from schema `indexed:`
-- declarations); see the host app's migrations.

CREATE TABLE IF NOT EXISTS cube_page_category (
    page_id  BIGINT NOT NULL REFERENCES cube_page(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    PRIMARY KEY (page_id, category)
);
CREATE INDEX IF NOT EXISTS idx_cpc_cat ON cube_page_category (category);

CREATE TABLE IF NOT EXISTS cube_link (
    from_page_id BIGINT NOT NULL REFERENCES cube_page(id) ON DELETE CASCADE,
    to_ns        TEXT NOT NULL,
    to_slug      TEXT NOT NULL,
    kind         TEXT NOT NULL,
    PRIMARY KEY (from_page_id, to_ns, to_slug, kind)
);
CREATE INDEX IF NOT EXISTS idx_cube_link_to ON cube_link (to_ns, to_slug);

CREATE TABLE IF NOT EXISTS cube_query_dep (
    page_id    BIGINT NOT NULL REFERENCES cube_page(id) ON DELETE CASCADE,
    component  TEXT NOT NULL,
    filter_key TEXT NOT NULL DEFAULT '*',
    PRIMARY KEY (page_id, component, filter_key)
);
CREATE INDEX IF NOT EXISTS idx_cqd_component ON cube_query_dep (component, filter_key);

CREATE TABLE IF NOT EXISTS cube_page_alias (
    path       TEXT PRIMARY KEY,
    page_id    BIGINT NOT NULL REFERENCES cube_page(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL DEFAULT 'custom',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cpa_page ON cube_page_alias (page_id);

CREATE TABLE IF NOT EXISTS cube_user (
    id            BIGSERIAL PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    email         TEXT,
    password_hash TEXT,
    roles         TEXT[] NOT NULL DEFAULT '{}',
    blocked_at    TIMESTAMPTZ,
    blocked_by    BIGINT,
    block_reason  TEXT,
    mw_user_id    BIGINT,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cube_session (
    token_sha256 TEXT PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES cube_user(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    last_seen    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cube_session_user ON cube_session (user_id);

CREATE TABLE IF NOT EXISTS cube_token (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT NOT NULL,
    token_sha256 TEXT NOT NULL UNIQUE,
    scopes       TEXT[] NOT NULL DEFAULT '{read}',
    user_id      BIGINT REFERENCES cube_user(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ,
    last_used    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS cube_media (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    storage_key TEXT NOT NULL,
    sha256      TEXT,
    sha1        TEXT,
    size        BIGINT,
    mime        TEXT,
    width       INT,
    height      INT,
    uploaded_by BIGINT REFERENCES cube_user(id),
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cube_media_name_trgm ON cube_media USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_cube_media_sha256 ON cube_media (sha256) WHERE sha256 IS NOT NULL;

CREATE TABLE IF NOT EXISTS cube_media_revision (
    id          BIGSERIAL PRIMARY KEY,
    media_id    BIGINT NOT NULL REFERENCES cube_media(id) ON DELETE CASCADE,
    storage_key TEXT NOT NULL,
    sha256      TEXT,
    size        BIGINT,
    mime        TEXT,
    uploaded_by BIGINT,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_cmr_media ON cube_media_revision (media_id, id DESC);

CREATE TABLE IF NOT EXISTS cube_git_queue (
    id         BIGSERIAL PRIMARY KEY,
    rev_id     BIGINT REFERENCES cube_revision(id),
    action     TEXT NOT NULL,
    detail     JSONB NOT NULL DEFAULT '{}',
    attempts   INT NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    done_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cgq_pending ON cube_git_queue (id) WHERE done_at IS NULL;

CREATE TABLE IF NOT EXISTS cube_page_log (
    id         BIGSERIAL PRIMARY KEY,
    page_id    BIGINT REFERENCES cube_page(id),
    action     TEXT NOT NULL,
    actor_id   BIGINT,
    actor_name TEXT,
    detail     JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cpl_page ON cube_page_log (page_id, id DESC);

CREATE TABLE IF NOT EXISTS cube_watch (
    user_id    BIGINT NOT NULL REFERENCES cube_user(id) ON DELETE CASCADE,
    page_id    BIGINT NOT NULL REFERENCES cube_page(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, page_id)
);

CREATE TABLE IF NOT EXISTS cube_draft (
    id               BIGSERIAL PRIMARY KEY,
    user_id          BIGINT NOT NULL REFERENCES cube_user(id) ON DELETE CASCADE,
    page_id          BIGINT REFERENCES cube_page(id) ON DELETE CASCADE,
    blueprint        TEXT,
    content          TEXT NOT NULL,
    base_rev_id      BIGINT,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cube_draft_user ON cube_draft (user_id, updated_at DESC);
