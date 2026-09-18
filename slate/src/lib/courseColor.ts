// Deterministic, stable color per course code -- same course always gets
// the same color, no matter render order or session. A small curated
// palette (not random hue generation) so every color stays legible and
// consistent with the app's own green/forest theme rather than clashing
// with it.
const PALETTE = [
  { bg: '#eef2ff', text: '#3730a3', accent: '#6366f1' }, // indigo
  { bg: '#fef3e2', text: '#9a4a0a', accent: '#f59e0b' }, // amber
  { bg: '#fce7f3', text: '#9d174d', accent: '#ec4899' }, // pink
  { bg: '#e0f2fe', text: '#075985', accent: '#0ea5e9' }, // sky
  { bg: '#f3e8ff', text: '#6b21a8', accent: '#a855f7' }, // purple
  { bg: '#fee2e2', text: '#991b1b', accent: '#ef4444' }, // red
  { bg: '#ecfccb', text: '#3f6212', accent: '#84cc16' }, // lime
  { bg: '#e0f2f1', text: '#065f56', accent: '#14b8a6' }, // teal
  { bg: '#fff7ed', text: '#9a3412', accent: '#fb923c' }, // orange
  { bg: '#ede9fe', text: '#5b21b6', accent: '#8b5cf6' }, // violet
]

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i)
    h |= 0
  }
  return Math.abs(h)
}

export function courseColor(courseId: string) {
  return PALETTE[hashString(courseId) % PALETTE.length]
}
