export type DomainId =
  | 'general'
  | 'technology'
  | 'programming'
  | 'medical'
  | 'science'
  | 'history'

export type DomainConfig = {
  label: string
  // Source identifiers, in priority order. Used as Doc.source values and
  // as sourceFilter in retrieval. First source is fetched on a JIT miss.
  sources: string[]
}

export const DOMAINS: Record<DomainId, DomainConfig> = {
  general: {
    label: 'General',
    sources: ['wikipedia', 'simplewiki'],
  },
  technology: {
    label: 'Technology',
    sources: ['wikipedia', 'arxiv', 'wikibooks'],
  },
  programming: {
    label: 'Programming',
    sources: ['wikipedia', 'mdn', 'wikibooks', 'stackexchange'],
  },
  medical: {
    label: 'Medical',
    sources: ['wikipedia', 'pubmed'],
  },
  science: {
    label: 'Science',
    sources: ['wikipedia', 'arxiv', 'wikiversity'],
  },
  history: {
    label: 'History',
    sources: ['wikipedia', 'wikibooks'],
  },
}

export const DEFAULT_DOMAIN: DomainId = 'general'

export function isDomainId(value: unknown): value is DomainId {
  return typeof value === 'string' && value in DOMAINS
}
