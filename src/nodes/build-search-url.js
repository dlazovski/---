// @requires-parsers
// Build the search URL for the current page.
//
// The parameter list, its order and the raw (unencoded) dsm[...] bracket syntax
// are reproduced exactly as confirmed against the live site. Only the revenue
// bounds, the balance year and `p` vary.

const state = $input.first().json;
const url = buildSearchUrl(state, state.page);

return [{ json: { ...state, searchUrl: url } }];
