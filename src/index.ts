interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * The class routing tokens, and the two safe ways to wrap a message carrying one.
 *
 * A pack signals an error's class with a leading token — `user_error:`,
 * `upstream_down:`, `upstream_throttled:`, `not_found:`, `blocked_host:`. The
 * gateway's classifier anchors on `^`, and `stripClassPrefix` (which hides the
 * token from the caller) anchors on `^` too. So the convention has one failure
 * mode, and it is silent: a catch block that wraps the message —
 * `` `${slug}/${tool}: ${message}` `` — pushes the token off position 0. The
 * error then books as `error` ("Pipeworx has a defect") instead of as the
 * caller mistake it is, AND the raw token leaks into what the caller reads.
 *
 * Nothing about that fails loudly. The call still returns, the message still
 * reads plausibly, and the misclassification only shows up as a pack sitting on
 * the Problem Tools list for a bug it does not have. Found live in
 * `medicaid-intelligence` on 2026-08-21; the same wrapper template is copied
 * across 18 DMV packs, none of which emit a token *yet*.
 *
 * `scripts/check-error-class-prefix.mjs` is the gate that keeps this honest —
 * it fails any pack that both emits a token and wraps a caught message without
 * using one of the helpers below.
 */

/**
 * The canonical token set. `workers/gateway/src/error-class.ts` carries its own
 * copy on the read side (it is deliberately importable without pulling a pack
 * in); the gate asserts the two agree, because this list has already drifted
 * twice — `not_found:` and `blocked_host:` were honoured by the classifier and
 * not stripped, so both went out to callers verbatim for months.
 */
const CLASS_TOKENS = [
  'upstream_down',
  'upstream_throttled',
  'user_error',
  'not_found',
  'blocked_host',
  // `blocked_url:` is emitted at position 0 from five sites in ssrf.ts
  // (`assertPublicHttpUrl`, and every redirect hop in `safeFetch`) and was in
  // NEITHER reader — so it went to callers verbatim for its whole life. Caught
  // 2026-08-21 by a live n8n call, which answered a private instance_url with
  // "…host). blocked_url: refusing to fetch non-public or non-https URL".
  // Exactly the drift the gate now blocks.
  'blocked_url',
  // `auth_required:` joins the list 2026-08-29 (fleet #638). It exists for the
  // same reason `user_error:` does: a bare 401/403 in an upstream body matches
  // the `upstream_throttled` heuristic below before anything auth-specific, so
  // a pack that needs to say "this is a credential problem, not a rate limit"
  // has no wording-based route — only the explicit-prefix escape hatch works.
  // tiingo and open-sanctions both reached for it on their own, on the
  // (reasonable, but wrong at the time) assumption that any snake_case class
  // already meant something to the gateway. Neither shipped a leak from
  // MIS-CLASSIFICATION — the `error` field was already correct — the leak was
  // the literal token riding along in `message`, unstripped, because this list
  // didn't know the token either reader was seeing.
  'auth_required',
] as const;

const CLASS_PREFIX_RE =
  /^(?:upstream_down|upstream_throttled|user_error|not_found|blocked_host|blocked_url|auth_required)\s*:\s*/;

/**
 * Split a caught message into its leading routing token (possibly empty) and
 * the human-readable body, so a wrapper can put the token back on the front.
 *
 *   const { token, body } = splitClassPrefix(message);
 *   return { error: `${token}my-pack/${name}: ${body}` };
 *
 * The `${token}` must be the FIRST thing in the template — that is the whole
 * point, and it is what the gate checks.
 */
function splitClassPrefix(message: string): { token: string; body: string } {
  const token = message.match(CLASS_PREFIX_RE)?.[0] ?? '';
  return { token, body: message.slice(token.length) };
}

/**
 * Drop a leading routing token from a message that is about to become a
 * FRAGMENT of a larger one — a per-mirror failure joined into "all providers
 * failed (...)", say. Hoisting is wrong there: the fragment never reaches
 * position 0, so the token cannot route anything and would only leak. The outer
 * message declares its own class.
 */
function dropClassPrefix(message: string): string {
  return message.replace(CLASS_PREFIX_RE, '');
}


/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * SAM.gov MCP — Federal contract opportunities and entity registration data
 *
 * BYO key: requires a free SAM.gov API key from https://sam.gov/content/entity-information
 * Passed via _apiKey parameter. The gateway also injects a shared
 * PLATFORM_SAM_KEY when a caller supplies none — see the mirror note below
 * for why sam_search_opportunities no longer depends on that quota for the
 * common case.
 *
 * That shared key is on GSA's personal tier: 10 requests per DAY, re-measured
 * live 2026-09-01 (fleet #774) — ten calls answered, then 900804 for the rest
 * of the UTC day. It is 10/day because the SAM.gov ACCOUNT behind it carries
 * no role, not because of anything we pay; the same key returns 1,000/day once
 * it does (https://open.gsa.gov/api/entity-api/). A caller's own key is
 * therefore worth 100x this one, which is what the throttle message says.
 *
 * Tools:
 * - sam_search_opportunities: search active federal contract opportunities.
 *   MIRROR-FIRST (fleet #343): reads a Supabase mirror of SAM.gov's public
 *   daily Contract Opportunities CSV extract before ever touching the live
 *   API. Ranked full-text search (RPC search_samgov_opportunities, migration
 *   075): title weighted well above description (setweight A/B +
 *   ts_rank_cd), so a genuine title hit floats above an incidental
 *   boilerplate description mention (SAM.gov notice templates insert
 *   standard DFARS/GSA cyber and cloud-computing clause language into
 *   unrelated notices) — strictly broader than the live API's title-only
 *   match (see the #311 note on searchOpportunities below), without an
 *   unrelated hardware notice outranking one actually on topic. Falls back
 *   to the live API only when an explicit posted_from reaches past the
 *   mirror's snapshot date. Every response carries a `mirror` field with
 *   the snapshot's freshness, whichever path served it.
 * - sam_get_opportunity: get full details for a specific opportunity by solicitation number
 * - sam_entity_search: search registered entities/vendors in SAM. Mirror-first
 *   since migration 135 (its own public Entity Registration extract, ~890k
 *   rows) and therefore keyless; live:true spends the key for today's registry.
 * - sam_search_exclusions: the federal debarment list. Also mirror-first since
 *   migration 135 and keyless. IMPORTANT: SAM.gov's daily Exclusions extract
 *   publishes only exclusions IN FORCE, so this source cannot answer "was this
 *   party ever debarred" — only "are they barred today". `include_terminated`
 *   is accepted for compatibility and is inert on BOTH paths (the mirror has no
 *   terminated rows to include; the live path never forwards the parameter
 *   upstream). Measured 2026-09-13: 400 sampled rows across four names, filter
 *   explicitly disabled, zero past termination dates.
 * - sam_set_aside_opportunities: search opportunities by small business set-aside type
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Samgov');
}


const OPPS_BASE = 'https://api.sam.gov/opportunities/v2/search';
const ENTITY_BASE = 'https://api.sam.gov/entity-information/v3/entities';
const EXCLUSIONS_BASE = 'https://api.sam.gov/entity-information/v4/exclusions';

/**
 * The key is OPTIONAL here and required only by the tools that actually reach
 * SAM.gov's live API.
 *
 * This used to throw for every tool the moment no key was present — including
 * the opportunity searches, which answer from the local snapshot of SAM.gov's
 * public extract without any key at all. That was survivable only while a
 * platform key was fronted; once
 * samgov went BYO-key (Bruce, 2026-09-01, fleet #980/#1007) an unkeyed caller
 * would have been refused by the keyless path too, turning "you need a key for
 * entity lookups" into "you need a key for everything".
 *
 * Callers that DO need it get `requireKey`, whose message says "requires an API
 * key" in those words — the quality suite books a gated refusal as a correct
 * refusal on that wording and as a Pipeworx defect without it.
 */
function extractKey(args: Record<string, unknown>): string {
  const key = typeof args._apiKey === 'string' ? args._apiKey.trim() : '';
  delete args._apiKey;
  return key;
}

function requireKey(key: string, what: string): string {
  if (key) return key;
  throw new Error(
    `${what} requires an API key. SAM.gov gates entity and exclusion records behind one; it is free at https://sam.gov/content/entity-information — pass it as _apiKey. A key on an account carrying a SAM.gov role allows 1,000 requests/day. Opportunity searches (sam_search_opportunities, sam_set_aside_opportunities) need no key at all.`,
  );
}

// SAM.gov's throttle body carries the one fact a caller needs and nothing else
// does: WHEN the quota comes back. Captured live 2026-09-01:
// `{"code":"900804","message":"Message throttled out","description":"You have
//   exceeded your quota .You can access API after 2026-Sep-02 00:00:00+0000 UTC",
//   "nextAccessTime":"2026-Sep-02 00:00:00+0000 UTC"}`
// Prefer the `nextAccessTime` field; the same value also sits in `description`
// as prose, which is the fallback if they ever drop the structured copy.
function samQuotaResetFrom(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { nextAccessTime?: unknown; description?: unknown };
    if (typeof parsed.nextAccessTime === 'string' && parsed.nextAccessTime.trim()) {
      return parsed.nextAccessTime.trim();
    }
    if (typeof parsed.description === 'string') {
      const m = /You can access API after (.+?)\s*$/i.exec(parsed.description);
      if (m) return m[1].trim();
    }
  } catch { /* not JSON — fall through to the prose scan below */ }
  const m = /You can access API after ([^"]+?)(?:\\?"|$)/i.exec(body);
  return m ? m[1].trim() : null;
}

async function samFetch(url: string): Promise<unknown> {
  const res = await pwFetch(url, {
    headers: { 'User-Agent': 'Pipeworx/1.0 (gateway.pipeworx.io)' },
  });
  if (!res.ok) {
    const text = await res.text();
    // A spent daily quota is not an outage and is not something retrying fixes,
    // but the raw upstream body says so only in a JSON blob most callers never
    // read — so an agent that hit it would retry until the day rolled over.
    // Verified live 2026-09-01: the shared key answered 10 calls and then
    // returned 900804 for the rest of the UTC day. Say the three things that
    // let the caller recover NOW: what ran out, when it returns, and that a
    // free SAM.gov key of their own carries 100x this allowance.
    if (res.status === 429) {
      const reset = samQuotaResetFrom(text);
      throw new Error(
        'upstream_throttled: The SAM.gov key Pipeworx shares across all callers is a personal-tier key with a 10-request DAILY quota, and it is spent for the current UTC day' +
        (reset ? ` (SAM.gov says it returns after ${reset})` : '') +
        '. Retrying sooner cannot succeed. To get an answer now, pass your own SAM.gov API key as _apiKey — it is free at https://sam.gov/content/entity-information and a key on an account with a SAM.gov role carries 1,000 requests/day. sam_search_opportunities answers keyword searches without any key at all, from SAM.gov\'s public Contract Opportunities extract.',
      );
    }
    throw new Error(`SAM.gov API error (${res.status}): ${text}`);
  }
  return res.json();
}

// ── Tool definitions ────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'sam_search_opportunities',
    description:
      'Search active federal contract opportunities by keyword, NAICS code (e.g., "541512"), set-aside type, posting date range, and procurement type. Searches SAM.gov\'s public Contract Opportunities extract, refreshed daily, without spending an API key — ranking matches by relevance with the opportunity TITLE weighted well above its description, so a genuine title hit outranks a notice whose boilerplate contract-clause text happens to mention the term. Returns titles, solicitation numbers, deadlines, and agencies, plus a `mirror` field reporting how fresh that snapshot is. SAM.gov requires a posting date range — if you omit posted_from/posted_to, we default to the last 30 days. Accepts query / q / keywords as aliases for keyword.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        keyword: { type: 'string', description: 'Search term for opportunity title or description. query, q, keywords accepted as aliases.' },
        query: { type: 'string', description: 'Alias for keyword.' },
        q: { type: 'string', description: 'Alias for keyword.' },
        keywords: { type: 'string', description: 'Alias for keyword.' },
        naics: { type: 'string', description: 'NAICS code to filter by (e.g., "541512" for computer systems design)' },
        set_aside: {
          type: 'string',
          description: 'Small business set-aside type: SBA (Small Business), SDVOSB (Service-Disabled Veteran), HUBZone, 8AN (8(a)), WOSB (Women-Owned), EDWOSB (Economically Disadvantaged Women-Owned)',
        },
        posted_from: { type: 'string', description: 'Start of posting date range in MM/dd/yyyy format. Defaults to 30 days ago if omitted.' },
        posted_to: { type: 'string', description: 'End of posting date range in MM/dd/yyyy format. Defaults to today if omitted.' },
        limit: { type: 'number', description: 'Number of results to return (1-100, default 10)' },
        offset: { type: 'number', description: 'Result offset for pagination (default 0)' },
        ptype: {
          type: 'string',
          description: 'Procurement type filter: p (presolicitation), o (solicitation), k (combined synopsis/solicitation), a (award notice)',
        },
        _apiKey: { type: 'string', description: 'Optional — omit it. This search answers keyless from the local snapshot of SAM.gov\'s public Contract Opportunities extract; a key is needed only to reach postings newer than that snapshot.' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'sam_get_opportunity',
    description:
      'Get full details for a federal contract opportunity by solicitation number. Returns description, contact info, deadlines, attachments, NAICS codes, and set-aside status — the fields sam_search_opportunities does not carry. SAM.gov searches a posting-date range and caps it at one year: we resolve the solicitation\'s posting date automatically where we can and otherwise search the last year, so pass posted_from/posted_to only for an older solicitation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        solicitation_number: { type: 'string', description: 'The solicitation number to look up (e.g., "N6133126R3101")' },
        posted_from: { type: 'string', description: 'Optional MM/DD/YYYY start of the posting-date window; only needed for a solicitation older than a year' },
        posted_to: { type: 'string', description: 'Optional MM/DD/YYYY end of the posting-date window' },
        _apiKey: { type: 'string', description: 'SAM.gov API key — required. Free at https://sam.gov/content/entity-information; a key on an account with a SAM.gov role allows 1,000 requests/day.' },
      },
      required: ['solicitation_number', '_apiKey'],
    },
  },
  {
    name: 'sam_entity_search',
    description:
      'Look up federal contractors registered in SAM.gov by business name, UEI, or CAGE code. Returns UEI, CAGE, legal and DBA name, address, NAICS and PSC codes, entity structure, registration and expiration dates, small-business/SBA certifications, and whether the entity carries an exclusion flag. Answers keyless from a local mirror of SAM.gov\'s public Entity Registration extract, ranking an exact UEI/CAGE/legal-name match above any fuzzy name hit and active registrations above expired ones. Every response carries a `mirror` field with the snapshot date and its age in days — the public entity extract is published MONTHLY, so an answer can legitimately be several weeks old; pass live:true with an API key when you need the registry as of today.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        business_name: { type: 'string', description: 'What to search for: a legal/DBA business name, or an exact UEI or CAGE code. Accepts query / q / name as aliases.' },
        naics: { type: 'string', description: 'Filter by NAICS code (optional) — matches the primary NAICS or any NAICS the entity lists.' },
        state: { type: 'string', description: 'Filter by 2-letter US state code (e.g., "VA", "CA")' },
        small_business: { type: 'boolean', description: 'Filter to only small business entities (optional)' },
        active_only: { type: 'boolean', description: 'Only entities with an active registration (default false — expired registrations are returned but sorted below active ones).' },
        limit: { type: 'number', description: 'Number of results (1-100, default 10).' },
        offset: { type: 'number', description: 'Rows to skip for paging (default 0).' },
        live: { type: 'boolean', description: 'Force a live SAM.gov API lookup instead of the mirror. Needs _apiKey. Use only when you specifically need registrations changed since the mirror snapshot — the live entity API is capped at 10 requests/day on the shared platform key.' },
        _apiKey: { type: 'string', description: 'Optional — omit it. This search answers keyless from the local snapshot of SAM.gov\'s public Entity Registration extract; a key is needed only for live:true.' },
      },
      required: ['business_name'],
    },
  },
  {
    name: 'sam_set_aside_opportunities',
    description:
      'Find federal contract opportunities reserved for a specific class of small business — total or partial small business, 8(a), women-owned (WOSB/EDWOSB), HUBZone, service-disabled veteran-owned (SDVOSB), veteran-owned, Indian small business economic enterprise and Buy Indian. Answers "what HUBZone contracts are open", "recent 8(a) set-asides", "women-owned small business opportunities in NAICS 541512". Reads SAM.gov\'s public daily Contract Opportunities extract, so it costs no API key and works on the plain code (SBA, HZC, SDVOSBC, 8A, WOSB) or on the ordinary phrasing ("HUBZone", "women-owned", "8(a)", "service-disabled veteran"). Returns titles, solicitation numbers, deadlines, agencies and NAICS, with a `mirror` field reporting how fresh the snapshot is.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        set_aside: {
          type: 'string',
          description: 'Set-aside type (required). Either the SAM.gov code — SBA (total small business), SBP (partial), 8A, 8AN (8(a) sole source), WOSB, EDWOSB, HZC (HUBZone), HZS (HUBZone sole source), SDVOSBC, SDVOSBS, VSA (veteran-owned), ISBEE, IEE, BICiv — or the ordinary phrasing ("small business", "HUBZone", "women-owned", "8(a)", "service-disabled veteran"), which is resolved to the code for you.',
        },
        keyword: { type: 'string', description: 'Optional keyword to narrow results' },
        naics: { type: 'string', description: 'Optional NAICS code filter' },
        limit: { type: 'number', description: 'Number of results to return (1-100, default 10)' },
        _apiKey: { type: 'string', description: 'Optional — omit it. This search answers keyless from the local snapshot of SAM.gov\'s public Contract Opportunities extract; a key is needed only to reach postings newer than that snapshot.' },
      },
      required: ['set_aside'],
    },
  },
  {
    name: 'sam_search_exclusions',
    description:
      'Search the SAM.gov Exclusions list — parties DEBARRED, suspended, or otherwise excluded from receiving federal contracts, grants, or assistance. Answers "is this company/person barred from federal contracting" for KYB / vendor-vetting / procurement due diligence. Filter by name, US state, and classification (Firm / Individual / Vessel / Special Entity). Returns each excluded party with the exclusion type, program, excluding agency, and active/termination dates. Distinct from OFAC sanctions (see sanctions_screen) — this is the federal procurement debarment list.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Name to search (company or individual), e.g. "Smith Construction". Matched against the excluded party name; an exact UEI also matches. Optional if you pass `uei` instead — supply one of the two.' },
        uei: { type: 'string', description: 'Optional — check one specific UEI against the debarment list. More reliable than a name for KYB, since names collide and are transcribed inconsistently.' },
        state: { type: 'string', description: 'Optional 2-letter US state to filter by, e.g. "VA".' },
        classification: { type: 'string', description: 'Optional classification: "Firm", "Individual", "Vessel", or "Special Entity Designation".' },
        include_terminated: { type: 'boolean', description: 'Accepted, but it currently changes NOTHING — SAM.gov\'s daily Exclusions extract carries only exclusions in force, so there are no terminated records for it to add. Measured 2026-09-13 over 400 sampled rows across four names with the filter explicitly disabled: zero carried a termination date in the past. Read an empty result as "not debarred TODAY", never as "never debarred" — a bar that has since ended is absent from this source entirely.' },
        limit: { type: 'number', description: 'Number of results (1-100, default 10).' },
        offset: { type: 'number', description: 'Rows to skip for paging (default 0).' },
        _apiKey: { type: 'string', description: 'Optional — omit it. This search answers keyless from the local snapshot of SAM.gov\'s public Exclusions extract, which is refreshed daily.' },
      },
      // Deliberately NOT required:['name'] — pass `name` OR `uei`. The handler
      // has always supported a UEI-only lookup, and the uei description calls it
      // the more reliable identifier for KYB, but declaring name required meant
      // the gateway rejected a UEI-only call before this pack ever ran: the one
      // precise way to check a vendor was unreachable from the tool that
      // recommends it. Neither supplied is still refused, in the handler, with a
      // message naming both.
      required: [],
    },
  },
];

// ── callTool dispatcher ─────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  // Grab mirror creds before extractKey runs — different arg keys, but read
  // it here once so every case below can pass it along uniformly.
  const mirror = mirrorConfig(args);
  const key = extractKey(args);

  switch (name) {
    case 'sam_search_opportunities':
      return searchOpportunities(key, args, mirror);
    case 'sam_get_opportunity':
      return getOpportunity(key, args.solicitation_number as string, args, mirror);
    case 'sam_entity_search':
      return entitySearchRouted(key, args, mirror);
    case 'sam_set_aside_opportunities': {
      // hosting-claims-ok: internal reasoning, not caller-facing copy
      // Mirror first, for the same reason as its two siblings: the shared key is
      // personal-tier and spent most days, and this data is already local.
      if (mirror) {
        try {
          const fresh = await mirrorFreshness(mirror);
          if (fresh) return await setAsideOpportunitiesFromMirror(mirror, fresh, args);
        } catch {
          // Mirror unreachable is not a failure — fall through to the live API.
        }
      }
      return setAsideOpportunities(key, args);
    }
    case 'sam_search_exclusions':
      return searchExclusionsRouted(key, args, mirror);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Response types ──────────────────────────────────────────────────────

type SamOpportunity = {
  noticeId?: string;
  title?: string;
  solicitationNumber?: string;
  department?: string;
  subTier?: string;
  office?: string;
  postedDate?: string;
  type?: string;
  baseType?: string;
  archiveType?: string;
  archiveDate?: string;
  setAside?: string;
  setAsideDescription?: string;
  responseDeadLine?: string;
  naicsCode?: string;
  classificationCode?: string;
  active?: string;
  description?: string;
  organizationType?: string;
  uiLink?: string;
  pointOfContact?: {
    fullName?: string;
    title?: string;
    email?: string;
    phone?: string;
    type?: string;
  }[];
  resourceLinks?: string[];
};

type SamOppsResponse = {
  totalRecords?: number;
  opportunitiesData?: SamOpportunity[];
};

type SamEntity = {
  entityRegistration?: {
    ueiSAM?: string;
    cageCode?: string;
    legalBusinessName?: string;
    dbaName?: string;
    registrationStatus?: string;
    registrationDate?: string;
    expirationDate?: string;
    activeDate?: string;
    physicalAddress?: {
      addressLine1?: string;
      city?: string;
      stateOrProvinceCode?: string;
      zipCode?: string;
      countryCode?: string;
    };
    businessTypes?: string[];
    primaryNaics?: string;
  };
  coreData?: {
    entityInformation?: {
      entityURL?: string;
      entityDivisionName?: string;
    };
  };
  assertions?: {
    sbaBusinessTypes?: { sbaBusinessTypeDesc?: string }[];
  };
};

type SamEntityResponse = {
  totalRecords?: number;
  entityData?: SamEntity[];
};

// ── Tool implementations ────────────────────────────────────────────────

function formatOpportunity(opp: SamOpportunity) {
  return {
    title: opp.title ?? null,
    solicitation_number: opp.solicitationNumber ?? null,
    department: opp.department ?? null,
    sub_tier: opp.subTier ?? null,
    office: opp.office ?? null,
    posted_date: opp.postedDate ?? null,
    response_deadline: opp.responseDeadLine ?? null,
    type: opp.type ?? null,
    set_aside: opp.setAsideDescription ?? opp.setAside ?? null,
    naics_code: opp.naicsCode ?? null,
    classification_code: opp.classificationCode ?? null,
    active: opp.active ?? null,
    ui_link: opp.uiLink ?? null,
  };
}

// SAM.gov uses MM/dd/yyyy. Format a Date in that shape.
function samDate(d: Date): string {
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${m}/${day}/${d.getUTCFullYear()}`;
}

async function searchOpportunities(key: string, args: Record<string, unknown>, mirror: MirrorCfg | null) {
  // Accept query / q / keywords as natural aliases. Agents reach for "query"
  // by default on any search-shaped tool.
  const keyword = (args.keyword ?? args.query ?? args.q ?? args.keywords) as string | undefined;
  const naics = args.naics as string | undefined;
  const setAside = args.set_aside as string | undefined;
  const ptype = args.ptype as string | undefined;

  // SAM.gov requires postedFrom + postedTo on every LIVE search — missing
  // those is why the endpoint returned a bare 404 when agents called it
  // without dates. Default to a 30-day rolling window (same default the
  // mirror path honors below) so "what's posted lately" just works either
  // way. postedFromRaw stays undefined unless the caller explicitly passed
  // one — that distinction is what decides mirror-vs-live below.
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const postedFromRaw = (args.posted_from as string | undefined)?.trim() || undefined;
  const postedToRaw = (args.posted_to as string | undefined)?.trim() || undefined;
  const postedFrom = postedFromRaw ?? samDate(thirtyDaysAgo);
  const postedTo = postedToRaw ?? samDate(now);
  const limit = Math.min(100, Math.max(1, (args.limit as number) ?? 10));
  const offset = (args.offset as number) ?? 0;

  // MIRROR FIRST (fleet #343). PLATFORM_SAM_KEY is a personal-tier key
  // (~10 requests/day) shared across every gateway caller, and it was
  // exhausted before 01:00 UTC — every govcon keyword search errored for
  // the rest of the day. SAM.gov's own daily public CSV extract needs no
  // key at all, so the mirror serves the common case for free.
  //
  // Only an EXPLICIT posted_from past the mirror's snapshot forces live —
  // the computed 30-day DEFAULT must never do this, or the mirror would
  // almost never serve (same lesson as court-listener's search_opinions,
  // fleet #381: which path answers must not silently depend on whether an
  // optional argument happened to be filled).
  const fresh = mirror ? await mirrorFreshness(mirror) : null;
  if (mirror && fresh) {
    const fromIso = postedFromRaw ? mmddyyyyToIso(postedFromRaw) : null;
    const pastSnapshot = !!(fromIso && fromIso > fresh.snapshot_date);
    if (!pastSnapshot) {
      return searchOpportunitiesMirror(mirror, fresh, {
        keyword, naics, setAside, ptype, postedFrom, postedTo, limit, offset,
      });
    }
  }

  // Live fallback: no mirror configured, mirror never loaded, or an
  // explicit posted_from reaches past the mirror's snapshot.
  // Only reached when the mirror cannot answer — an explicit posted_from past
  // its snapshot, or no mirror at all. The keyless path above is the common
  // case, so the key is demanded here rather than at the door.
  const params = new URLSearchParams({ api_key: requireKey(key, 'Searching opportunities newer than the local snapshot') });

  // Sent as `title=`, NOT `keyword=`: SAM.gov's v2 opportunities API has no
  // `keyword` parameter and silently ignores unknown params, so every
  // keyword-filtered search returned the ENTIRE posting window as a clean 200
  // — "cybersecurity" came back as 27,051 opportunities led by generator
  // maintenance (fleet #311, the france_search_tenders class). `title` is the
  // API's documented text filter. (The mirror path above matches title AND
  // description, so it's strictly broader than this.)
  if (keyword) params.set('title', keyword);
  if (naics) params.set('ncode', naics);
  if (setAside) params.set('typeOfSetAside', setAside);
  if (ptype) params.set('ptype', ptype);
  params.set('postedFrom', postedFrom);
  params.set('postedTo', postedTo);
  params.set('limit', String(limit));
  params.set('offset', String(offset));

  const data = (await samFetch(`${OPPS_BASE}?${params}`)) as SamOppsResponse;
  const opps = data.opportunitiesData ?? [];

  return {
    total_records: data.totalRecords ?? 0,
    posted_from: postedFrom,
    posted_to: postedTo,
    limit,
    offset,
    opportunities: opps.map(formatOpportunity),
    source: 'sam.gov-live',
    mirror: mirrorStatusField(mirror, fresh),
  };
}

async function searchOpportunitiesMirror(
  mirror: MirrorCfg,
  fresh: MirrorFreshness,
  a: { keyword?: string; naics?: string; setAside?: string; ptype?: string; postedFrom: string; postedTo: string; limit: number; offset: number },
) {
  // Ranked RPC (supabase/migrations/075), not a plain REST filter: a title
  // match and an incidental boilerplate description mention both satisfy a
  // plain `@@` predicate equally, and SAM.gov notices carry a LOT of
  // boilerplate — DFARS/GSA cloud-computing and cyber clauses get inserted
  // into unrelated hardware/facilities notices by the posting template, not
  // because that notice is about either topic. First live test proved this:
  // an unranked title-or-description match put a water-tank repair and an
  // MRI renovation ahead of the two opportunities actually about
  // cybersecurity. ts_rank_cd with setweight(title,'A')/description,'B')
  // gives a title hit ~2.5x a single description mention's contribution, so
  // genuine title matches float to the top of ONE ranked result set instead
  // of needing a hard tier cutoff.
  const params = new URLSearchParams({
    q: a.keyword?.trim() ?? '',
    lim: String(a.limit),
    off: String(a.offset),
  });
  if (a.naics?.trim()) params.set('naics', a.naics.trim());
  if (a.setAside?.trim()) params.set('set_aside_code_in', a.setAside.trim().toUpperCase());
  if (a.ptype?.trim()) {
    const label = PTYPE_LABELS[a.ptype.trim().toLowerCase()];
    if (label) params.set('base_type_in', label);
  }
  const fromIso = mmddyyyyToIso(a.postedFrom);
  const toIso = mmddyyyyToIso(a.postedTo);
  if (fromIso) params.set('date_from', fromIso);
  if (toIso) params.set('date_to', toIso);

  const { rows } = await pgWithCount<MirrorOpportunityRow & {
    rank: number; match_mode?: string; total_count?: number; total_is_capped?: boolean;
  }>(mirror, 'rpc/search_samgov_opportunities', params.toString());

  // The count now rides on the rows themselves (migration 079, count(*) OVER ()),
  // computed by the SAME query that produced them. It used to come from a second
  // request that re-ran the predicate independently — which was correct until the
  // ranked query gained an any-term fallback, at which point an all-term count of
  // 0 would have been reported next to five any-term rows. One query, one total.
  const matchMode = rows[0]?.match_mode;
  const total = rows[0]?.total_count ?? (rows.length ? rows.length : 0);
  // The RPC counts exactly up to 500 and reports 500 for anything above it
  // (migration 128). Without the flag beside it, a capped 500 and an exact 500
  // are the same number: two unrelated high-cardinality searches both answering
  // "500" is a tell a person notices and an agent does not. The cap was made
  // visible at the RPC layer precisely so this number could never be read as
  // real on its own — dropping the flag one layer short of the caller gives up
  // the whole property.
  const capped = rows[0]?.total_is_capped === true;

  return {
    total_records: total,
    total_is_capped: capped,
    // Spelled out because a caller skimming the response sees `500` first and
    // a boolean second.
    total_records_note: capped
      ? `More than ${total} notices match; ${total} is the counting cap, not the true total. Narrow the keyword or date range for an exact count.`
      : undefined,
    // Stated, never inferred: a caller who listed six related terms and got
    // any-term matches needs to know the results are "about these subjects"
    // rather than "contain all of these words".
    match_mode: matchMode === 'any' ? 'any term (no notice matched all of them)'
      : matchMode === 'all' ? 'all terms'
      : undefined,
    posted_from: a.postedFrom,
    posted_to: a.postedTo,
    limit: a.limit,
    offset: a.offset,
    opportunities: rows.map(formatMirrorOpportunity),
    source: 'sam.gov-mirror',
    mirror: {
      available: true,
      loaded_at: fresh.loaded_at,
      snapshot_date: fresh.snapshot_date,
      rows_in_mirror: fresh.row_count,
      note: a.keyword?.trim()
        ? 'Ranked full-text match — title weighted well above description, so an on-topic title floats above an incidental boilerplate clause mention (still strictly broader than the live SAM.gov API, which only ever matches title). Covers opportunities posted through snapshot_date; pass posted_from after that date to search live SAM.gov instead.'
        : 'No keyword — filtered/browsed by the other arguments, sorted by posted_date. Covers opportunities posted through snapshot_date; pass posted_from after that date to search live SAM.gov instead.',
    },
  };
}

/**
 * SAM.gov requires postedFrom + postedTo on EVERY opportunities/v2/search
 * request, and answers a bare 404 with an empty body when they are missing.
 * searchOpportunities and setAsideOpportunities both learned this and default
 * a window; this function was left behind, so every lookup that reached the
 * live API 404'd — 7 of 8 failures for one paying caller in the week of
 * 2026-08-18, on solicitation numbers that were all perfectly real
 * (FA480326Q0102, M6700126Q0131, W519TC26RA036, ...).
 *
 * That empty body is what made it durable: a 404 with no message reads as
 * "no such solicitation", which is a believable answer to a lookup. It was
 * reported three times as "sam_get_opportunity 404s" and survived each one,
 * because the response looked like the API answering rather than us asking
 * wrong.
 *
 * A window has to be GUESSED here in a way it doesn't for a search, because
 * the caller supplies a solicitation number and not a date — and SAM caps a
 * range at one year, so no single default covers an arbitrary solicitation.
 * The mirror closes that gap: it already holds posted_date for the whole
 * public extract, so when it can resolve the number we pin the window to the
 * actual posting date and the age of the solicitation stops mattering. The
 * one-year default is only the fallback for numbers the mirror doesn't have.
 *
 * Live is still what answers: mirror rows carry no description, contacts, or
 * attachments, which are exactly what this tool promises over the search
 * tools. Serving a mirror row here would return a thinner object under the
 * same name — the quiet kind of wrong.
 */
async function getOpportunity(
  key: string,
  solicitationNumber: string,
  args: Record<string, unknown>,
  mirror: MirrorCfg | null,
) {
  // MIRROR FIRST (fleet #448). The date-window work below made the live call as
  // correct as it can be, and the tool still returned 404 on 7 of 7 registered
  // calls for four days, because the window was never the whole problem:
  // opportunities/v2/SEARCH does not return ARCHIVED notices at all. Verified on
  // the deployed build carrying that fix — three solicitations whose newest
  // archive_date had just passed all failed, while ones archiving in the future
  // succeeded. People look a solicitation up at or after its deadline, so
  // "archived" describes most of what is ever asked for by number, which is why
  // the failure rate was 100% rather than intermittent.
  //
  // The mirror holds those notices. Read it first and never spend the shared key
  // on a record we already have; the live path below stays for anything posted
  // since the last snapshot.
  const wanted = (solicitationNumber ?? '').trim();
  let mirrorSearched = false;
  if (mirror && wanted) {
    try {
      const rows = await pgJson<MirrorOpportunityRow[]>(
        mirror, 'samgov_opportunities',
        `solicitation_number=eq.${encodeURIComponent(wanted)}&select=*&order=posted_date.desc&limit=25`,
      );
      mirrorSearched = true;
      if (rows.length) {
        const [newest, ...rest] = rows;
        const fresh = await mirrorFreshness(mirror);
        return {
          ...formatMirrorOpportunity(newest),
          notice_id: newest.notice_id ?? null,
          archive_date: newest.archive_date ?? null,
          archive_type: newest.archive_type ?? null,
          organization_type: newest.organization_type ?? null,
          description_url: newest.notice_id
            ? `https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid=${newest.notice_id}`
            : null,
          notices_under_this_number: rows.length,
          other_notices: rest.map((r) => ({
            notice_id: r.notice_id ?? null,
            posted_date: r.posted_date ?? null,
            type: r.type ?? null,
          })),
          source: 'sam.gov-mirror',
          mirror: fresh
            ? { available: true, snapshot_date: fresh.snapshot_date, loaded_at: fresh.loaded_at }
            : { available: true },
          note: rows.length > 1
            ? `${rows.length} notices share this solicitation number; this is the most recently posted. Point of contact and attachments are only on the live record — open ui_link or description_url.`
            : 'Point of contact and attachments are only on the live record — open ui_link or description_url.',
        };
      }
    } catch {
      // Mirror unreachable is not a failure — fall through to the live path.
    }
  }

  const now = new Date();
  let postedFrom = (args.posted_from as string | undefined)?.trim() || undefined;
  let postedTo = (args.posted_to as string | undefined)?.trim() || undefined;
  let windowSource = postedFrom || postedTo ? 'caller' : 'default 1 year';

  if (!postedFrom && !postedTo && mirror) {
    try {
      // ALL posted_dates, not the first row. A solicitation number is not
      // unique in the extract — one number collects every notice against it
      // (presolicitation, amendments, award), each with its own posted_date.
      // `limit=1` with no order returns whichever PostgREST feels like: the
      // first live test pinned N6133126R3101 to 2025-12-30 when the notice
      // actually wanted was 2026-07-30, and the lookup then failed against a
      // window built from the wrong row — a fix that reproduced the bug it
      // was fixing, just for a different reason.
      const rows = await pgJson<Array<{ posted_date: string | null }>>(
        mirror, 'samgov_opportunities',
        `solicitation_number=eq.${encodeURIComponent(solicitationNumber)}` +
        '&posted_date=not.is.null&order=posted_date.asc&limit=200&select=posted_date',
      );
      const days = rows.map((r) => (r.posted_date ?? '').slice(0, 10)).filter(Boolean).sort();
      if (days.length) {
        // Span every notice under this number, one day of slack each side for
        // SAM's own timezone. SAM caps a range at a year, so when the notices
        // straddle more than that, keep the RECENT end — that is the live one.
        const first = new Date(`${days[0]}T00:00:00Z`).getTime() - 24 * 3600 * 1000;
        const last = new Date(`${days[days.length - 1]}T00:00:00Z`).getTime() + 24 * 3600 * 1000;
        const start = Math.max(first, last - 364 * 24 * 3600 * 1000);
        postedFrom = samDate(new Date(start));
        postedTo = samDate(new Date(last));
        windowSource = `mirror, ${days.length} notice(s) ${days[0]}..${days[days.length - 1]}`;
      }
    } catch {
      // Mirror unreachable is not a failure — fall through to the default.
    }
  }

  // SAM rejects a span longer than a year, so this is the widest legal default.
  postedFrom ??= samDate(new Date(now.getTime() - 364 * 24 * 3600 * 1000));
  postedTo ??= samDate(now);

  const params = new URLSearchParams({
    api_key: requireKey(key, 'Fetching this solicitation from the live API'),
    solnum: solicitationNumber,
    postedFrom,
    postedTo,
    limit: '1',
  });

  // Only ever a check for something posted since the last snapshot. If it cannot
  // run — the shared key is personal-tier and its quota dies most days, which is
  // what #343 was about — that is not evidence about the caller's number, and
  // must not surface as a tool defect when the mirror already searched.
  let data: SamOppsResponse;
  try {
    data = (await samFetch(`${OPPS_BASE}?${params}`)) as SamOppsResponse;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (mirrorSearched) {
      return {
        error: 'user_error',
        message:
          `No notice matches solicitation number "${solicitationNumber}" in the daily SAM.gov ` +
          `extract, which covers everything published up to its snapshot. Live SAM.gov could not ` +
          `be consulted for anything newer (${dropClassPrefix(msg).slice(0, 90)}), so a solicitation posted in the ` +
          `last day or so cannot be ruled out. Check the number, or find it by keyword with ` +
          `sam_search_opportunities.`,
        solicitation_number: solicitationNumber,
        live_check: 'unavailable',
      };
    }
    throw e;
  }
  const opps = data.opportunitiesData ?? [];

  if (opps.length === 0) {
    // Classified, not thrown. "That number matches nothing" is a statement about
    // the caller's value; throwing books it in the error tier as though the tool
    // broke, which is how this sat at 7/7 `error` for four days.
    return {
      error: 'user_error',
      message:
        `No notice matches solicitation number "${solicitationNumber}". It is not in the daily ` +
        `SAM.gov extract, and live SAM.gov returned nothing for ${postedFrom}..${postedTo} ` +
        `(window from: ${windowSource}). SAM.gov's live search also omits ARCHIVED notices, so ` +
        `a closed solicitation may not be retrievable by number at all. Check the number, or ` +
        `find it by keyword with sam_search_opportunities.`,
      solicitation_number: solicitationNumber,
    };
  }

  const opp = opps[0];
  return {
    ...formatOpportunity(opp),
    description: opp.description ?? null,
    point_of_contact: (opp.pointOfContact ?? []).map((poc) => ({
      name: poc.fullName ?? null,
      title: poc.title ?? null,
      email: poc.email ?? null,
      phone: poc.phone ?? null,
      type: poc.type ?? null,
    })),
    resource_links: opp.resourceLinks ?? [],
    archive_type: opp.archiveType ?? null,
    archive_date: opp.archiveDate ?? null,
    organization_type: opp.organizationType ?? null,
    source: 'sam.gov-live',
  };
}

async function entitySearch(key: string, args: Record<string, unknown>) {
  const params = new URLSearchParams({
    api_key: key,
    legalBusinessName: args.business_name as string,
    samRegistered: 'Yes',
    purposeOfRegistrationCode: 'Z2~Z5',
  });
  if (args.naics) params.set('naicsCode', args.naics as string);
  if (args.state) params.set('physicalAddressStateCode', args.state as string);
  if (args.small_business === true) params.set('businessTypeCode', 'SB');

  const data = (await samFetch(`${ENTITY_BASE}?${params}`)) as SamEntityResponse;
  const entities = data.entityData ?? [];

  return {
    total_records: data.totalRecords ?? 0,
    entities: entities.map((e) => {
      const reg = e.entityRegistration ?? {};
      const addr = reg.physicalAddress ?? {};
      const sbaTypes = e.assertions?.sbaBusinessTypes ?? [];

      return {
        uei: reg.ueiSAM ?? null,
        cage_code: reg.cageCode ?? null,
        legal_business_name: reg.legalBusinessName ?? null,
        dba_name: reg.dbaName ?? null,
        registration_status: reg.registrationStatus ?? null,
        registration_date: reg.registrationDate ?? null,
        expiration_date: reg.expirationDate ?? null,
        address: {
          line1: addr.addressLine1 ?? null,
          city: addr.city ?? null,
          state: addr.stateOrProvinceCode ?? null,
          zip: addr.zipCode ?? null,
          country: addr.countryCode ?? null,
        },
        primary_naics: reg.primaryNaics ?? null,
        business_types: reg.businessTypes ?? [],
        sba_certifications: sbaTypes.map((t) => t.sbaBusinessTypeDesc ?? null).filter(Boolean),
        entity_url: e.coreData?.entityInformation?.entityURL ?? null,
      };
    }),
  };
}

// ── Supabase mirror (supabase/migrations/074_samgov_opportunities_mirror.sql) ──
//
// Loaded by scripts/samgov-upsert.sh on a GitHub Actions runner (schedule:
// .github/workflows/samgov-refresh.yml) from SAM.gov's own public daily CSV
// extract — no API key, no rate limit. sam_search_opportunities reads this
// first; entity search / exclusions stay on the live API (a different
// endpoint family this extract does not cover at all).

interface MirrorCfg {
  url: string;
  key: string;
}

function mirrorConfig(args: Record<string, unknown>): MirrorCfg | null {
  const url = (args._supabaseUrl as string | undefined)?.trim();
  const key = (args._supabaseKey as string | undefined)?.trim();
  return url && key ? { url, key } : null;
}

async function pgJson<T>(cfg: MirrorCfg, rel: string, query: string): Promise<T> {
  const res = await pwFetch(`${cfg.url}/rest/v1/${rel}?${query}`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
  });
  if (!res.ok) throw new Error(`samgov ${rel}: ${res.status} ${(await res.text()).slice(0, 160)}`);
  return res.json() as Promise<T>;
}

/** Same, plus the exact match count from PostgREST's Content-Range header. */
async function pgWithCount<T>(cfg: MirrorCfg, rel: string, query: string): Promise<{ rows: T[]; total: number | null }> {
  const res = await pwFetch(`${cfg.url}/rest/v1/${rel}?${query}`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, Prefer: 'count=exact' },
  });
  if (!res.ok) throw new Error(`samgov ${rel}: ${res.status} ${(await res.text()).slice(0, 160)}`);
  const rows = (await res.json()) as T[];
  // Content-Range is "0-49/1234"; the tail is the unfiltered-by-limit total.
  const total = Number(res.headers.get('content-range')?.split('/')[1]);
  return { rows, total: Number.isFinite(total) ? total : null };
}

interface MirrorFreshness {
  loaded_at: string;
  row_count: number;
  snapshot_date: string;
}

/**
 * Days between the snapshot the rows came from and now. Reported beside
 * snapshot_date because "2026-08-02" requires the caller to know today's
 * date to interpret, and an agent summarising the answer usually doesn't
 * bother — "31 days old" cannot be skimmed past the same way.
 */
function snapshotAgeDays(snapshotDate: string): number | null {
  const t = Date.parse(`${snapshotDate}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  // FLOOR, not round. A snapshot loaded this morning is 0 days old, and
  // rounding reported it as "1 day old" from ~noon UTC onward — a daily
  // extract that always looks a day behind is exactly the sort of small
  // false staleness that gets escalated as a broken cron.
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

/**
 * Last successful load. Returned alongside the data so a stale mirror is
 * visible rather than passed off as current — the SpaceX mirror served
 * 25-day-old data while its cron reported healthy, and nothing in the
 * response would have told you.
 *
 * null means "no successful load on record" (including "the table/mirror
 * doesn't exist yet", which surfaces as a non-2xx from PostgREST and is
 * caught below) — the signal to fall back to the live API instead of
 * reporting a confident zero out of an empty or missing table.
 */
async function mirrorFreshness(cfg: MirrorCfg, dataset = 'opportunities'): Promise<MirrorFreshness | null> {
  try {
    // FILTERED BY DATASET, and that filter is load-bearing (migration 135).
    // samgov_ingest_runs was single-dataset until entity/exclusions landed;
    // "latest ok row" across all three would let a nightly exclusions load
    // vouch for a month-old entity snapshot, reporting it as hours fresh.
    // That is precisely the lie this field exists to prevent, so it is a
    // WHERE clause rather than a comment.
    const rows = await pgJson<Array<{ finished_at: string | null; row_count: number | null; snapshot_date: string | null }>>(
      cfg, 'samgov_ingest_runs',
      `status=eq.ok&dataset=eq.${encodeURIComponent(dataset)}&order=finished_at.desc&limit=1&select=finished_at,row_count,snapshot_date`,
    );
    const r = rows[0];
    if (!r?.finished_at || !r.row_count) return null;
    // snapshot_date is the date the DATA is from; finished_at is when we
    // loaded it. They are the same day for a daily extract and up to five
    // weeks apart for the monthly entity file, so preferring finished_at
    // here would overstate entity freshness by that whole gap.
    return {
      loaded_at: r.finished_at,
      row_count: r.row_count,
      snapshot_date: r.snapshot_date ?? r.finished_at.slice(0, 10),
    };
  } catch {
    return null; // unreachable/missing mirror -> live path, not a hard failure
  }
}

interface MirrorOpportunityRow {
  notice_id: string;
  title: string | null;
  solicitation_number: string | null;
  department: string | null;
  sub_tier: string | null;
  office: string | null;
  posted_date: string | null;
  type: string | null;
  base_type: string | null;
  archive_type: string | null;
  archive_date: string | null;
  set_aside_code: string | null;
  set_aside: string | null;
  response_deadline: string | null;
  naics_code: string | null;
  classification_code: string | null;
  active: boolean | null;
  organization_type: string | null;
  ui_link: string | null;
}

/**
 * Same output keys as formatOpportunity (the live-path formatter) — ONE
 * shape for sam_search_opportunities regardless of which path served it,
 * same lesson as court-listener's search_opinions (fleet #381): which path
 * answers must not change the contract a caller parses against.
 */
function formatMirrorOpportunity(r: MirrorOpportunityRow) {
  return {
    title: r.title ?? null,
    solicitation_number: r.solicitation_number ?? null,
    department: r.department ?? null,
    sub_tier: r.sub_tier ?? null,
    office: r.office ?? null,
    posted_date: r.posted_date ?? null,
    response_deadline: r.response_deadline ?? null,
    type: r.type ?? null,
    set_aside: r.set_aside || r.set_aside_code || null,
    naics_code: r.naics_code ?? null,
    classification_code: r.classification_code ?? null,
    active: r.active === true ? 'Yes' : r.active === false ? 'No' : null,
    ui_link: r.ui_link ?? null,
  };
}

/** "08/13/2026" (SAM's posted_from/posted_to format) -> "2026-08-13". */
function mmddyyyyToIso(v: string): string | null {
  const m = v.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

// Best-effort ptype -> mirror base_type label. Unmapped values are simply
// not filtered on rather than erroring — the live API's own ptype codes are
// under-documented, and a soft miss here beats a hard failure.
const PTYPE_LABELS: Record<string, string> = {
  p: 'Presolicitation',
  o: 'Solicitation',
  k: 'Combined Synopsis/Solicitation',
  a: 'Award Notice',
};

function mirrorStatusField(mirror: MirrorCfg | null, fresh: MirrorFreshness | null) {
  if (!mirror) {
    return { available: false, note: 'No mirror configured on this deployment — this call was billed against the shared SAM.gov API key.' };
  }
  if (!fresh) {
    return { available: false, note: 'Mirror configured but not yet loaded (no successful ingest on record) — this call went to the live SAM.gov API.' };
  }
  return {
    available: true,
    loaded_at: fresh.loaded_at,
    snapshot_date: fresh.snapshot_date,
    rows_in_mirror: fresh.row_count,
    note: 'This call went to the live SAM.gov API (an explicit posted_from reached past the mirror snapshot, or another argument the mirror can’t serve) — search without that argument to use the free mirror instead.',
  };
}

/**
 * SAM.gov set-aside codes, plus the phrasings callers actually type.
 *
 * The live API wants the exact code (SBA, SDVOSBC, HZC…). Nobody asks that way —
 * they ask for "women-owned" or "8(a)" or "HUBZone" — and the old API-only path
 * passed whatever it was given straight through, so a natural phrasing returned
 * an empty list rather than an error. Resolving here means the mirror is queried
 * on the code that actually exists in the column.
 */
const SET_ASIDE_ALIASES: Record<string, string> = {
  'small business': 'SBA', 'total small business': 'SBA', 'sba': 'SBA',
  'partial small business': 'SBP', 'sbp': 'SBP',
  '8a': '8A', '8(a)': '8A', '8a sole source': '8AN', '8(a) sole source': '8AN',
  'wosb': 'WOSB', 'women owned': 'WOSB', 'women-owned': 'WOSB',
  'edwosb': 'EDWOSB', 'economically disadvantaged women owned': 'EDWOSB',
  'hubzone': 'HZC', 'hzc': 'HZC', 'hubzone sole source': 'HZS',
  'sdvosb': 'SDVOSBC', 'sdvosbc': 'SDVOSBC', 'service disabled veteran': 'SDVOSBC',
  'service-disabled veteran': 'SDVOSBC', 'sdvosb sole source': 'SDVOSBS',
  'veteran owned': 'VSA', 'veteran-owned': 'VSA', 'vsa': 'VSA',
  'indian small business': 'ISBEE', 'isbee': 'ISBEE', 'buy indian': 'BICiv',
  'indian economic enterprise': 'IEE', 'iee': 'IEE',
};

function resolveSetAside(raw: string): string {
  const t = raw.trim();
  return SET_ASIDE_ALIASES[t.toLowerCase()] ?? t.toUpperCase();
}

/**
 * Set-aside opportunities, answered from the mirror.
 *
 * This tool used to go straight to the live API and was therefore dead most of
 * the day: the shared key is personal-tier with a 10-request DAILY quota, and
 * every one of these calls spent one — for opportunities already sitting in our
 * own table, indexed on set_aside_code. Its two siblings had been moved to the
 * mirror in #343/#448; this one was left behind (fleet #1024).
 */
async function setAsideOpportunitiesFromMirror(
  mirror: MirrorCfg,
  fresh: MirrorFreshness,
  args: Record<string, unknown>,
) {
  const code = resolveSetAside(String(args.set_aside ?? ''));
  const limit = Math.min(100, Math.max(1, (args.limit as number) ?? 10));

  const filters: string[] = [];
  // 182 rows store the code as a JSON-ARRAY STRING — `["SBA"]`, with set_aside
  // reading "None". Matching only on equality silently drops them, which is the
  // shape of miss that looks like a smaller real answer rather than a bug.
  filters.push(`or=(set_aside_code.eq.${encodeURIComponent(code)},set_aside_code.ilike.${encodeURIComponent(`%"${code}"%`)})`);
  if (args.naics) filters.push(`naics_code=eq.${encodeURIComponent(String(args.naics))}`);
  const fromIso = mmddyyyyToIso((args.posted_from as string | undefined) ?? '');
  const toIso = mmddyyyyToIso((args.posted_to as string | undefined) ?? '');
  if (fromIso) filters.push(`posted_date=gte.${fromIso}`);
  if (toIso) filters.push(`posted_date=lte.${toIso}`);
  if (args.keyword) filters.push(`title=ilike.${encodeURIComponent(`%${String(args.keyword)}%`)}`);

  const query = `${filters.join('&')}&select=*&order=posted_date.desc&limit=${limit}`;
  const { rows, total } = await pgWithCount<MirrorOpportunityRow>(mirror, 'samgov_opportunities', query);

  return {
    set_aside_type: code,
    set_aside_requested: String(args.set_aside ?? ''),
    total_records: total ?? rows.length,
    limit,
    opportunities: rows.map(formatMirrorOpportunity),
    source: 'sam.gov-mirror',
    mirror: {
      available: true,
      loaded_at: fresh.loaded_at,
      snapshot_date: fresh.snapshot_date,
      rows_in_mirror: fresh.row_count,
      note: 'Answered from the daily SAM.gov Contract Opportunities extract — no API key spent. Covers opportunities posted through snapshot_date.',
    },
  };
}

async function setAsideOpportunities(key: string, args: Record<string, unknown>) {
  const params = new URLSearchParams({
    api_key: requireKey(key, 'Set-aside search against the live API'),
    typeOfSetAside: args.set_aside as string,
  });
  // `title`, not `keyword` — SAM.gov ignores unknown params silently; see the
  // note in searchOpportunities (fleet #311).
  if (args.keyword) params.set('title', args.keyword as string);
  if (args.naics) params.set('ncode', args.naics as string);

  // SAM.gov requires postedFrom + postedTo — same as searchOpportunities.
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const postedFrom = (args.posted_from as string | undefined) ?? samDate(thirtyDaysAgo);
  const postedTo = (args.posted_to as string | undefined) ?? samDate(now);
  params.set('postedFrom', postedFrom);
  params.set('postedTo', postedTo);

  const limit = Math.min(100, Math.max(1, (args.limit as number) ?? 10));
  params.set('limit', String(limit));

  const data = (await samFetch(`${OPPS_BASE}?${params}`)) as SamOppsResponse;
  const opps = data.opportunitiesData ?? [];

  return {
    set_aside_type: args.set_aside,
    total_records: data.totalRecords ?? 0,
    posted_from: postedFrom,
    posted_to: postedTo,
    limit,
    opportunities: opps.map(formatOpportunity),
  };
}

// ── Exclusions (federal debarment) ──────────────────────────────────────

// SAM v4 exclusions nest fields under sub-objects (verified live 2026-07-20).
type SamExclusion = {
  exclusionDetails?: { classificationType?: string; exclusionType?: string; exclusionProgram?: string; excludingAgencyName?: string; excludingAgencyCode?: string };
  exclusionIdentification?: { ueiSAM?: string; entityName?: string; firstName?: string; middleName?: string; lastName?: string; suffix?: string };
  exclusionActions?: { listOfActions?: Array<{ activateDate?: string; terminationDate?: string; createDate?: string }> };
  exclusionPrimaryAddress?: { city?: string; stateOrProvinceCode?: string; countryCode?: string };
  exclusionOtherInformation?: { additionalComments?: string };
};

function formatExclusion(e: SamExclusion) {
  const id = e.exclusionIdentification ?? {};
  const det = e.exclusionDetails ?? {};
  const action = e.exclusionActions?.listOfActions?.[0] ?? {};
  const addr = e.exclusionPrimaryAddress ?? {};
  const personName = [id.firstName, id.middleName, id.lastName, id.suffix].filter(Boolean).join(' ').trim();
  return {
    name: id.entityName || personName || null,
    classification: det.classificationType ?? null,
    exclusion_type: det.exclusionType ?? null,
    exclusion_program: det.exclusionProgram ?? null,
    excluding_agency: det.excludingAgencyName ?? null,
    active_date: action.activateDate ?? null,
    termination_date: action.terminationDate || 'Indefinite',
    uei: id.ueiSAM ?? null,
    location: [addr.city, addr.stateOrProvinceCode, addr.countryCode].filter(Boolean).join(', ') || null,
    additional_comments: e.exclusionOtherInformation?.additionalComments ?? null,
  };
}

async function searchExclusions(key: string, args: Record<string, unknown>) {
  const name = String(args.name ?? '').trim();
  if (!name) throw new Error('sam_search_exclusions requires a `name` to search.');
  const limit = Math.min(100, Math.max(1, (args.limit as number) ?? 10));
  const params = new URLSearchParams({ api_key: key, exclusionName: name, page: '0', size: String(limit) });
  if (args.state) params.set('stateProvince', String(args.state).toUpperCase());
  if (args.classification) params.set('classification', String(args.classification));

  const data = (await samFetch(`${EXCLUSIONS_BASE}?${params}`)) as {
    totalRecords?: number;
    excludedEntity?: SamExclusion[];
    excludedEntitiesList?: SamExclusion[];
    _embedded?: { exclusionDetails?: SamExclusion[] };
  };
  // The v4 exclusions payload wraps the list under one of a few keys depending
  // on version — accept them all.
  const list = data.excludedEntity ?? data.excludedEntitiesList ?? data._embedded?.exclusionDetails ?? [];
  return {
    query: name,
    total_records: data.totalRecords ?? list.length,
    matched: list.length > 0,
    note: list.length === 0
      ? 'No federal exclusions found matching that name. This is the SAM.gov debarment list; for OFAC/export sanctions use sanctions_screen.'
      : 'Excluded parties are barred from federal contracts/grants — verify identity (name match ≠ confirmed party).',
    limit,
    exclusions: list.map(formatExclusion),
  };
}

// ── Entity + exclusions mirrors (supabase/migrations/135) ────────────────
//
// These two tools used to be live-only, and the comment above this block
// used to say the extract "does not cover them at all". That was true of the
// Contract Opportunities CSV and false of SAM.gov as a whole: entity
// registration and exclusions are published as their own public extracts,
// which download without any credential (fleet #1122). Being live-only meant
// both tools shared one personal-tier key worth 10 requests a DAY — so the
// answer to "is this vendor debarred" depended on how many callers had
// already asked that day, which is not an acceptable property for a
// compliance answer.
//
// CADENCE DIFFERS AND THE RESPONSE MUST SAY SO. Exclusions publish daily;
// entity registration only monthly. Both carry snapshot_date and
// snapshot_age_days, and the entity note names the monthly cadence outright
// so "31 days old" reads as expected rather than as a broken cron.

interface MirrorEntityRow {
  uei: string;
  cage_code: string | null;
  legal_business_name: string | null;
  dba_name: string | null;
  entity_division_name: string | null;
  extract_code: string | null;
  purpose_of_registration: string | null;
  initial_registration_date: string | null;
  registration_expiration_date: string | null;
  last_update_date: string | null;
  activation_date: string | null;
  physical_address_line_1: string | null;
  physical_address_line_2: string | null;
  physical_city: string | null;
  physical_state: string | null;
  physical_zip: string | null;
  physical_country: string | null;
  entity_url: string | null;
  entity_structure: string | null;
  state_of_incorporation: string | null;
  business_types: string | null;
  primary_naics: string | null;
  naics_codes: string | null;
  psc_codes: string | null;
  sba_business_types: string | null;
  exclusion_status_flag: string | null;
  rank?: number;
  total_count?: number;
}

/**
 * Same output keys as the live entitySearch formatter, for the same reason
 * formatMirrorOpportunity mirrors formatOpportunity: which path answered
 * must not change the shape a caller parses. The extra fields the extract
 * carries and the API response does not are added on the end rather than
 * renaming anything.
 */
function formatMirrorEntity(r: MirrorEntityRow) {
  return {
    uei: r.uei,
    cage_code: r.cage_code ?? null,
    legal_business_name: r.legal_business_name ?? null,
    dba_name: r.dba_name ?? null,
    // The extract encodes status as a one-letter code, not the word the live
    // API returns. Translate it rather than leaking 'A' to the caller.
    registration_status: r.extract_code === 'A' ? 'Active'
      : r.extract_code === 'E' ? 'Expired'
      : r.extract_code ?? null,
    registration_date: r.initial_registration_date ?? null,
    expiration_date: r.registration_expiration_date ?? null,
    address: {
      line1: r.physical_address_line_1 ?? null,
      city: r.physical_city ?? null,
      state: r.physical_state ?? null,
      zip: r.physical_zip ?? null,
      country: r.physical_country ?? null,
    },
    primary_naics: r.primary_naics ?? null,
    business_types: r.business_types ?? null,
    sba_certifications: r.sba_business_types ?? null,
    entity_url: r.entity_url ?? null,
    // Beyond what the live API path returns:
    entity_division_name: r.entity_division_name ?? null,
    entity_structure: r.entity_structure ?? null,
    state_of_incorporation: r.state_of_incorporation ?? null,
    all_naics_codes: r.naics_codes ?? null,
    psc_codes: r.psc_codes ?? null,
    last_update_date: r.last_update_date ?? null,
    // A flag on the registration, NOT a checked exclusion. Callers doing KYB
    // must be told which of those they are holding, hence the wording.
    has_exclusion_flag: r.exclusion_status_flag ? true : false,
  };
}

async function searchEntitiesMirror(
  mirror: MirrorCfg,
  fresh: MirrorFreshness,
  args: Record<string, unknown>,
) {
  const q = String(args.business_name ?? args.query ?? args.q ?? args.name ?? '').trim();
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 10));
  const offset = Math.max(0, Number(args.offset) || 0);

  const params = new URLSearchParams({ q, lim: String(limit), off: String(offset) });
  if (typeof args.naics === 'string' && args.naics.trim()) params.set('naics', args.naics.trim());
  if (typeof args.state === 'string' && args.state.trim()) params.set('state_in', args.state.trim().toUpperCase());
  if (args.small_business === true) params.set('small_only', 'true');
  if (args.active_only === true) params.set('extract_code_in', 'A');

  const { rows } = await pgWithCount<MirrorEntityRow>(mirror, 'rpc/search_samgov_entities', params.toString());
  const total = rows[0]?.total_count ?? rows.length;
  // The RPC counts up to 5,000 and stops (migration 135). Say so when we are
  // at the cap instead of letting 5000 read as an exact population.
  const capped = total >= 5000;
  const age = snapshotAgeDays(fresh.snapshot_date);

  return {
    query: q,
    total_records: total,
    total_is_capped: capped,
    total_records_note: capped
      ? `More than ${total} entities match; ${total} is the counting cap, not the true total. Narrow the query for an exact count.`
      : undefined,
    limit,
    offset,
    entities: rows.map(formatMirrorEntity),
    source: 'sam.gov-mirror',
    mirror: {
      available: true,
      dataset: 'entity',
      loaded_at: fresh.loaded_at,
      snapshot_date: fresh.snapshot_date,
      snapshot_age_days: age,
      rows_in_mirror: fresh.row_count,
      // The cadence is stated on EVERY response, not just old ones. A caller
      // who sees "24 days old" without knowing the file is monthly cannot
      // tell a healthy snapshot from a stalled loader.
      note: `SAM.gov publishes the public Entity Registration extract MONTHLY, so this snapshot is ${age === null ? 'of unknown age' : `${age} day(s) old`} by design, not because a refresh failed. Registrations that activated, expired or changed since ${fresh.snapshot_date} are not reflected — pass live:true with an API key for the registry as of today.`,
    },
  };
}

interface MirrorExclusionRow {
  sam_number: string | null;
  classification: string | null;
  display_name: string | null;
  address_line_1: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  country: string | null;
  unique_entity_id: string | null;
  cage_code: string | null;
  exclusion_program: string | null;
  excluding_agency: string | null;
  exclusion_type: string | null;
  additional_comments: string | null;
  active_date: string | null;
  termination_date: string | null;
  record_status: string | null;
  cross_reference: string | null;
  last_seen_in_extract: string | null;
  rank?: number;
  total_count?: number;
}

/** Same keys as formatExclusion (the live path) — one shape either way. */
function formatMirrorExclusion(r: MirrorExclusionRow) {
  return {
    name: r.display_name ?? null,
    classification: r.classification ?? null,
    exclusion_type: r.exclusion_type ?? null,
    exclusion_program: r.exclusion_program ?? null,
    excluding_agency: r.excluding_agency ?? null,
    active_date: r.active_date ?? null,
    // Live path spells a null termination as 'Indefinite'; match it exactly
    // rather than handing back null for the same real-world fact.
    termination_date: r.termination_date || 'Indefinite',
    uei: r.unique_entity_id ?? null,
    location: [r.city, r.state, r.country].filter(Boolean).join(', ') || null,
    additional_comments: r.additional_comments ?? null,
    cage_code: r.cage_code ?? null,
    cross_reference: r.cross_reference ?? null,
  };
}

async function searchExclusionsMirror(
  mirror: MirrorCfg,
  fresh: MirrorFreshness,
  args: Record<string, unknown>,
) {
  const uei = String(args.uei ?? '').trim();
  const name = String(args.name ?? args.query ?? args.q ?? '').trim();
  if (!name && !uei) {
    throw new Error(
      'sam_search_exclusions needs something to look up: pass `name` (a company or person, e.g. "Smith Construction") or `uei` (a 12-character SAM.gov Unique Entity ID, e.g. "NZJHL7G6CZV5"). Prefer `uei` where you have one — names collide and are transcribed inconsistently on this list.',
    );
  }
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 10));
  const offset = Math.max(0, Number(args.offset) || 0);

  const params = new URLSearchParams({
    q: uei || name,
    lim: String(limit),
    off: String(offset),
    active_only: args.include_terminated === true ? 'false' : 'true',
  });
  if (uei) params.set('uei_in', uei.toUpperCase());
  if (typeof args.state === 'string' && args.state.trim()) params.set('state_in', args.state.trim().toUpperCase());
  if (typeof args.classification === 'string' && args.classification.trim()) {
    params.set('classification_in', args.classification.trim());
  }

  const { rows } = await pgWithCount<MirrorExclusionRow>(mirror, 'rpc/search_samgov_exclusions', params.toString());
  const total = rows[0]?.total_count ?? rows.length;

  return {
    query: uei || name,
    total_records: total,
    matched: rows.length > 0,
    // A clean "no match" is the answer people act on here, so it says what
    // was actually searched and what it does NOT cover. An empty result read
    // as "cleared for federal work" is the expensive misreading.
    note: rows.length === 0
      ? `No federal exclusion in force found matching that ${uei ? 'UEI' : 'name'} as of the ${fresh.snapshot_date} snapshot. This covers exclusions IN FORCE only — SAM.gov's daily extract does not publish terminated ones, so a debarment that has since ended is absent from this source and include_terminated cannot surface it. This means "not barred today", not "never barred". This is the SAM.gov debarment list only; for OFAC/export sanctions use sanctions_screen.`
      : 'Excluded parties are barred from federal contracts/grants — verify identity before acting (a name match is not a confirmed party; match on UEI where you have one).',
    limit,
    offset,
    exclusions: rows.map(formatMirrorExclusion),
    source: 'sam.gov-mirror',
    mirror: {
      available: true,
      dataset: 'exclusions',
      loaded_at: fresh.loaded_at,
      snapshot_date: fresh.snapshot_date,
      snapshot_age_days: snapshotAgeDays(fresh.snapshot_date),
      rows_in_mirror: fresh.row_count,
      covers: 'in-force-only',
      note: `SAM.gov publishes the Exclusions extract daily; this is the ${fresh.snapshot_date} snapshot. An exclusion added or terminated after that date is not reflected. The extract carries only exclusions currently IN FORCE — terminated ones are absent from the source altogether, not merely filtered out here.`,
    },
  };
}

/**
 * Mirror-first with a live escape hatch. Unlike opportunities — where an
 * explicit posted_from past the snapshot is an unambiguous signal that the
 * caller has reached beyond the mirror — an entity query carries no date, so
 * there is nothing to infer intent from. Rather than guess, the mirror
 * answers and states its age, and `live:true` is the caller's explicit way
 * to spend the (10/day) key. Silently serving a month-old registration as
 * current is the failure this routing exists to avoid; silently
 * spending the day's only key on a routine lookup is the one it replaced.
 */
async function entitySearchRouted(key: string, args: Record<string, unknown>, mirror: MirrorCfg | null) {
  if (args.live !== true && mirror) {
    const fresh = await mirrorFreshness(mirror, 'entity');
    if (fresh) return await searchEntitiesMirror(mirror, fresh, args);
  }
  return entitySearch(
    requireKey(key, args.live === true
      ? 'sam_entity_search with live:true (the mirror answers keyless — drop live:true to use it)'
      : 'sam_entity_search'),
    { ...args, business_name: String(args.business_name ?? args.query ?? args.q ?? args.name ?? '').trim() },
  );
}

async function searchExclusionsRouted(key: string, args: Record<string, unknown>, mirror: MirrorCfg | null) {
  if (mirror) {
    const fresh = await mirrorFreshness(mirror, 'exclusions');
    if (fresh) return await searchExclusionsMirror(mirror, fresh, args);
  }
  return searchExclusions(requireKey(key, 'sam_search_exclusions'), args);
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;
