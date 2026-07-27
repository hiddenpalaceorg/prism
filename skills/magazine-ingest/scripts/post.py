#!/usr/bin/env python3
"""Post magazine metadata to the prism web app's ingestion API. See SKILL.md.

Subcommands (all take --base and authenticate with x-moderation-token; the
token is never printed):

  magazine <issue.json>             upsert the magazine block
  issue    <issue.json>             upsert the issue block; stores issue_id back
  pdf      <issue.json> <file.pdf>  chunked source-PDF upload (resumable)
  extracts <issue.json> <jsonl...>  ingest extracts in batches of 50
  status   <issue.json> [--wait]    render/crop progress (--wait polls to done)
  reset    <issue.json>             delete status='auto' extracts (y/N confirm)

issue.json is the pass-1 identity file: {"magazine": {...}, "issue": {...}}
plus "issue_id" once `issue` has run. Stdlib only (urllib), no external deps.

Token resolution: PRISM_MODERATION_TOKEN env, then ~/.config/prism/
moderation-token.
"""

import argparse
import hashlib
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request

DEFAULT_BASE = os.environ.get("PRISM_WEB_URL", "https://hiddenpalace.org")
TOKEN_FILE = os.path.expanduser("~/.config/prism/moderation-token")
UA = "prism-magazine-ingest/1 (mag ingest tooling)"
CHUNK = 8 * 1024 * 1024
BATCH = 50  # server MAX_BATCH
CHUNK_RETRIES = 5
POLL_SECONDS = 5

class Fail(Exception):
    pass

class NetFail(Fail):
    """Transient transport failure (timeout, connection error) — retryable."""

def note(msg):
    print(msg, file=sys.stderr)

def die(msg, code=1):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)

def moderation_token():
    tok = os.environ.get("PRISM_MODERATION_TOKEN", "").strip()
    if tok:
        return tok
    try:
        with open(TOKEN_FILE) as f:
            tok = f.read().strip()
        if tok:
            return tok
    except OSError:
        pass
    die(f"no moderation token: set PRISM_MODERATION_TOKEN or create {TOKEN_FILE}")

# ── HTTP ─────────────────────────────────────────────────────────────────────

_SSL_CTX = "unset"  # "unset" -> probe; None -> library default; else a context

def _urlopen(req, timeout):
    """urlopen with a one-time CA fallback: system Pythons without certifi
    (macOS) can still verify against the OS bundle."""
    global _SSL_CTX
    if _SSL_CTX != "unset":
        return urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX)
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        _SSL_CTX = None
        return r
    except urllib.error.URLError as e:
        if "CERTIFICATE_VERIFY_FAILED" not in str(e):
            raise
        for cafile in ("/etc/ssl/cert.pem", "/opt/homebrew/etc/ca-certificates/cert.pem"):
            if not os.path.exists(cafile):
                continue
            ctx = ssl.create_default_context(cafile=cafile)
            try:
                r = urllib.request.urlopen(req, timeout=timeout, context=ctx)
            except urllib.error.URLError:
                continue
            _SSL_CTX = ctx
            return r
        raise Fail("TLS certificate verification failed and no system CA bundle "
                   "worked; try a Python with certifi or --base http://...") from e

def request(method, url, tok, body=None, raw=None, timeout=120):
    """(status, text). HTTP error statuses are returned, not raised;
    transport-level failures raise NetFail."""
    headers = {"User-Agent": UA, "x-moderation-token": tok}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    elif raw is not None:
        data = raw
        headers["Content-Type"] = "application/octet-stream"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with _urlopen(req, timeout) as r:
            return r.getcode(), r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
        raise NetFail(f"{method} {url}: {e}") from e

def api(base, path, tok, method="GET", body=None, timeout=120):
    status, out = request(method, base + path, tok, body=body, timeout=timeout)
    if status != 200:
        raise Fail(f"{method} {path} -> HTTP {status}: {out[:500]}")
    try:
        return json.loads(out)
    except json.JSONDecodeError as e:
        raise Fail(f"{method} {path} -> non-JSON response: {out[:200]}") from e

# ── issue.json ───────────────────────────────────────────────────────────────

def load_doc(path):
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        die(f"cannot read {path}: {e}")
    if not isinstance(doc, dict):
        die(f"{path} must hold a JSON object")
    return doc

def save_doc(path, doc):
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)

def block(doc, path, key):
    v = doc.get(key)
    if not isinstance(v, dict):
        die(f'{path} has no "{key}" object (pass 1 writes it)')
    return v

def issue_id(doc, path):
    v = doc.get("issue_id")
    if not isinstance(v, int):
        die(f'{path} has no issue_id — run `post.py issue {path}` first')
    return v

def issue_url(base, doc):
    mag = doc.get("magazine", {}).get("slug")
    slug = doc.get("issue", {}).get("slug")
    return f"{base}/magazines/{mag}/{slug}" if mag and slug else None

# ── subcommands ──────────────────────────────────────────────────────────────

def cmd_magazine(args, tok):
    doc = load_doc(args.issue_json)
    magazine = block(doc, args.issue_json, "magazine")
    r = api(args.base, "/api/mag/magazines", tok, "POST", magazine)
    print(json.dumps(r.get("magazine", r), indent=2, ensure_ascii=False))

def cmd_issue(args, tok):
    doc = load_doc(args.issue_json)
    payload = dict(block(doc, args.issue_json, "issue"))
    payload.setdefault("magazine", doc.get("magazine", {}).get("slug"))
    if not payload.get("magazine"):
        die(f"{args.issue_json}: no magazine slug (issue.magazine or magazine.slug)")
    r = api(args.base, "/api/mag/issues", tok, "POST", payload)
    issue = r.get("issue")
    if not isinstance(issue, dict) or not isinstance(issue.get("id"), int):
        raise Fail(f"unexpected issue response: {json.dumps(r)[:300]}")
    doc["issue_id"] = issue["id"]
    save_doc(args.issue_json, doc)
    print(f"issue id {issue['id']}: {issue.get('magazine_slug')}/{issue.get('slug')} "
          f"({issue.get('label')})")
    note(f"issue_id stored in {args.issue_json}")

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()

def put_chunk(args, tok, ident, token, offset, chunk):
    """One chunk with retry/backoff; returns the parsed 200 body or a 409
    offset to adopt. Anything else raises."""
    url = f"{args.base}/api/mag/issues/{ident}/pdf/{token}?offset={offset}"
    for attempt in range(1, CHUNK_RETRIES + 1):
        try:
            status, out = request("PUT", url, tok, raw=chunk, timeout=300)
        except NetFail as e:
            status, out = None, str(e)
        if status == 200:
            try:
                return json.loads(out), None
            except json.JSONDecodeError:
                raise Fail(f"PUT chunk -> non-JSON response: {out[:200]}")
        if status == 409:
            try:
                truth = json.loads(out)["offset"]
            except (json.JSONDecodeError, KeyError):
                raise Fail(f"PUT chunk -> HTTP 409 without an offset: {out[:200]}")
            return None, int(truth)
        if status is not None and status < 500:
            raise Fail(f"PUT chunk @{offset} -> HTTP {status}: {out[:300]}")
        if attempt == CHUNK_RETRIES:
            raise Fail(f"PUT chunk @{offset} failed after {CHUNK_RETRIES} tries: "
                       f"{'HTTP ' + str(status) if status else out}")
        wait = 2 ** attempt
        note(f"chunk @{offset}: {'HTTP ' + str(status) if status else 'network error'}; "
             f"retry {attempt}/{CHUNK_RETRIES - 1} in {wait}s")
        time.sleep(wait)

def cmd_pdf(args, tok):
    doc = load_doc(args.issue_json)
    ident = issue_id(doc, args.issue_json)
    if not os.path.isfile(args.pdf):
        die(f"no such file: {args.pdf}")
    size = os.path.getsize(args.pdf)
    if size == 0:
        die(f"{args.pdf} is empty")
    r = api(args.base, f"/api/mag/issues/{ident}/pdf", tok, "POST", {"size": size})
    token = r.get("token")
    if not token:
        raise Fail(f"no upload token in response: {json.dumps(r)[:200]}")
    note(f"uploading {size} bytes in {CHUNK // (1024 * 1024)}MB chunks")

    offset = 0
    stale = 0
    sha_remote = None
    with open(args.pdf, "rb") as f:
        while sha_remote is None:
            f.seek(offset)
            chunk = f.read(CHUNK)
            if not chunk:
                raise Fail(f"file ended at {offset} before the declared size {size}")
            body, truth = put_chunk(args, tok, ident, token, offset, chunk)
            if truth is not None:  # 409: the server knows the real offset
                stale += 1
                if stale > 3:
                    raise Fail("upload session keeps disagreeing about the offset")
                note(f"server says offset {truth}; resuming there")
                offset = truth
                continue
            stale = 0
            if body.get("done"):
                sha_remote = body.get("sha256")
                if not sha_remote:
                    raise Fail(f"upload finished without a sha256: {json.dumps(body)[:200]}")
            else:
                offset = int(body.get("offset", offset + len(chunk)))
                note(f"  {offset}/{size} bytes ({100 * offset // size}%)")

    note("verifying sha256 locally...")
    sha_local = sha256_file(args.pdf)
    if sha_local != sha_remote:
        raise Fail(f"sha256 mismatch: local {sha_local}, server {sha_remote}")
    print(f"pdf uploaded: sha256 {sha_remote} ({size} bytes)")

def cmd_extracts(args, tok):
    doc = load_doc(args.issue_json)
    ident = issue_id(doc, args.issue_json)
    totals = {"inserted": 0, "updated": 0, "moderated": 0, "error": 0}
    for path in args.jsonl:
        # A glob like pages-*.jsonl also matches our own results logs from a
        # previous run; feeding those back would just produce noise errors.
        if path.endswith(".results.jsonl"):
            note(f"{path}: skipping results log")
            continue
        items = []
        try:
            with open(path, encoding="utf-8") as f:
                for i, line in enumerate(f, 1):
                    if not line.strip():
                        continue
                    try:
                        items.append(json.loads(line))
                    except json.JSONDecodeError as e:
                        note(f"ERROR {path}:{i}: bad JSON: {e}")
                        totals["error"] += 1
        except OSError as e:
            die(f"cannot read {path}: {e}")
        if not items:
            note(f"{path}: nothing to post")
            continue
        results = []
        for start in range(0, len(items), BATCH):
            batch = items[start:start + BATCH]
            r = api(args.base, f"/api/mag/issues/{ident}/extracts", tok, "POST",
                    batch, timeout=300)
            batch_results = r.get("results")
            if not isinstance(batch_results, list):
                raise Fail(f"unexpected extracts response: {json.dumps(r)[:300]}")
            results.extend(batch_results)
            for item in batch_results:
                key = item.get("client_key", "?")
                if "id" in item:
                    totals[item["action"]] = totals.get(item["action"], 0) + 1
                    print(f"{key}: {item['action']}")
                else:
                    reason = item.get("skipped", "error")
                    totals[reason] = totals.get(reason, 0) + 1
                    suffix = f" ({item['error']})" if item.get("error") else ""
                    print(f"{key}: skipped: {reason}{suffix}")
        log = path + ".results.jsonl"
        with open(log, "w", encoding="utf-8") as f:
            for item in results:
                f.write(json.dumps(item, ensure_ascii=False) + "\n")
        note(f"{path}: {len(results)} results logged to {log}")

    print("totals: " + "  ".join(f"{k}={v}" for k, v in totals.items() if v))
    if totals["error"]:
        die(f"{totals['error']} extracts errored (moderated skips are fine; "
            "errors are not) — fix and re-post, client_keys are idempotent", 2)

def assets_complete(assets):
    return (assets.get("pages_total", 0) > 0
            and assets.get("pages_rendered", 0) >= assets["pages_total"]
            and assets.get("crops_done", 0) >= assets.get("crops_total", 0))

def cmd_status(args, tok):
    doc = load_doc(args.issue_json)
    ident = issue_id(doc, args.issue_json)
    failures = 0
    while True:
        r = api(args.base, f"/api/mag/issues/{ident}/status", tok)
        if not args.wait:
            print(json.dumps(r, indent=2))
            return
        assets = r.get("assets", {})
        extracts = r.get("extracts", {})
        note(f"issue={r.get('issue')} state={assets.get('state')} "
             f"pages {assets.get('pages_rendered')}/{assets.get('pages_total')} "
             f"crops {assets.get('crops_done')}/{assets.get('crops_total')} "
             f"extracts auto={extracts.get('auto')} amended={extracts.get('amended')} "
             f"rejected={extracts.get('rejected')}")
        if assets.get("state") == "failed" and assets.get("error"):
            failures += 1
            if failures >= 3:  # polling self-heals; a repeating error will not
                raise Fail(f"asset job keeps failing: {assets['error']}")
        else:
            failures = 0
        if assets_complete(assets):
            print(json.dumps(r, indent=2))
            url = issue_url(args.base, doc)
            if url:
                print(f"issue url: {url}")
            return
        time.sleep(POLL_SECONDS)

def cmd_reset(args, tok):
    doc = load_doc(args.issue_json)
    ident = issue_id(doc, args.issue_json)
    answer = input(f"delete ALL status='auto' extracts of issue {ident} "
                   f"({issue_url(args.base, doc) or 'unknown slug'})? [y/N] ")
    if answer.strip().lower() not in ("y", "yes"):
        die("aborted (nothing deleted)")
    r = api(args.base, f"/api/mag/issues/{ident}/extracts?only=auto", tok, "DELETE")
    print(f"deleted: {r.get('deleted')} (moderated rows are never touched)")

# ── main ─────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--base", default=DEFAULT_BASE,
                   help=f"app base URL (default {DEFAULT_BASE}; "
                        "http://localhost:6800 for local runs)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("magazine", help="upsert the magazine block")
    sp.add_argument("issue_json")
    sp.set_defaults(fn=cmd_magazine)

    sp = sub.add_parser("issue", help="upsert the issue block, store issue_id")
    sp.add_argument("issue_json")
    sp.set_defaults(fn=cmd_issue)

    sp = sub.add_parser("pdf", help="chunked source-PDF upload")
    sp.add_argument("issue_json")
    sp.add_argument("pdf")
    sp.set_defaults(fn=cmd_pdf)

    sp = sub.add_parser("extracts", help="ingest extract JSONL files in batches")
    sp.add_argument("issue_json")
    sp.add_argument("jsonl", nargs="+")
    sp.set_defaults(fn=cmd_extracts)

    sp = sub.add_parser("status", help="render/crop progress")
    sp.add_argument("issue_json")
    sp.add_argument("--wait", action="store_true",
                    help=f"poll every {POLL_SECONDS}s until pages and crops are done")
    sp.set_defaults(fn=cmd_status)

    sp = sub.add_parser("reset", help="delete status='auto' extracts (confirmed)")
    sp.add_argument("issue_json")
    sp.set_defaults(fn=cmd_reset)

    args = p.parse_args()
    args.base = args.base.rstrip("/")
    tok = moderation_token()
    try:
        args.fn(args, tok)
    except Fail as e:
        die(str(e))
    except KeyboardInterrupt:
        die("interrupted", 130)

if __name__ == "__main__":
    main()
