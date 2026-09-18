import { useEffect, useState } from 'react'
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../amplify/data/resource'
import TimetableGrid from './components/TimetableGrid'
import { buildGrid, DAYS, HOURS, type BusyEntry, type Cell } from './lib/grid'

const client = generateClient<Schema>()

type SlotRow = {
  id: string
  program: string
  branch: string
  section: string
  semester: number
  day: string
  startTime: string
  endTime: string
  courseId: string
  room?: string | null
  faculty?: string | null
}
const listSlots = client.models.TimetableSlot.list as unknown as () => Promise<{ data: SlotRow[] }>
const createSlot = client.models.TimetableSlot.create as unknown as (
  input: Omit<SlotRow, 'id'>,
) => Promise<{ data: SlotRow | null; errors?: { message: string }[] }>
const updateSlot = client.models.TimetableSlot.update as unknown as (
  input: Partial<SlotRow> & { id: string },
) => Promise<{ data: SlotRow | null; errors?: { message: string }[] }>
const deleteSlot = client.models.TimetableSlot.delete as unknown as (
  input: { id: string },
) => Promise<{ errors?: { message: string }[] }>

// Program + branch + semester only -- a "batch," matching the source
// spreadsheet's own layout of one grid per semester with every section's
// classes stacked together in each cell, not one grid per section.
type BatchRef = { program: string; branch: string; semester: number }

export default function AdminTimetableEditor() {
  const [options, setOptions] = useState<BatchRef[]>([])
  const [selected, setSelected] = useState<BatchRef | null>(null)
  const [rows, setRows] = useState<SlotRow[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Partial<SlotRow> | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    listSlots().then(({ data }) => {
      const seen = new Set<string>()
      const opts: BatchRef[] = []
      for (const r of data) {
        const key = `${r.program}|${r.branch}|${r.semester}`
        if (!seen.has(key)) {
          seen.add(key)
          opts.push({ program: r.program, branch: r.branch, semester: r.semester })
        }
      }
      opts.sort((a, b) => a.semester - b.semester)
      setOptions(opts)
      setLoading(false)
    })
  }, [])

  const loadRows = (sel: BatchRef) => {
    setLoading(true)
    listSlots().then(({ data }) => {
      setRows(
        data.filter(
          (r) => r.program === sel.program && r.branch === sel.branch && r.semester === sel.semester,
        ),
      )
      setLoading(false)
    })
  }

  const select = (sel: BatchRef) => {
    setSelected(sel)
    loadRows(sel)
  }

  // All sections' rows go into the same grid -- buildGrid already stacks
  // multiple entries that land in the same day/hour, same as the source
  // spreadsheet's cells.
  const grid: Cell[][] | null = selected ? buildGrid(rows.map((r) => ({ ...r } as BusyEntry))) : null

  const handleBusyClick = (entry: BusyEntry) => {
    const row = rows.find((r) => r.id === entry.id)
    if (row) setEditing({ ...row })
  }

  const handleEmptyClick = (day: string, start: string, end: string) => {
    if (!selected) return
    setEditing({
      day,
      startTime: start,
      endTime: end,
      program: selected.program,
      branch: selected.branch,
      semester: selected.semester,
      section: '',
      courseId: '',
      room: '',
      faculty: '',
    })
  }

  const handleSave = async () => {
    if (!editing || !selected) return
    setError('')
    try {
      if (editing.id) {
        const res = await updateSlot(editing as Partial<SlotRow> & { id: string })
        if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '))
      } else {
        const res = await createSlot(editing as Omit<SlotRow, 'id'>)
        if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '))
      }
      setEditing(null)
      loadRows(selected)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.')
    }
  }

  const handleDelete = async () => {
    if (!editing?.id || !selected) return
    setError('')
    try {
      const res = await deleteSlot({ id: editing.id })
      if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '))
      setEditing(null)
      loadRows(selected)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed.')
    }
  }

  if (loading && !selected) return <p>Loading...</p>

  return (
    <div className="dashboard">
      <h1>Correct Timetable Data</h1>
      <p className="subtitle">
        One grid per semester, every section's classes together — same layout as the source
        sheet. Click any class to fix or remove it. Click an empty cell to add a missing one.
      </p>

      <div className="option-list">
        {options.map((opt) => (
          <button
            key={`${opt.program}-${opt.branch}-${opt.semester}`}
            className={
              selected &&
              selected.program === opt.program &&
              selected.branch === opt.branch &&
              selected.semester === opt.semester
                ? 'active'
                : ''
            }
            onClick={() => select(opt)}
          >
            {opt.program} {opt.branch} — Semester {opt.semester}
          </button>
        ))}
      </div>

      {selected && grid && !loading && (
        <TimetableGrid grid={grid} onBusyClick={handleBusyClick} onEmptyClick={handleEmptyClick} />
      )}
      {selected && loading && <p>Loading timetable...</p>}

      {editing && (
        <EditForm
          value={editing}
          onChange={setEditing}
          onSave={handleSave}
          onDelete={editing.id ? handleDelete : undefined}
          onCancel={() => {
            setEditing(null)
            setError('')
          }}
          error={error}
        />
      )}
    </div>
  )
}

function EditForm({
  value,
  onChange,
  onSave,
  onDelete,
  onCancel,
  error,
}: {
  value: Partial<SlotRow>
  onChange: (v: Partial<SlotRow>) => void
  onSave: () => void
  onDelete?: () => void
  onCancel: () => void
  error: string
}) {
  const set = (patch: Partial<SlotRow>) => onChange({ ...value, ...patch })

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <h2>{value.id ? 'Edit class' : 'Add class'}</h2>

      <div className="two-columns" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label>
          Day
          <select value={value.day} onChange={(e) => set({ day: e.target.value })}>
            {DAYS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label>
          Course code
          <input value={value.courseId ?? ''} onChange={(e) => set({ courseId: e.target.value })} />
        </label>
        <label>
          Start time
          <select value={value.startTime} onChange={(e) => set({ startTime: e.target.value })}>
            {HOURS.map((h) => (
              <option key={h.start} value={h.start}>
                {h.start}
              </option>
            ))}
          </select>
        </label>
        <label>
          End time
          <select value={value.endTime} onChange={(e) => set({ endTime: e.target.value })}>
            {HOURS.map((h) => (
              <option key={h.end} value={h.end}>
                {h.end}
              </option>
            ))}
          </select>
        </label>
        <label>
          Section
          <input
            value={value.section ?? ''}
            placeholder="e.g. A, B1"
            onChange={(e) => set({ section: e.target.value })}
          />
        </label>
        <label>
          Room
          <input value={value.room ?? ''} onChange={(e) => set({ room: e.target.value })} />
        </label>
        <label>
          Faculty
          <input value={value.faculty ?? ''} onChange={(e) => set({ faculty: e.target.value })} />
        </label>
      </div>

      {error && <p className="error">{error}</p>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="primary" onClick={onSave}>
          Save
        </button>
        {onDelete && (
          <button type="button" onClick={onDelete} style={{ color: 'var(--danger)' }}>
            Delete
          </button>
        )}
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
