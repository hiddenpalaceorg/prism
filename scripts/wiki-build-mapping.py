#!/usr/bin/env python3
"""Build the bidirectional wiki-article <-> download-file mapping for the
Hidden Palace wiki, from the MediaWiki API (read-only, anonymous).

The wiki's own model is authoritative:
  * Category:Pages with downloads   — every article that has a download
  * {{Download|file=...}}            — names each local download File:
  * {{Download|external=...}}        — an off-site mirror (recorded, not local)
For each local File: we resolve imageinfo (url, size, sha1, mime, mediatype)
and derive its on-disk path in the MinIO `files` bucket: the file is served at
https://files.hiddenpalace.org/<hash>/<name> and stored verbatim at
<bucket-root>/<hash>/<name> (MinIO fs backend — plain files).

Output JSON (for safekeeping and to drive curator analysis):
  {
    "meta": {...},
    "articles": { "<title>": {"url":..,"downloads":[{file,url,disk_path,sha1,size,mime,mediatype,external?}]} },
    "files":    { "<File:title>": {"disk_path":..,"sha1":..,"size":..,"articles":[..]} }
  }

Usage:
  wiki-build-mapping.py --out mapping.json [--api http://127.0.0.1:8080/w/api.php]
      [--host-header hiddenpalace.org] [--bucket-root /var/lib/minio/files]
      [--files-host files.hiddenpalace.org] [--limit N]

Defaults target running ON the wiki server (localhost API with a Host header).
"""
import argparse, json, re, sys, time, urllib.parse, urllib.request
from collections import defaultdict

class ApiError(Exception):
    """A MediaWiki API error response (carries the error code)."""
    def __init__(self, code, info):
        self.code = code
        super().__init__(f"{code}: {info}")


DOWNLOAD_RE = re.compile(r"\{\{\s*[Dd]ownload\b(.*?)\}\}", re.S)
PARAM_RE = re.compile(r"\|\s*([A-Za-z0-9_]+)\s*=\s*(.*?)(?=\||$)", re.S)
# Match the {{Prototype}} infobox exactly — not {{Prototype Footer}} or
# {{Navbox prototype}}: the name must be followed (after optional ws) by | or }.
PROTO_OPEN = re.compile(r"\{\{\s*Prototype\s*(?=[|}])")
REGIONDATE_RE = re.compile(r"\{\{\s*RegionDate\s*\|\s*([^|}]+?)\s*\|\s*([^|}]+?)\s*\}\}")


def balanced_template(wt, start):
    """Return the full {{...}} block starting at index `start` (handles nesting)."""
    depth, i = 0, start
    while i < len(wt):
        if wt[i:i + 2] == "{{":
            depth += 1; i += 2
        elif wt[i:i + 2] == "}}":
            depth -= 1; i += 2
            if depth == 0:
                return wt[start:i]
        else:
            i += 1
    return wt[start:]  # unbalanced; return the rest


def split_top_pipes(s):
    """Split on `|` only at brace/bracket depth 0 (so nested templates survive)."""
    parts, buf, depth, i = [], [], 0, 0
    while i < len(s):
        two = s[i:i + 2]
        if two in ("{{", "[["):
            depth += 1; buf.append(two); i += 2
        elif two in ("}}", "]]"):
            depth -= 1; buf.append(two); i += 2
        elif s[i] == "|" and depth == 0:
            parts.append("".join(buf)); buf = []; i += 1
        else:
            buf.append(s[i]); i += 1
    parts.append("".join(buf))
    return parts


def parse_prototype(wt):
    """Extract the {{Prototype}} infobox params as {name: raw_value}, or None."""
    m = PROTO_OPEN.search(wt)
    if not m:
        return None
    block = balanced_template(wt, m.start())
    inner = block[2:-2] if block.endswith("}}") else block[2:]
    segs = split_top_pipes(inner)
    params = {}
    for seg in segs[1:]:  # segs[0] is the template name ("Prototype")
        key, eq, val = seg.partition("=")
        if eq:
            params[key.strip()] = val.strip()
    return params


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--list-out", help="also write deduped local disk paths here (feeds curator --list)")
    ap.add_argument("--proto-out", help="also write the article -> {{Prototype}} metadata mapping here")
    ap.add_argument("--api", default="http://127.0.0.1:8080/w/api.php")
    ap.add_argument("--host-header", default="hiddenpalace.org")
    ap.add_argument("--category", default="Category:Pages with downloads")
    ap.add_argument("--bucket-root", default="/var/lib/minio/files")
    ap.add_argument("--files-host", default="files.hiddenpalace.org")
    ap.add_argument("--limit", type=int, default=0, help="cap articles (0 = all; for testing)")
    args = ap.parse_args()

    hdr = {"Host": args.host_header} if args.host_header else {}
    skipped = []          # titles we're not allowed to read (scope: public only)
    RETRYABLE = {"maxlag", "readonly", "internal_api_error_DBQueryError"}

    def api(**params):
        # POST (titles in the body) so large batches never hit URL-length limits;
        # maxlag asks a busy live wiki to defer us rather than erroring hard.
        params.update(format="json", maxlag="5")
        data = urllib.parse.urlencode(params).encode()
        last = None
        for attempt in range(8):
            try:
                req = urllib.request.Request(args.api, data=data, headers=hdr)
                with urllib.request.urlopen(req, timeout=90) as r:
                    j = json.load(r)
            except Exception as e:  # network/timeout — retry
                last = e; time.sleep(2 * (attempt + 1)); continue
            if "error" in j:
                code = j["error"].get("code", "")
                info = j["error"].get("info", code)
                if code in RETRYABLE:  # transient — back off and retry
                    last = ApiError(code, info); time.sleep(2 * (attempt + 1)); continue
                raise ApiError(code, info)  # e.g. permissiondenied — not retryable
            return j
        raise last or RuntimeError("api: exhausted retries")

    def titles_query(all_titles, **q):
        """Run a titles-bearing query in batches of 50, bisecting around any
        title the API refuses (restricted prototypes) so one forbidden title
        doesn't sink its batch. Returns (pages_by_title, normalized_map);
        unreadable singles are appended to `skipped`."""
        pages, normmap = {}, {}
        def run(ts):
            if not ts:
                return
            try:
                r = api(titles="|".join(ts), **q)
            except ApiError:
                if len(ts) == 1:
                    skipped.append(ts[0]); return
                mid = len(ts) // 2
                run(ts[:mid]); run(ts[mid:]); return
            for n in r["query"].get("normalized", []):
                normmap[n["from"]] = n["to"]
            for pg in r["query"]["pages"].values():
                pages[pg["title"]] = pg
        for i in range(0, len(all_titles), 50):
            run(all_titles[i : i + 50])
            sys.stderr.write(f"  fetched {min(i+50, len(all_titles))}/{len(all_titles)}\r")
        sys.stderr.write("\n")
        return pages, normmap

    # 1. Enumerate articles in the downloads category.
    titles, cont = [], {}
    while True:
        r = api(action="query", list="categorymembers", cmtitle=args.category,
                cmnamespace=0, cmlimit=500, **cont)
        titles += [m["title"] for m in r["query"]["categorymembers"]]
        if "continue" in r and not args.limit:
            cont = r["continue"]
        else:
            break
        if args.limit and len(titles) >= args.limit:
            break
    if args.limit:
        titles = titles[: args.limit]
    sys.stderr.write(f"articles in '{args.category}': {len(titles)}\n")

    # 2. From each article's wikitext (one batched fetch): the {{Download}}
    #    blocks (article -> [{file?, external?, ...}]) and, if --proto-out, the
    #    {{Prototype}} infobox metadata (article -> {param: value}).
    art_downloads = {}
    art_proto = {}
    pages, _ = titles_query(titles, action="query", prop="revisions",
                            rvprop="content", rvslots="main")
    for t in titles:
        pg = pages.get(t)  # restricted (skipped) or missing -> absent
        try:
            wt = pg["revisions"][0]["slots"]["main"]["*"]
        except (TypeError, KeyError, IndexError):
            continue
        blocks = []
        for body in DOWNLOAD_RE.findall(wt):
            params = {k: v.strip() for k, v in PARAM_RE.findall(body)}
            if params:
                blocks.append(params)
        art_downloads[t] = blocks
        if args.proto_out:
            art_proto[t] = parse_prototype(wt)
    if skipped:
        sys.stderr.write(f"  skipped {len(skipped)} restricted article(s) (not public)\n")

    # 3. Collect referenced local File: titles, resolve imageinfo (batched).
    def norm_file(name):
        name = name.strip().replace("_", " ")
        return name if name.lower().startswith("file:") else "File:" + name

    wanted = set()
    for blocks in art_downloads.values():
        for b in blocks:
            if b.get("file"):
                wanted.add(norm_file(b["file"]))
    wanted = sorted(wanted)
    sys.stderr.write(f"distinct local download files: {len(wanted)}\n")

    info = {}  # File:title -> imageinfo dict (or None if missing/unreadable)
    pages, normmap = titles_query(wanted, action="query", prop="imageinfo",
                                  iiprop="url|size|sha1|mime|mediatype")
    for req_title in wanted:
        pg = pages.get(normmap.get(req_title, req_title))
        info[req_title] = pg["imageinfo"][0] if pg and "imageinfo" in pg else None

    def disk_path(url):
        u = urllib.parse.urlparse(url)
        if u.hostname != args.files_host:
            return None  # served from somewhere we don't have on disk
        return args.bucket_root + urllib.parse.unquote(u.path)

    # 4. Assemble bidirectional mapping.
    articles = {}
    files = defaultdict(lambda: {"disk_path": None, "sha1": None, "size": None,
                                 "mime": None, "mediatype": None, "articles": []})
    missing, external_only = 0, 0
    for t, blocks in art_downloads.items():
        base = args.host_header or args.files_host
        dls = []
        for b in blocks:
            if b.get("file"):
                ft = norm_file(b["file"])
                ii = info.get(ft)
                if not ii:
                    missing += 1
                    dls.append({"file": ft, "missing": True,
                                "external": b.get("external")})
                    continue
                dp = disk_path(ii["url"])
                entry = {"file": ft, "url": ii["url"], "disk_path": dp,
                         "sha1": ii.get("sha1"), "size": ii.get("size"),
                         "mime": ii.get("mime"), "mediatype": ii.get("mediatype")}
                if b.get("external"):
                    entry["external"] = b["external"]
                dls.append(entry)
                f = files[ft]
                f.update(disk_path=dp, sha1=ii.get("sha1"), size=ii.get("size"),
                         mime=ii.get("mime"), mediatype=ii.get("mediatype"))
                if t not in f["articles"]:
                    f["articles"].append(t)
            elif b.get("external"):
                external_only += 1
                dls.append({"external": b["external"]})
        articles[t] = {
            "url": f"http://{base}/" + urllib.parse.quote(t.replace(" ", "_")),
            "downloads": dls,
        }

    out = {
        "meta": {
            "source": args.api, "category": args.category,
            "bucket_root": args.bucket_root, "files_host": args.files_host,
            "articles": len(articles), "local_files": len(files),
            "missing_files": missing, "external_only_downloads": external_only,
            "restricted_skipped": len(skipped),
        },
        "articles": articles,
        "files": files,
    }
    with open(args.out, "w") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
    sys.stderr.write(
        f"wrote {args.out}: {len(articles)} articles, {len(files)} local files, "
        f"{missing} missing, {external_only} external-only\n")

    if args.list_out:
        paths = sorted({f["disk_path"] for f in files.values() if f["disk_path"]})
        with open(args.list_out, "w") as fh:
            fh.write("\n".join(paths) + ("\n" if paths else ""))
        sys.stderr.write(f"wrote {args.list_out}: {len(paths)} local download paths\n")

    if args.proto_out:
        base = args.host_header or args.files_host
        proto_articles, with_proto = {}, 0
        for t, params in art_proto.items():
            entry = {"url": f"http://{base}/" + urllib.parse.quote(t.replace(" ", "_")),
                     "prototype": params}
            if params:
                with_proto += 1
                # Convenience: parse {{RegionDate|R|D}} out of any field that has them.
                regions = {}
                for k, v in params.items():
                    rds = [{"region": r, "date": d} for r, d in REGIONDATE_RE.findall(v)]
                    if rds:
                        regions[k] = rds
                if regions:
                    entry["regions"] = regions
            proto_articles[t] = entry
        proto_out = {
            "meta": {"source": args.api, "category": args.category,
                     "articles": len(proto_articles),
                     "with_prototype": with_proto,
                     "without_prototype": len(proto_articles) - with_proto,
                     "restricted_skipped": len(skipped)},
            "articles": proto_articles,
        }
        with open(args.proto_out, "w") as fh:
            json.dump(proto_out, fh, indent=1, ensure_ascii=False)
        sys.stderr.write(
            f"wrote {args.proto_out}: {len(proto_articles)} articles, "
            f"{with_proto} with {{{{Prototype}}}}, "
            f"{len(proto_articles) - with_proto} without\n")


if __name__ == "__main__":
    main()
