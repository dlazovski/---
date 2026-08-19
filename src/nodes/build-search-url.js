// @requires-parsers
// Build the search URL for the current revenue band and page.
//
// The parameter list, its order and the raw (unencoded) dsm[...] bracket syntax
// are reproduced exactly as confirmed against the live site. Only the revenue
// bounds (from the current band) and `p` vary.

const cfg = $('Config').first().json;
const state = $input.first().json;
const sd = $getWorkflowStaticData('global');

const band = sd.bands[state.bandIndex];

const url = buildSearchUrl(
  { ...cfg, revenueFrom: band.from, revenueTo: band.to },
  state.page
);

return [{ json: { ...state, band, searchUrl: url } }];
