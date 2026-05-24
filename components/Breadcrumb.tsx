import type { NodeInfo } from '@/lib/types'

type Props = {
  path: NodeInfo[]
  onNavigate: (node: NodeInfo, index: number) => void
}

export default function Breadcrumb({ path, onNavigate }: Props) {
  return (
    <nav className="flex items-center gap-1 text-sm">
      {path.map((node, i) => {
        const isLast = i === path.length - 1
        return (
          <span key={node.id} className="flex items-center gap-1">
            {i > 0 && <span className="text-[var(--fg-faint)] select-none">›</span>}
            {isLast ? (
              <span className="px-1.5 py-0.5 text-[var(--fg)] font-medium">{node.label}</span>
            ) : (
              <button
                onClick={() => onNavigate(node, i)}
                className="px-1.5 py-0.5 rounded text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface)] transition-colors"
              >
                {node.label}
              </button>
            )}
          </span>
        )
      })}
    </nav>
  )
}
