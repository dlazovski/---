# CompanyWall MK — revenue-filtered company scrape

An n8n workflow that searches [companywall.com.mk](https://www.companywall.com.mk) for
active companies **anywhere in North Macedonia** with annual revenue between
**5,000,000 and 400,000,000 MKD**, paginates through every result page, opens each
company's public profile, and appends one row per company to an existing Google Sheet.

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
| Search URL parameters, order and `dsm[...]` syntax | The **search-results page markup** |
| City = comma segment before "Република Северна Македонија" | The **end-of-results behaviour** (empty list? repeated page?) |
| Profile page label is `НКЗ`, formatted `27.110 - …` | **Total result count** (~400 was an expectation, not a measurement) |
| `Сопственик{NAME}Управител{NAME}` block on the profile page | That `render_js=false` suffices **through ScrapingBee specifically** |
| Same phone appears formatted *and* digits-only | Whether the `/lica` fallback is ever actually needed |

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

Open **Google Sheets — Append** and select the Google credential.

### 4. Point at the sheet

In the **Config** node of the main workflow:

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

At ~400 companies and 2 requests each, plus a 3–5 s wait per request, expect roughly
**800 requests and 60–90 minutes**. That pace is deliberate — see below.

When the run finishes, open **Build Summary** for the run report: rows written, failures
by stage with their URLs, duplicates skipped, and counts of companies with no phone, no
e-mail, or no owner/manager on the main page.

---

## How it works

```
Config ─ Init State ─┬─► Build Search URL ─ Wait ─ ScrapingBee ─ Parse Results ─ More pages? ─┐
                     └──────────────────────── loop back ◄───────────────────────────────────┘
                                                                    │ no more pages
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
| `revenueFrom` / `revenueTo` | `5000000` / `400000000` | Revenue filter (MKD), inclusive |
| `balanceYear` | `2025` | `bly` — the financial year the filter applies to |
| `area` / `subarea` / `activityType` | *(empty)* | Empty = nationwide, all industries |
| `renderJs` | `'false'` | ScrapingBee JS rendering. Only set `'true'` if Step 0 says it's needed |
| `maxPages` | `60` | Safety cap on search pages |
| `maxCompanies` | `0` | `0` = unlimited; set low for a smoke run |
| `maxConsecutiveFailures` | `3` | Consecutive search-page failures before giving up |
| `writePartialRows` | `false` | `true` writes search-page fields when a profile fetch fails |
| `excludePhones` / `excludeEmails` | *(empty)* | Comma-separated values to never write |
| `googleSheetId` / `googleSheetName` | placeholder / `Sheet1` | Target sheet |

---

## Repo layout

```
src/lib/parsers.js      All HTML parsing. Dependency-free; the single source of truth.
src/nodes/*.js          One file per n8n Code node.
scripts/build.js        Inlines the library into each Code node, emits the workflow JSON.
workflows/*.json        Generated — import these into n8n.
test/                   78 tests: parser units, end-to-end simulation, structural checks.
docs/                   Step 0 instructions.
```

n8n Code nodes cannot `require()` a shared module, so the library is **inlined** into each
node at build time. The generated files carry a "do not edit here" banner: change
`src/`, then rebuild.

```bash
npm run build   # regenerate workflows/*.json
npm test        # 78 tests, no network access needed
npm run check   # both
```

### What the tests cover

- **Parser units** — the confirmed real examples (both address formats, the phone
  duplication, the `Сопственик`/`Управител` block, the `НКЗ` format), plus regressions
  for three bugs found during the build.
- **End-to-end simulation** (`test/workflow.test.js`) — runs the *actual generated node
  code* from the built JSON against fixture HTML: pagination and its stop condition, the
  `/lica` branch, a failed profile fetch being skipped rather than fatal, and the exact
  eight-column output.
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
and never reach the sheet.
