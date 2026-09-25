# SAM.gov — Federal Procurement and Entity Registration

The U.S. General Services Administration's System for Award Management. The authoritative source for federal contract opportunities, entity (vendor) registrations, set-aside designations, exclusion records (debarments), and assistance listings. Required reading for anyone selling to the federal government.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Why this matters for AI agents

Three distinct surfaces:

**1. Contract opportunities** (RFPs, RFQs, sources sought, etc.) — what the federal government is currently buying. → `sam_search_opportunities({keyword})`. For one specific solicitation: `sam_get_opportunity({solicitation_number})`.

**2. Entity records** — registered vendors with CAGE codes, UEIs, NAICS codes, certifications. → `sam_entity_search({business_name})`.

**3. Set-aside opportunities** — small business, veteran-owned, women-owned, HUBZone, etc. → `sam_set_aside_opportunities({set_aside})`.

Pair with [USAspending](/docs/reference/usaspending) (post-award contract data) and the `govcon_contractor_profile` compound for full agent flows.

## Auth

SAM.gov requires a free API key from https://sam.gov/data-services. Pass via `_apiKey`. The shared `PLATFORM_SAM_KEY` the gateway falls back to when a caller supplies none is a **personal-tier key with a hard 10-request DAILY quota** — measured live 2026-09-01: it answered exactly ten calls and returned `900804 Message throttled out` for the rest of the UTC day, with `nextAccessTime` set to the next midnight UTC. See the mirror note below for why `sam_search_opportunities` mostly doesn't need it anymore. **Entity search and exclusion search no longer need a key either** (migration 135): both answer from local snapshots of SAM.gov's public Entity Registration and Exclusions extracts. Verified live 2026-09-13 with no key supplied — `sam_entity_search` returned Lockheed Martin from an 889,932-row mirror and `sam_search_exclusions` answered from a 168,462-row one. Only `sam_get_opportunity` and `sam_set_aside_opportunities` still hit the live, key-gated API on every call; `sam_entity_search` also does when you pass `live:true`.

**A key of your own is worth bringing.** GSA sets the quota by what the ACCOUNT carries, not by what you pay: a non-federal personal key with no SAM.gov role gets 10/day (that is the tier the shared key sits on), the same key gets 1,000/day once the account carries a role, and a non-federal system account also gets 1,000/day — all free (<https://open.gsa.gov/api/entity-api/>). So passing `_apiKey` is not a workaround for a Pipeworx limit, it is a 100x larger allowance for a profile change.

When the shared key is spent, these tools do not return a bare upstream error: they say the quota is a daily one, quote the exact reset instant SAM.gov reported, and name both remedies (`_apiKey`, or `sam_search_opportunities`, which answers keyword searches with no key at all). A daily quota cannot be retried out of, and an agent that is not told so will keep trying.

## Data mirror (fleet #343)

`sam_search_opportunities` reads a Supabase mirror **first**, before ever spending the shared API key: SAM.gov publishes the entire Contract Opportunities list as a public daily CSV extract, no key and no rate limit — <https://s3.amazonaws.com/falextracts/Contract%20Opportunities/datagov/ContractOpportunitiesFullCSV.csv> (the same `falextracts` bucket linked from SAM.gov's own Data Services page). A GitHub Actions job (`scripts/samgov-upsert.sh`, schedule in `.github/workflows/samgov-refresh.yml`) loads it into `samgov_opportunities` daily.

The mirror ranks matches by relevance (`rpc/search_samgov_opportunities`, migration 075) rather than a plain title-or-description filter: `title` is weighted well above `description` (`setweight()` + `ts_rank_cd`). Two earlier cuts got this wrong, both caught live: a plain description match on "cybersecurity" returned Navy hardware notices (HOSE,NONMETALLIC, a WASHER) whose boilerplate DFARS/NIST clause text happened to contain the word, ahead of the opportunities actually about cybersecurity; a title-first/description-fallback split then hit the same problem one tier down — "cloud computing" fell to the description tier and surfaced a water-tank repair and an MRI renovation, because SAM.gov's posting templates insert standard cloud-computing-services clause language into unrelated notices regardless of scope, and `phraseto_tsquery` still matches that literal boilerplate phrase. Ranking fixes it at the source: a title hit contributes ~2.5x what a single description mention does, so it floats to the top of one result set instead of needing a hard tier cutoff to get right. Still strictly broader than the live API's `title=` parameter (fixed from a nonexistent `keyword=` param in fleet #311) — that only ever matches title at all. Every `sam_search_opportunities` response carries a `mirror` object reporting the snapshot's freshness (`snapshot_date`, `rows_in_mirror`) regardless of which path answered. The live API is used only when: no mirror is configured/loaded, or an explicit `posted_from` reaches past the mirror's `snapshot_date` (the default 30-day window never triggers this — only an argument you actually passed does). Single-opportunity lookup and set-aside search are unaffected — endpoint families the opportunities CSV doesn't cover, always live. Entity search and exclusions have since gained mirrors of their own (migration 135) and answer keyless by default.

## Use cases that work well

- **"What's the federal government buying for cybersecurity?"** → `sam_search_opportunities({keyword: "cybersecurity"})` → active RFPs.
- **"Find SBIR/STTR small-business set-asides for AI."** → `sam_set_aside_opportunities({set_aside: "SBIR"})` filtered by description.
- **"Is X registered with the federal government?"** → `sam_entity_search({business_name: "X"})` → CAGE/UEI plus NAICS coverage.
- **"Are they on the exclusion list?"** → `sam_search_exclusions` (keyless). **It answers "barred TODAY", not "ever barred":** SAM.gov's daily Exclusions extract publishes only exclusions currently in force, so a debarment that has since been terminated is absent from the source entirely. `include_terminated` is accepted but cannot surface those — measured 2026-09-13, 400 sampled rows across four names with the filter disabled returned zero past termination dates. Treat an empty result accordingly.

## Common pitfalls

- **Solicitation lifecycle states.** "Active," "Archived," "Awarded," "Cancelled" — opportunities move between states. Filter to "Active" for current-action items.
- **NAICS code matters.** Companies register under specific NAICS codes; SAM.gov restricts which contracts they can compete for. An agent doing competitive intelligence needs to read NAICS, not just company name.
- **UEI replaced DUNS.** Since April 2022, SAM.gov uses Unique Entity Identifier (UEI) instead of DUNS numbers. Old data references DUNS; new data uses UEI. The `sam_entity_search` returns both for cross-referencing.
- **Query language, mirror vs. live.** The mirror path (the common case) full-text-matches title AND description, so a descriptive phrase works fine. The live-API fallback path only matches title, so a long descriptive query there returns fewer results than a focused one — check the response's `source` field (`sam.gov-mirror` vs `sam.gov-live`) if results look thinner than expected.
- **Set-aside filtering.** Common set-aside codes: `SBA` (Small Business), `8A` (8(a) program), `WOSB` (Women-Owned), `SDVOSBC` (Service-Disabled Veteran-Owned), `HZC` (HUBZone), `SBIR` (SBIR/STTR). Wrong code = empty result, not error.
- **Short/common-word acronyms lose precision on the mirror.** `"IT services"` degrades badly — Postgres's `english` FTS config treats "IT" as a stopword and drops it, so the query silently becomes just `"services"` (~12k matches, mostly unrelated). `"artificial intelligence"`, `"cybersecurity"`, `"cloud computing"` and other multi-syllable/distinctive terms rank well; a bare 2-letter acronym doesn't. Prefer the spelled-out phrase ("information technology services", "help desk support") when the short form is a common English word.
- **Geography is loose.** "Place of performance" is the contracting location, not the awarding agency's location.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "samgov": {
      "url": "https://gateway.pipeworx.io/samgov/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/samgov/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/sam_search_opportunities \
  -H 'Content-Type: application/json' \
  -d '{"keyword":"software development","naics":"541512","posted_from":"01/01/2024","posted_to":"12/31/2024","limit":20}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/sam_search_opportunities`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "samgov": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-samgov"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-samgov
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Samgov data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
