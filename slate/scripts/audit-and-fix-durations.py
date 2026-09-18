"""
One-time audit + fix: systematically checks EVERY regular per-section
course entry (not just the elective/common blocks fixed earlier) for
cells merged across multiple real hour-columns, and corrects the
TimetableSlot rows whose duration was under-reported.

Why this was needed: the original extraction only checked merge state
for cells that didn't match the normal "Sec X" pattern (the elective
blocks). Regular per-section entries were read column-by-column with
no merge check at all, so any of them merged across multiple hours
silently lost the extra time -- confirmed for IML (Mon, 5th sem) by a
user cross-checking their own real timetable screenshot, which showed
IVP running 9-11 AM Friday, matching this same class of bug exactly.

Key subtlety: a cell merge spanning multiple spreadsheet COLUMNS isn't
automatically multiple real HOURS -- some sheets merge two columns in
the header itself to represent one hour (e.g. 3rd sem's E:F for
11:00-12:00, 5th sem's K:L for 5:30-6:30). This script maps each
column to its real hour-label first (columns sharing a header merge
share a label), then only flags cells whose merge spans more than one
DISTINCT real label.

This script is a record of that audit + the one-time fix it applied
(via direct DynamoDB update, not shown here -- see git history around
the commit that added this file). Re-running it against the same
source file reproduces the same 49 findings; it does not re-apply
them (no write logic below), since the database is already corrected.
"""
import openpyxl
import re

SOURCE = '/home/kavyan2/Downloads/TimeTable_IT_July-Dec26.xlsx'

COL_LABELS_5TH = {
    2: ('08:00', '09:00'), 3: ('09:00', '10:00'), 4: ('10:00', '11:00'),
    5: ('11:00', '12:00'), 6: ('12:00', '13:00'), 8: ('14:30', '15:30'),
    9: ('15:30', '16:30'), 10: ('16:30', '17:30'), 11: ('17:30', '18:30'),
}
COL_LABELS_3RD = {
    2: ('08:00', '09:00'), 3: ('09:00', '10:00'), 4: ('10:00', '11:00'),
    5: ('11:00', '12:00'), 6: ('11:00', '12:00'),  # E:F header-merged, same hour
    7: ('12:00', '13:00'), 9: ('14:30', '15:30'), 10: ('15:30', '16:30'),
    11: ('16:30', '17:30'), 12: ('17:30', '18:30'),
}

ENTRY_RE = re.compile(
    r'([A-Za-z.]+)\s*\(([A-Za-z]+)\)\s*-\s*Sec\s*([A-Za-z0-9,\s]+?)\s*\(([^)]+)\)'
)
DAYS = {'MON', 'TUE', 'WED', 'THU', 'FRI'}


def find_real_durations(wb, sheet_name, col_labels, day_rows_bound, time_cols):
    ws = wb[sheet_name]
    merged = list(ws.merged_cells.ranges)

    day_rows = []
    last_day, last_start = None, None
    for r in range(3, day_rows_bound):
        a = ws.cell(row=r, column=1).value
        if a in DAYS:
            if last_day:
                day_rows.append((last_day, last_start, r - 1))
            last_day, last_start = a, r
    if last_day:
        day_rows.append((last_day, last_start, day_rows_bound - 1))

    results = []
    for day, r0, r1 in day_rows:
        for col in time_cols:
            for r in range(r0, r1 + 1):
                cell = ws.cell(row=r, column=col)
                if not cell.value:
                    continue
                mr = next((mc for mc in merged if cell.coordinate in mc), None)
                if mr is None or cell.row != mr.min_row or cell.column != mr.min_col:
                    continue
                labels = []
                for c in range(mr.min_col, mr.max_col + 1):
                    lbl = col_labels.get(c)
                    if lbl and lbl not in labels:
                        labels.append(lbl)
                if len(labels) <= 1:
                    continue
                labels.sort()
                real_start, real_end = labels[0][0], labels[-1][1]
                orig_start, orig_end = col_labels.get(col, (None, None))
                for line in str(cell.value).split('\n'):
                    m = ENTRY_RE.search(line.strip())
                    if not m:
                        continue
                    code, _kind, secs, room = m.groups()
                    for sec in re.split(r'[,\s]+', secs.strip()):
                        if sec:
                            results.append({
                                'sheet': sheet_name, 'day': day, 'courseId': code,
                                'section': sec, 'room': room.strip(),
                                'origStart': orig_start, 'origEnd': orig_end,
                                'realStart': real_start, 'realEnd': real_end,
                            })
    return results


def main():
    wb = openpyxl.load_workbook(SOURCE, data_only=True)
    r5 = find_real_durations(wb, 'BTech5thSem', COL_LABELS_5TH, 13, [2, 3, 4, 5, 6, 8, 9, 10, 11])
    r3 = find_real_durations(wb, 'BTech3rdSem', COL_LABELS_3RD, 40, [2, 3, 4, 5, 6, 7, 9, 10, 11, 12])
    findings = r5 + r3
    for f in findings:
        print(f)
    print(f'{len(findings)} entries with under-reported duration')


if __name__ == '__main__':
    main()
