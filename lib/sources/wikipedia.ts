// Wikipedia is one instance of the generic MediaWiki fetcher. Kept as its own
// module so existing imports (`fetchWikipedia`, `FetchedDoc`) stay stable; the
// request logic lives in mediawiki.ts and is shared with the other wikis.
export { fetchWikipedia, type FetchedDoc } from './mediawiki'
