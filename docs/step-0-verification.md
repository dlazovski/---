# Step 0 — mandatory live verification

Run `workflows/step0-verification.json` **before** the main workflow.

It is read-only: it writes to no sheet and stores nothing outside the execution. It makes
about **12 ScrapingBee requests**, each preceded by a 3–5 second wait, so it takes roughly
two minutes.

**Set `nkdCodes` in its Config node first**, to the НКД division you intend to scrape.
Without it, only the baseline probe runs and the most important question goes unanswered.

## Why this exists as a workflow instead of already-reported findings

Step 0 asks for live ScrapingBee calls against the site. The environment this repo was
built in has no ScrapingBee API key, and its network egress proxy refuses connections to
both `www.companywall.com.mk` and `app.scrapingbee.com` (`CONNECT tunnel failed, response
403`). Rather than report guesses as confirmations, the verification is packaged as
something you can run in the n8n instance that *does* have the credential.

## The question that matters most

**Does `at=` actually filter by НКД?**

Every URL confirmed against the live site so far sent `at=` **empty**. Nothing establishes
what values it accepts. It might take an НКД code (`46`, `46.900`), or an internal ID that
looks nothing like one. Two ways this goes wrong:

- **Ignored** → the main workflow would scrape every active company in the country.
- **Wrong format** → it collects the wrong industry, or nothing at all.

Neither is visible from the search results page, because **the results rows do not show a
company's НКД code** — only profile pages do. So the check has to be indirect, which is
exactly what these probes do.

## What it probes

| Probe | Why |
| --- | --- |
| Search with `at=` **empty** | The yardstick. If the filtered search returns the same companies, `at=` is being ignored |
| Search with `at=<your code>` | The filter under test |
| Pages `2`, `3` of the filtered search | Confirm `&p=N` really pages |
| Filtered search at page `999` | Observe the **real** end-of-results behaviour instead of assuming one |
| Filtered search with the **revenue block omitted** | Compare the two ways of expressing "no revenue filter" |
| 4 profile pages from the filtered results | Read each company's **actual** НКД code, plus render_js / phone / owner-manager checks |

## Reading the report

Open the **Step 0 Report** node's output and start at the top:

```
safeToRunFullScrape: true | false
blockingFindings: [ ... ]
```

If `safeToRunFullScrape` is `false`, `blockingFindings` lists why. Then work through the
questions:

| Key | Question | What "good" looks like |
| --- | --- | --- |
| `q1_searchWorks` | Does the search return usable results at all? | `OK — results returned and parsed` |
| `q2_nkdFilterWorks` | **Does `at=<code>` restrict to that division?** | `CONFIRMED` |
| `q3_revenueFilterRemoval` | Which "no revenue filter" URL form does the site honour? | `EITHER WORKS` |
| `q4_pagination` | Does `&p=N` page, and what is the end of results? | `OK — each probed page returned different companies` |
| `q5_volume` | How many companies, and how long will that take? | A number you are willing to wait for |
| `q6_profilePages` | render_js needed? phone duplication? owner/manager present? | `CONFIRMED — a plain GET returns the Контакти data` |

### Acting on each verdict

**`q2` says `FILTER IGNORED`** — the filtered and unfiltered searches returned identical
companies. `at=` does nothing with this value. Do **not** run the full scrape; it would
collect the entire country. Report it back with the probe URLs, and the next step is to
find the parameter the site's own industry dropdown submits.

**`q2` says `WRONG CODES RETURNED`** — `at=` changed the result set, but none of the probed
companies are in the requested division. The parameter probably expects a different value
format, most likely an internal ID rather than the НКД code itself. Also do not run.

**`q2` says `MIXED`** — some probed companies fall under the code and some do not. A
division filter may be looser than expected, or the sample was unlucky. Look at
`q2.codesSeen` and decide; `enforceNkdMatch` in the main workflow will skip the ones that
do not match either way.

**`q3` says the forms differ** — the two "no revenue filter" URL forms returned different
result counts. Use whichever returns more by setting `revenueFilterMode` in the main
workflow's Config (`off-zero` or `off-omit`), and spot-check that its companies really are
unrestricted by revenue.

**`q4.highPageProbe.behaviour` says rows came back for `p=999`** — the site clamps the page
number rather than returning an empty list. That is expected and handled: the loop also
stops when a page repeats the previous one or contains only companies already collected.

**`q5` says `VERY LARGE`** — a whole division with no revenue filter can be thousands of
companies and many hours at the required pace. Consider narrowing to specific codes
(`46.110, 46.120`) rather than the whole division, or re-enabling a revenue filter.

**`q6.renderJs` says profiles returned no contact data** — set `renderJs` to `'true'` in
Config and re-run Step 0 to compare. This roughly doubles ScrapingBee credit usage, so only
do it if the plain fetch genuinely comes back empty.

## After Step 0

1. Report the verdicts back — especially `q2_nkdFilterWorks` and `q5_volume`.
2. In the main workflow's Config, set `nkdCodes`, `googleSheetId` and `googleSheetName`.
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
