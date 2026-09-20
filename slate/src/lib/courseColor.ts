// Deterministic, stable color per course code -- same course always gets
// the same color, no matter render order or session. The tints are
// desaturated on purpose: eight of them sit on screen at once, so each
// one is quiet paper with a single saturated rail, the way a calendar
// app handles many events without turning into confetti.
const PALETTE = [
  { bg: '#eef1f8', text: '#31415f', accent: '#5b7bb0' }, // slate blue
  { bg: '#edf2ec', text: '#33503a', accent: '#6f9a70' }, // sage
  { bg: '#f8efea', text: '#6a4331', accent: '#c58466' }, // clay
  { bg: '#f3eef5', text: '#4f3a57', accent: '#8f6fa0' }, // plum
  { bg: '#f8f2e5', text: '#6b5220', accent: '#c39a48' }, // ochre
  { bg: '#e9f2f2', text: '#2c4f4e', accent: '#5d9695' }, // teal
  { bg: '#f8edf0', text: '#61323f', accent: '#b4727f' }, // rose
  { bg: '#f1f0ed', text: '#46464a', accent: '#8a8a86' }, // stone
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
