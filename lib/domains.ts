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
  color: string
}

export const DOMAINS: Record<DomainId, DomainConfig> = {
  general: {
    label: 'General',
    sources: ['wikipedia'],
    color: 'slate',
  },
  technology: {
    label: 'Technology',
    sources: ['wikipedia', 'mdn'],
    color: 'indigo',
  },
  programming: {
    label: 'Programming',
    sources: ['wikipedia', 'mdn'],
    color: 'violet',
  },
  medical: {
    label: 'Medical',
    sources: ['wikipedia'],
    color: 'emerald',
  },
  science: {
    label: 'Science',
    sources: ['wikipedia'],
    color: 'sky',
  },
  history: {
    label: 'History',
    sources: ['wikipedia'],
    color: 'amber',
  },
}

export const DEFAULT_DOMAIN: DomainId = 'general'

export function isDomainId(value: unknown): value is DomainId {
  return typeof value === 'string' && value in DOMAINS
}
