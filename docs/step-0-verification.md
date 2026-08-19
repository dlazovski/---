# Step 0 — mandatory live verification

Run `workflows/step0-verification.json` **before** the main workflow.

It is read-only: it writes to no sheet and stores nothing outside the execution. It makes
about **8 ScrapingBee requests**, each preceded by a 3–5 second wait, so it takes roughly
a minute.

## Why this exists as a workflow instead of already-reported findings

Step 0 asks for live ScrapingBee calls against the site. The environment this repo was
built in has no ScrapingBee API key, and its network egress proxy refuses connections to
both `www.companywall.com.mk` and `app.scrapingbee.com` (`CONNECT tunnel failed, response
403`). Rather than report guesses as confirmations, the verification is packaged as
something you can run in the n8n instance that *does* have the credential.

## What it probes

| Probe | Why |
| --- | --- |
| Search pages `p=1`, `p=2`, `p=3` | Confirm the nationwide/all-industry filter works, that revenues land in range, and that `&p=N` really pages |
| Search page `p=999` | Observe the **real** end-of-results behaviour instead of assuming one |
| 1 known-good profile (the МАКИТЕЛ page already inspected by hand) | Control: proves the profile parser works on a page whose content is known |
| 3 profiles discovered by the search probes, preferring different cities | Test the questions that need variety: render_js, phone duplication, owner/manager presence |

## Reading the report

Open the **Step 0 Report** node's output. It is one item, keyed by the seven Step 0
questions, each with a `verdict` string.

| Key | Question | What "good" looks like |
| --- | --- | --- |
| `q1_searchUrlWorks` | Does the confirmed URL return results through ScrapingBee? | `OK — results returned and parsed` |
| `q2_nationwideAllIndustries` | Nationwide, not one region or industry? | `LOOKS NATIONWIDE` with several distinct cities |
| `q3_revenueInRange` | Revenues inside 5,000,000–400,000,000? | `OK — every parsed revenue is inside the range` |
| `q4_pagination` | Does `&p=N` page, and what is the end of results? | `OK — each probed page returned different companies`, plus a concrete `highPageProbe.behaviour` |
| `q5_totalVolume` | Roughly how many companies? | `IN THE EXPECTED BALLPARK` (~400) |
| `q6_profilePages` | render_js needed? phone duplication? owner/manager present? | `CONFIRMED — a plain GET returns the Контакти data` |
| `q7_nextStep` | — | Instructions |

### Acting on each verdict

**`q1` is not OK** — check `rawSearchPageRecords[0].rawExcerpt` (first 3000 bytes of real
HTML). If it is a CAPTCHA or block page, add `premium_proxy=true` and `country_code=mk` as
query parameters on the ScrapingBee nodes. If it is a normal page that simply parsed no
rows, the row markup differs from what the parser expects — see the last section of the
README.

**`q3` says UNVERIFIED** — revenue could not be parsed from the search rows. This does not
block the run: revenue is never written to the sheet, and the filtering is done by the site,
not by us. It only means this particular cross-check could not be performed.

**`q4.highPageProbe.behaviour` says the site returned rows for `p=999`** — the site clamps
the page number rather than returning an empty list. That is expected and handled: the loop
also stops when a page repeats the previous one or contains only companies already
collected. No change needed; just confirm the loop terminates on the smoke run.

**`q5` is far from ~400** — report back before running the full scrape. Far higher means the
filter is broader than intended (and the run will be much longer and more expensive); far
lower means it is narrower.

**`q6.renderJs` says profiles returned no contact data** — set `renderJs` to `'true'` in the
Config node and re-run Step 0 to compare. This roughly doubles ScrapingBee credit usage, so
only do it if the plain fetch genuinely comes back empty.

**`q6.ownerManager` says several companies need the `/lica` fallback** — the workflow handles
it automatically; it just means more than 2 requests per company for those, and a slower run.

## After Step 0

1. Report the verdicts back.
2. In the main workflow's Config, set `googleSheetId` and `googleSheetName`.
3. Set `maxCompanies` to `5`, run, and check the rows that land in the sheet.
4. Set `maxCompanies` back to `0` and run for real.

## Turning the probes into permanent regression tests

The fixtures in `test/fixtures/` are synthetic — they reproduce the confirmed structures but
are not real pages. Once Step 0 has run, saving the real HTML makes the whole test suite
meaningful:

1. From the Step 0 execution, copy the `data` field of a **ScrapingBee — Search Page** node
   run and a **ScrapingBee — Profile Page** node run.
2. Save them over `test/fixtures/search-page.html` and `test/fixtures/profile-makitel.html`.
3. Update the expected values in `test/parsers.test.js` and `test/workflow.test.js` to match
   the real companies.
4. `npm test`.

From that point the tests verify the parsers against reality rather than against
reconstructions.
