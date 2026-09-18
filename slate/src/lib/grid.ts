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
  day: string;
  startTime: string;
  endTime: string;
  courseId: string;
  room?: string | null;
  faculty?: string | null;
  section?: string;
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

export function buildGrid(busy: BusyEntry[], changes: ChangeEntry[] = []): Cell[][] {
  return DAYS.map((day) =>
    HOURS.map(({ start, end }) => ({
      day,
      start,
      end,
      busy: busy.filter(
        (b) => b.day === day && overlaps(start, end, b.startTime, b.endTime),
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
