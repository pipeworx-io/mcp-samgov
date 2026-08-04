# SAM.gov — Federal Procurement and Entity Registration

The U.S. General Services Administration's System for Award Management. The authoritative source for federal contract opportunities, entity (vendor) registrations, set-aside designations, exclusion records (debarments), and assistance listings. Required reading for anyone selling to the federal government.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Why this matters for AI agents

Three distinct surfaces:

**1. Contract opportunities** (RFPs, RFQs, sources sought, etc.) — what the federal government is currently buying. → `sam_search_opportunities({keyword})`. For one specific solicitation: `sam_get_opportunity({solicitation_number})`.

**2. Entity records** — registered vendors with CAGE codes, UEIs, NAICS codes, certifications. → `sam_entity_search({business_name})`.

**3. Set-aside opportunities** — small business, veteran-owned, women-owned, HUBZone, etc. → `sam_set_aside_opportunities({set_aside})`.

Pair with [USAspending](/docs/reference/usaspending) (post-award contract data) and the `govcon_contractor_profile` compound for full agent flows.

## Auth

SAM.gov requires a free API key from https://sam.gov/data-services. Pass via `_apiKey`. Production keys have generous limits; testing keys (no signup) are heavily throttled.

## Use cases that work well

- **"What's the federal government buying for cybersecurity?"** → `sam_search_opportunities({keyword: "cybersecurity"})` → active RFPs.
- **"Find SBIR/STTR small-business set-asides for AI."** → `sam_set_aside_opportunities({set_aside: "SBIR"})` filtered by description.
- **"Is X registered with the federal government?"** → `sam_entity_search({business_name: "X"})` → CAGE/UEI plus NAICS coverage.
- **"Are they on the exclusion list?"** → exclusion search via the same tool, filtered.

## Common pitfalls

- **Solicitation lifecycle states.** "Active," "Archived," "Awarded," "Cancelled" — opportunities move between states. Filter to "Active" for current-action items.
- **NAICS code matters.** Companies register under specific NAICS codes; SAM.gov restricts which contracts they can compete for. An agent doing competitive intelligence needs to read NAICS, not just company name.
- **UEI replaced DUNS.** Since April 2022, SAM.gov uses Unique Entity Identifier (UEI) instead of DUNS numbers. Old data references DUNS; new data uses UEI. The `sam_entity_search` returns both for cross-referencing.
- **Query language is keyword-based, not full-text.** Searches match titles + key fields; long descriptive queries return fewer results than focused ones. Start narrow.
- **Set-aside filtering.** Common set-aside codes: `SBA` (Small Business), `8A` (8(a) program), `WOSB` (Women-Owned), `SDVOSBC` (Service-Disabled Veteran-Owned), `HZC` (HUBZone), `SBIR` (SBIR/STTR). Wrong code = empty result, not error.
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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Samgov data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
