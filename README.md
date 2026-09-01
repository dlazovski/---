# CompanyWall MK — НКД-filtered company scrape

An n8n workflow that searches [companywall.com.mk](https://www.companywall.com.mk) for
active companies **anywhere in North Macedonia** in one or more **НКД activity divisions**,
paginates through every result page, opens each company's public profile, and appends one
row per company to an existing Google Sheet.

There is **no revenue restriction** by default — companies are returned at any revenue.
(A revenue filter is still available; see `revenueFilterMode` below.)

All site traffic goes through the **ScrapingBee** API. Only free, publicly visible data
is used — no login, no credentials, and no authenticated endpoints
(`/Company/CompanyBonitet`, `/Company/CompanyPersons`, or any `sid=` URL).

---

## ⚠️ Read this first: Step 0 has not been run

The task specifies a mandatory live-verification step (Step 0) before the full run.
**I could not execute it.** This build environment has no ScrapingBee API key, and its
network egress proxy blocks both `www.companywall.com.mk` and `app.scrapingbee.com`:

```
curl https://www.companywall.com.mk/   -> CONNECT tunnel failed, response 403
curl https://app.scrapingbee.com/api/v1/ -> CONNECT tunnel failed, response 403
```

So instead of guessing and calling it verified, the repo ships **two** workflows:

| Workflow | Purpose |
| --- | --- |
| `workflows/step0-verification.json` | Runs Step 0 for real. Read-only, ~8 requests, ~1 minute. Produces a report structured as the seven Step 0 questions. |
| `workflows/companywall-mk-scraper.json` | The full scrape. Run it after the Step 0 verdicts look right. |

**Run Step 0 first and report the verdicts back.** See
[`docs/step-0-verification.md`](docs/step-0-verification.md) for what it checks and what
to do with each answer.

### What is verified, and what is not

| Confirmed (built on directly) | Not verified (built defensively) |
| --- | --- |
| Search URL parameters, order and `dsm[...]` syntax | **`at=` — the НКД filter itself.** It has only ever been sent empty |
| City = comma segment before "Република Северна Македонија" | The **search-results page markup** |
| Profile page label is `НКЗ`, formatted `27.110 - …` | The **end-of-results behaviour** (empty list? repeated page?) |
| `Сопственик{NAME}Управител{NAME}` block on the profile page | **How to express "no revenue filter"** — two plausible URL forms |
| Same phone appears formatted *and* digits-only | That `render_js=false` suffices **through ScrapingBee specifically** |

### The `at=` parameter is the risky one

Every confirmed URL sent `at=` **empty**. Nothing establishes what values it accepts — it
might take an НКД code (`46`, `46.900`), or an internal numeric ID that looks nothing like
one. Two failure modes matter:

- **Silently ignored** → the scrape collects *every active company in the country*.
- **Wrong value format** → the scrape collects the wrong industry, or nothing.

Step 0 checks this directly: it runs the search with and without `at=`, compares the result
sets, and reads the actual НКД code off real profile pages. As a second line of defence the
main workflow re-checks every profile against the requested code and skips rows that do not
match (`enforceNkdMatch`), so a broken filter shows up as a counter rather than as tens of
thousands of unwanted rows.

Everything in the right-hand column is handled so that being wrong produces a *warning
and a diagnostic*, not a crash or silent data loss. The pagination stop condition, in
particular, covers four different possible end-of-results behaviours at once.

---

## Setup

### 1. Import the workflows

n8n → **Workflows → Import from File** → import both JSON files from `workflows/`.

### 2. ScrapingBee credential

Every HTTP Request node is preconfigured for **Generic Credential Type → Query Auth**.
Open each ScrapingBee node and select the existing ScrapingBee credential.

If that credential does not exist yet, create a **Query Auth** credential with:

- **Name:** `api_key`
- **Value:** your ScrapingBee API key

No credential IDs are baked into the exported JSON, so nothing points at another
instance's credentials.

### 3. Google Sheets credential

Select the Google credential on **both** Google Sheets nodes — **Read Existing Sheet**
and **Google Sheets — Append**. They must point at the same tab, or de-duplication
against what you already collected will not work.

### 4. Point at the sheet

In the **Config** node of the main workflow:

- `nkdCodes` — the НКД division(s) to filter on, e.g. `46`. Comma-separate for several
  (`46, 47`). A two-digit division is intended to cover every code beneath it (`46.900`).
  **This is a placeholder and must be replaced.**
- `googleSheetId` — the sheet's ID (the long string in its URL). **This is a placeholder
  and must be replaced.**
- `googleSheetName` — the tab name (default `Sheet1`).

The sheet's header row must contain these eight columns, spelled exactly:

```
Клиент | Град | ЕМБС | Даночен БРОЈ | Шифра на дејност | Контакт лице | Контакт телефон | Меил адреса
```

The node uses `autoMapInputData`, so the workflow matches on these names. If your header
differs, either rename the header or edit the `COLUMNS` list in
`src/nodes/prepare-sheet-row.js` and rebuild.

---

## Running

### Step 0 (do this first)

Run `CompanyWall MK — Step 0 live verification`, then open the **Step 0 Report** node's
output. Each of the seven questions carries a `verdict`. Report them back — especially
`q5_totalVolume` — before starting the full scrape.

### The full run

1. Set `maxCompanies` to `5` in Config and run once. Check the five rows in the sheet.
2. Set `maxCompanies` back to `0` (unlimited) and run for real.

Budget from Step 0's `q5_volume.estimatedRuntimeHours`. At 2 requests per company plus a
3–5 s wait each, roughly **250 companies per hour**. A whole НКД division with no revenue
filter can be much larger than a revenue-bounded search was, so check the estimate before
starting rather than after. That pace is deliberate — see below.

When the run finishes, open **Build Summary** for the run report: rows written, failures
by stage with their URLs, duplicates skipped, and counts of companies with no phone, no
e-mail, or no owner/manager on the main page.

### Running it again to collect more

The workflow is safe to re-run against the same sheet. **Read Existing Sheet** loads the
rows already there and seeds the de-duplication set from the `Даночен БРОЈ` column, so a
second run appends only companies you do not already have — and skips the known ones
*before* the profile fetch, so they cost nothing.

Two things to check in the summary afterwards:

- `existingCompaniesSeeded` should match the number of rows already in your sheet. If it
  is `0` while the sheet has rows, the column name does not match — set `sheetEdbColumn`
  in Config and re-run. A warning is raised for exactly this case, because the alternative
  is silently duplicating everything.
- `companiesQueued: 0` with a `note` saying the search is exhausted means every company
  this filter returns is already in your sheet. Running it again will not help; you need a
  different filter — more НКД codes, or a different `balanceYear`.
- `nkdFilterWarning`, if present, means most companies fetched were **outside** the НКД
  codes you asked for. That is the signature of `at=` being ignored: stop and re-check
  Step 0 rather than trusting the run.

#### How the search is split up

A single search can only be paged as deep as the site allows, so companies past that depth
are unreachable no matter how many times you re-run it. The workflow therefore sweeps
**segments**: one search per (НКД code × revenue band), each paged to its own end.

- With several `nkdCodes`, each code is its own segment. This is both the filter and the
  way past the depth cap.
- With `revenueFilterMode: range`, the revenue range is additionally sliced into
  `revenueBandCount` contiguous bands (geometrically spaced, since company counts skew
  heavily toward the low end of a revenue range).
- With one code and revenue filtering off — the default — there is exactly one segment.

The segments actually run are listed in the summary under `segments`. If a single division
turns out to hit the depth cap, splitting it into its individual codes (`46.110, 46.120, …`)
is the lever.

---

## How it works

```
Config ─ Read Existing Sheet ─ Init State  (seed seen-ЕДБ, plan segments)
                                    │
        ┌───────────────────────────▼──────────────────────────────────────────┐
        │  Build Search URL ─ Wait ─ ScrapingBee ─ Parse Results ─ More? ──────┤
        └─────────── next page, or next segment ◄─────────────────────────────-┘
                                                       │ every segment swept
                                                          ▼
      Dedupe by ЕДБ ─ Loop (1 at a time) ─ Wait ─ ScrapingBee profile ─ Parse Profile
                                                                    │
                                       ┌── nobody listed? ──► Wait ─ ScrapingBee /lica ─ Parse
                                       ▼
                              Write row? ── yes ──► Prepare Row ─ Google Sheets (append)
                                       └── no (fetch failed) ──► back to loop
```

**Two requests per company.** `Контакт лице` comes from the main profile page — first
`Управител`, falling back to `Сопственик`. The `/lica` sub-page is fetched **only** when
the profile page lists nobody at all.

**Rate limiting.** Every outbound request is preceded by a Wait node with a fresh random
**3–5 second** delay, and the company loop has batch size 1, so at most one request is in
flight at a time. This is asserted in the test suite — a Wait node cannot be dropped
without failing `npm test`.

**Phone de-duplication.** The same number appears on-page both formatted (`046/250-383`)
and digits-only (`046250383`). Numbers are normalised (separators stripped, `+389` → `0`)
before de-duplication, so each real number appears once; the human-readable spelling is
what lands in the sheet.

**Errors never stop the run.** A request that fails all 3 retries, or returns a
CAPTCHA/blocked page, is logged with its URL and skipped. Search pagination stops early
only after 3 *consecutive* failures. Missing phones or e-mails leave the cell blank.

---

## Configuration

Set in the **Config** node.

| Field | Default | Meaning |
| --- | --- | --- |
| `nkdCodes` | placeholder | НКД division(s) sent as `at=`, comma-separated. **Must be set** |
| `revenueFilterMode` | `off-zero` | `off-zero` / `off-omit` = no revenue filter; `range` = filter between the bounds below |
| `revenueFrom` / `revenueTo` | `5000000` / `400000000` | Revenue bounds — only used when `revenueFilterMode` is `range` |
| `enforceNkdMatch` | `true` | Skip companies whose profile НКД does not fall under the requested code |
| `balanceYear` | `2025` | `bly` — the financial year the filter applies to |
| `area` / `subarea` | *(empty)* | Empty = nationwide |
| `renderJs` | `'false'` | ScrapingBee JS rendering. Only set `'true'` if Step 0 says it's needed |
| `maxPages` | `60` | Safety cap on search pages, **per segment** |
| `maxCompanies` | `0` | `0` = unlimited; set low for a smoke run |
| `maxConsecutiveFailures` | `3` | Consecutive search-page failures before giving up |
| `revenueBandCount` | `8` | Revenue slices per НКД code. Only applies when `revenueFilterMode` is `range` |
| `writePartialRows` | `false` | `true` writes search-page fields when a profile fetch fails |
| `excludePhones` / `excludeEmails` | *(empty)* | Comma-separated values to never write |
| `googleSheetId` / `googleSheetName` | placeholder / `Sheet1` | Target sheet |
| `sheetEdbColumn` | `Даночен БРОЈ` | Column read back to skip companies already collected |

---

## Repo layout

```
src/lib/parsers.js      All HTML parsing. Dependency-free; the single source of truth.
src/nodes/*.js          One file per n8n Code node.
scripts/build.js        Inlines the library into each Code node, emits the workflow JSON.
workflows/*.json        Generated — import these into n8n.
test/                   121 tests: parser units, end-to-end simulation, structural checks.
docs/                   Step 0 instructions.
```

n8n Code nodes cannot `require()` a shared module, so the library is **inlined** into each
node at build time. The generated files carry a "do not edit here" banner: change
`src/`, then rebuild.

```bash
npm run build   # regenerate workflows/*.json
npm test        # 121 tests, no network access needed
npm run check   # both
```

### What the tests cover

- **Parser units** — the confirmed real examples (both address formats, the phone
  duplication, the `Сопственик`/`Управител` block, the `НКЗ` format), plus regressions
  for three bugs found during the build.
- **End-to-end simulation** (`test/workflow.test.js`) — runs the *actual generated node
  code* from the built JSON against fixture HTML, as both a first run and a follow-up run:
  the segment sweep, the `at=` filter being applied to every search, companies outside the
  requested division being skipped, pagination and its stop conditions, de-duplication
  against the existing sheet (including an ЕДБ stored as a number, and a mismatched column
  name), the `/lica` branch, a failed profile fetch being skipped rather than fatal, and
  the exact eight-column output.
- **Structural checks** — every request preceded by a Wait node, batch size 1, all traffic
  through ScrapingBee, every `$('Node')` reference resolving to a node that actually runs
  first, no authenticated URLs, no baked-in credentials.

> The HTML fixtures in `test/fixtures/` are **synthetic**. They reproduce the confirmed
> page structures but are not captures of live pages. Replacing them with real ScrapingBee
> output during Step 0 turns these into true regression tests — that is the single most
> valuable follow-up.

---

## If Step 0 shows the search rows don't parse

The likeliest gap, since that markup was never verified. The Step 0 report puts the first
3000 bytes of real HTML in `rawExcerpt` for any page that parsed zero rows.

Row extraction lives in `parseSearchResults()` in `src/lib/parsers.js`. It anchors on the
one stable fact — every result links to `/kompanija/{slug}/{code}` — and treats the HTML
between one company's link and the next as that company's "row window", then pattern-matches
inside it. Adjust the field patterns there, add a fixture from the real HTML, and rebuild.

Note that **`ЕДБ`, the address and the profile link are the only row fields that matter**
for the final output: status, employee count and revenue are read for verification only
and never reach the sheet. The НКД code is not on the results row at all — it is read from
the profile page, which is why the filter check happens there.
