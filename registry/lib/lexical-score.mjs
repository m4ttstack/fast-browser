// Shared lexical-search scoring (registry store interface, keyless
// fallback mode). Both memory-store.mjs and pg-store.mjs import this
// rather than each defining their own copy of the scoring algorithm --
// pg-store uses Postgres ILIKE only to narrow candidate rows (cheap,
// index-friendly-enough prefilter), then scores the narrowed set with this
// exact same function, so the two stores' search({ intentText }) results
// are byte-for-byte identical, not just "similar in spirit".

// Splits `intentText` into lowercased, whitespace-separated terms. Shared
// so both stores tokenize a query the same way.
export function queryTermsFrom(intentText) {
  return (intentText ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}

// Term-overlap scoring over `name + description`: the fraction of the
// (lowercased) query terms that appear as a substring of the haystack. 0
// when nothing matches (callers filter these out), up to 1 when every
// query term is present. Simple and honest rather than a real text-search
// ranking -- this is the keyless fallback the plan documents as clearly
// marked 'lexical' mode, not a semantic replacement.
export function lexicalScore(record, queryTerms) {
  if (queryTerms.length === 0) return 0;
  const haystack = `${record.name} ${record.description}`.toLowerCase();
  const matched = queryTerms.filter((term) => haystack.includes(term)).length;
  return matched / queryTerms.length;
}
