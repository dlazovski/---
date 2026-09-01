// @requires-parsers
// Build the search URL for the current segment (НКД code x revenue band) and page.
//
// The parameter list, its order and the raw (unencoded) dsm[...] bracket syntax
// are reproduced exactly as confirmed against the live site. What varies is the
// activity code `at=`, the revenue slot, and `p`.

const cfg = $('Config').first().json;
const state = $input.first().json;
const sd = $getWorkflowStaticData('global');

const segment = sd.segments[state.segmentIndex];

const url = buildSearchUrl({ ...cfg, ...segment }, state.page);

return [{ json: { ...state, segment, segmentLabel: describeSegment(segment), searchUrl: url } }];
