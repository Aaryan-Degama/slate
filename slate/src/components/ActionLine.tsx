import type { ReactNode } from 'react'
import { ago, describe, KIND_TAG, type Action } from '../lib/changes'
import { personLabel } from '../lib/grid'

/** One change, as a line: what, when, which sections, who, and whether it was undone. */
export default function ActionLine({
  action: x,
  isNew = false,
  showBatch = false,
  children,
}: {
  action: Action
  isNew?: boolean
  /** Admin log: say which batch it was in. */
  showBatch?: boolean
  children?: ReactNode
}) {
  return (
    <li className={`${x.undone ? 'undone' : ''}${isNew ? ' new' : ''}`}>
      <span className={`kind ${x.kind === 'EXTRA' ? 'added' : 'cancelled'}`}>{KIND_TAG[x.kind]}</span>
      <span>
        {showBatch && `${x.batch} · `}
        <strong>{x.courseId}</strong> · {describe(x)} · Sec {x.sections.join(', ')}
      </span>
      <span className="meta">
        by {personLabel(x.changedBy)}
        {x.changedBySection ? ` (CR, Sec ${x.changedBySection})` : ''} · {ago(x.createdAt)}
        {x.undone && ` · undone by ${personLabel(x.undoneBy)}`}
        {x.partlyUndoneFor.length > 0 && ` · taken off Sec ${x.partlyUndoneFor.join(', ')}`}
      </span>
      {children}
    </li>
  )
}
