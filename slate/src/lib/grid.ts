// Canonical weekly grid, matching the real IIITA class-hour structure
// (read off the actual timetable spreadsheet during ingestion — not
// arbitrary hour boundaries). Lunch (13:00-14:30) is intentionally
// excluded: it's never a candidate slot.
// Saturday is shown too: normally empty, but makeup and compensatory
// classes land there, and a CR can schedule one.
export const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
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
  // Only some sheets use it (ECE 1st sem has a 6:30-7:30 pm column).
  { start: '18:30', end: '19:30' },
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
  /** The cancellation / move-away that takes this class off its date, if any. */
  cancelled?: ChangeEntry;
};

export type ChangeKind = 'CANCELLED' | 'EXTRA' | 'MOVED_FROM' | 'MOVED_TO';

/** A dated ScheduleChange row (one per affected section). */
export type ChangeEntry = {
  id?: string;
  groupId?: string;
  kind: ChangeKind;
  date: string; // YYYY-MM-DD
  /** Weekday of `date`; filled in by forWeek(). */
  day: string;
  startTime: string;
  endTime: string;
  courseId: string;
  section?: string;
  room?: string | null;
  relatedSlotId?: string | null;
  /** Email of whoever made / undid the change (a CR, or an admin). */
  changedBy?: string | null;
  changedBySection?: string | null;
  undoneBy?: string | null;
  undoneAt?: string | null;
  createdAt?: string;
};

/** Takes a class away (struck through) vs. puts one on the grid. */
export const removes = (k: ChangeKind) => k === 'CANCELLED' || k === 'MOVED_FROM';
export const KIND_LABEL: Record<ChangeKind, string> = {
  CANCELLED: 'Cancelled',
  EXTRA: 'Extra class',
  MOVED_FROM: 'Moved away',
  MOVED_TO: 'Moved here',
};

/** "iit2024245@iiita.ac.in" -> "IIT2024245": how a change's author is shown. */
export const personLabel = (email?: string | null) => (email ? email.split('@')[0].toUpperCase() : 'unknown');

// ---------------------------------------------------------------- dates
// Dates are plain YYYY-MM-DD strings in IST; the arithmetic runs in UTC so
// the browser's own timezone can't shift a day.
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const asUtc = (date: string) => new Date(`${date}T00:00:00Z`);
export const weekdayOf = (date: string) => DAY_NAMES[asUtc(date).getUTCDay()];
export const addDays = (date: string, n: number) => new Date(asUtc(date).getTime() + n * 86400e3).toISOString().slice(0, 10);
export const todayIst = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
/** The Monday of the week containing `date` (Sat/Sun roll forward to the next week). */
export function mondayOf(date: string): string {
  const d = asUtc(date).getUTCDay();
  return addDays(date, d === 0 ? 1 : d === 6 ? 2 : 1 - d);
}
/** The date of `day` (MON..FRI) in the week starting `monday`. */
export const dateIn = (monday: string, day: string) => addDays(monday, DAYS.indexOf(day as Day));
/** "2026-09-22" -> "Tue 22 Sep" */
export function formatDate(date: string): string {
  const d = asUtc(date);
  return `${DAY_NAMES[d.getUTCDay()][0]}${DAY_NAMES[d.getUTCDay()].slice(1).toLowerCase()} ${d.getUTCDate()} ${d.toLocaleString('en', { month: 'short', timeZone: 'UTC' })}`;
}

/** The live changes that fall in the week starting `monday`, with their weekday set. */
export function forWeek(changes: ChangeEntry[], monday: string): ChangeEntry[] {
  const saturday = addDays(monday, 5);
  return changes
    .filter((c) => !c.undoneAt && c.date >= monday && c.date <= saturday)
    .map((c) => ({ ...c, day: weekdayOf(c.date) }));
}

export type Cell = {
  day: Day;
  start: string;
  end: string;
  busy: BusyEntry[];
  change: ChangeEntry | null;
  /** Empty but not a proposed slot (outside the request's constraints). */
  outside?: boolean;
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
    const key = `${e.courseId}|${e.day}|${e.startTime}|${e.endTime}|${e.room ?? ''}|${e.cancelled ? 'x' : ''}`;
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

/** Is this class the one a cancellation refers to? */
const cancels = (c: ChangeEntry, b: BusyEntry) =>
  removes(c.kind) &&
  c.day === b.day &&
  (c.relatedSlotId && b.id
    ? c.relatedSlotId === b.id
    : c.courseId === b.courseId &&
      overlaps(c.startTime, c.endTime, b.startTime, b.endTime) &&
      (!c.section || !b.section || c.section === b.section));

/** One week's grid: regular classes, with `changes` (already narrowed to
 * that week by forWeek) applied -- removals strike their class through,
 * additions show as their own blocks. */
export function buildGrid(input: BusyEntry[], weekChanges: ChangeEntry[] = []): Cell[][] {
  const live = weekChanges.filter((c) => !c.undoneAt);
  const cancellations = live.filter((c) => removes(c.kind));
  const changes = live.filter((c) => !removes(c.kind));
  const busy = cancellations.length
    ? input.map((b) => {
        const c = cancellations.find((c) => cancels(c, b));
        return c ? { ...b, cancelled: c } : b;
      })
    : input;
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

