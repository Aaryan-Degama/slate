// Canonical weekly grid, matching the real IIITA class-hour structure
// (read off the actual timetable spreadsheet during ingestion — not
// arbitrary hour boundaries). Lunch (13:00-14:30) is intentionally
// excluded: it's never a candidate slot.
export const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI'] as const;
export type Day = (typeof DAYS)[number];

export const HOURS: { start: string; end: string }[] = [
  { start: '08:00', end: '09:00' },
  { start: '09:00', end: '10:00' },
  { start: '10:00', end: '11:00' },
  { start: '11:00', end: '12:00' },
  { start: '12:00', end: '13:00' },
  { start: '14:30', end: '15:30' },
  { start: '15:30', end: '16:30' },
  { start: '16:30', end: '17:30' },
  { start: '17:30', end: '18:30' },
];

export type BusyEntry = {
  id?: string;
  day: string;
  startTime: string;
  endTime: string;
  courseId: string;
  room?: string | null;
  faculty?: string | null;
  section?: string;
  /** L (lecture) | P (practical) | T (tutorial). */
  sessionType?: string | null;
  /** Present when this entry represents several underlying rows merged
   * for display (same course/time/room, different sections -- e.g. the
   * source sheet's "TOC - Sec B2, C" got split into two rows on
   * ingestion for easy per-section querying, then re-merged here for
   * anyone looking at multiple sections at once). */
  mergedIds?: string[];
};

export type ChangeEntry = {
  day: string;
  startTime: string;
  endTime: string;
  courseId: string;
  changeType: 'SCHEDULED' | 'CANCELLED';
};

export type Cell = {
  day: Day;
  start: string;
  end: string;
  busy: BusyEntry[];
  change: ChangeEntry | null;
};

const overlaps = (aStart: string, aEnd: string, bStart: string, bEnd: string) =>
  aStart < bEnd && bStart < aEnd;

/** Combine entries that are really "the same class," just split across
 * sections during ingestion (same course, same day/time, same room) --
 * e.g. "TOC - Sec B2, C" becomes one "Sec B2, C" block instead of two
 * identical-looking ones stacked in the same cell. */
function mergeSameClass(entries: BusyEntry[]): BusyEntry[] {
  const groups = new Map<string, BusyEntry[]>();
  for (const e of entries) {
    const key = `${e.courseId}|${e.day}|${e.startTime}|${e.endTime}|${e.room ?? ''}`;
    const group = groups.get(key);
    if (group) group.push(e);
    else groups.set(key, [e]);
  }
  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0];
    const sections = [...new Set(group.map((g) => g.section).filter(Boolean))] as string[];
    sections.sort();
    return {
      ...group[0],
      section: sections.join(', '),
      mergedIds: group.map((g) => g.id).filter((id): id is string => Boolean(id)),
    };
  });
}

export function buildGrid(busy: BusyEntry[], changes: ChangeEntry[] = []): Cell[][] {
  return DAYS.map((day) =>
    HOURS.map(({ start, end }) => ({
      day,
      start,
      end,
      busy: mergeSameClass(
        busy.filter((b) => b.day === day && overlaps(start, end, b.startTime, b.endTime)),
      ),
      change:
        changes.find(
          (c) => c.day === day && overlaps(start, end, c.startTime, c.endTime),
        ) ?? null,
    })),
  );
}

/** Cells free across every one of the given per-section busy lists. */
export function freeAcrossAll(busyBySection: BusyEntry[][]): Cell[][] {
  const grids = busyBySection.map((b) => buildGrid(b));
  return DAYS.map((_, di) =>
    HOURS.map((_, hi) => {
      const cells = grids.map((g) => g[di][hi]);
      const free = cells.every((c) => c.busy.length === 0);
      return { ...cells[0], busy: free ? [] : cells.flatMap((c) => c.busy) };
    }),
  );
}
