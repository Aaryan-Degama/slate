"""
Fixes a systematic duration bug distinct from the earlier "49 rows" audit
(see NOTES.md / audit-and-fix-durations.py): a merge that spans multiple
COLUMNS on a SINGLE row (e.g. E7:F7) is the sheet author using a wider
text box for that row's cell -- not a class running across both time
columns. Every entry inside such a merge is really just ONE HOUR, in the
FIRST of the merged columns' time slot.

Distinguishing rule (verified against the real sheet, see conversation):
  - multi-ROW merge, same column (e.g. C3:C4)   -> genuine multi-hour class
  - multi-COLUMN merge, single row (e.g. E7:F7)  -> cosmetic; NOT multi-hour

Found by cross-checking a user-reported bug (DTI lecture missing from
Thursday 12-1, Sec B, BTech IT Sem 5 -- which turned out to be present and
correct) against a neighboring cell (CS (L) Sec B, Thursday 14:30) that
mis-recorded as a 2-hour class purely because it shared a same-row merged
cell (H9:I9) with two real 2-hour practicals (DTI P, IML P). Verified
every other practical in the dataset is consistently 2hr, confirming
DTI(P)/IML(P) in that cell ARE genuinely 2hr and only the co-located
lecture entries (CS L) were wrongly stretched.
"""
import openpyxl
import re
import boto3

SOURCE = '/home/kavyan2/Downloads/TimeTable_IT_July-Dec26.xlsx'
TABLE_NAME = 'TimetableSlot-r6zl3l4akngx5g3dhqm7v5pzd4-NONE'
REGION = 'ap-south-1'

ENTRY_RE = re.compile(
    r'([A-Za-z.]+)\s*\(([A-Za-z]+)\)\s*-\s*Sec\s*([A-Za-z0-9,\s]+?)\s*\(([^)]+)\)'
)
DAYS = {'MON', 'TUE', 'WED', 'THU', 'FRI'}

TIME_COLS_5TH = {
    2: ('08:00', '09:00'), 3: ('09:00', '10:00'), 4: ('10:00', '11:00'),
    5: ('11:00', '12:00'), 6: ('12:00', '13:00'), 8: ('14:30', '15:30'),
    9: ('15:30', '16:30'), 10: ('16:30', '17:30'), 11: ('17:30', '18:30'),
}
TIME_COLS_3RD = {
    2: ('08:00', '09:00'), 3: ('09:00', '10:00'), 4: ('10:00', '11:00'),
    5: ('11:00', '12:00'), 7: ('12:00', '13:00'), 9: ('14:30', '15:30'),
    10: ('15:30', '16:30'), 11: ('16:30', '17:30'), 12: ('17:30', '18:30'),
}


def find_bad_entries(ws, time_cols, max_row):
    day_rows = []
    last_day, last_start = None, None
    for r in range(3, max_row):
        a = ws.cell(row=r, column=1).value
        if a in DAYS:
            if last_day:
                day_rows.append((last_day, last_start, r - 1))
            last_day, last_start = a, r
    if last_day:
        day_rows.append((last_day, last_start, max_row - 1))

    merges = list(ws.merged_cells.ranges)
    bad = []
    for day, r0, r1 in day_rows:
        for col in time_cols:
            for rng in merges:
                if rng.min_row == r0 and rng.max_row == r0 and rng.min_col == col and rng.max_col > col:
                    text = ws.cell(row=r0, column=col).value or ''
                    start, end = time_cols[col]
                    for line in text.split('\n'):
                        line = line.strip()
                        if not line:
                            continue
                        m = ENTRY_RE.search(line)
                        if not m:
                            continue
                        code, kind, secs, room = m.groups()
                        for sec in re.split(r'[,\s]+', secs.strip()):
                            if sec:
                                bad.append({
                                    'day': day, 'courseId': code, 'sessionType': kind.upper(),
                                    'section': sec, 'room': room.strip(),
                                    'correctStart': start, 'correctEnd': end,
                                })
    return bad


def main():
    wb = openpyxl.load_workbook(SOURCE, data_only=True)
    entries = (
        [(3, e) for e in find_bad_entries(wb['BTech3rdSem'], TIME_COLS_3RD, 40)]
        + [(5, e) for e in find_bad_entries(wb['BTech5thSem'], TIME_COLS_5TH, 13)]
    )

    ddb = boto3.resource('dynamodb', region_name=REGION)
    table = ddb.Table(TABLE_NAME)
    items = table.scan()['Items']

    fixed, not_found, already_ok = 0, [], 0
    for semester, e in entries:
        # match by day/courseId/section/room/sessionType, any current duration
        matches = [
            it for it in items
            if it.get('semester') == semester
            and it.get('day') == e['day']
            and it.get('courseId') == e['courseId']
            and it.get('section') == e['section']
            and it.get('room') == e['room']
            and it.get('sessionType') == e['sessionType']
            and it.get('startTime') == e['correctStart']
        ]
        if len(matches) != 1:
            not_found.append((semester, e, len(matches)))
            continue
        row = matches[0]
        if row['endTime'] == e['correctEnd']:
            already_ok += 1
            continue
        table.update_item(
            Key={'id': row['id']},
            UpdateExpression='SET endTime = :e',
            ExpressionAttributeValues={':e': e['correctEnd']},
        )
        print(f"fixed: {e['courseId']} {e['sessionType']} Sec {e['section']} {e['day']} "
              f"{row['startTime']}-{row['endTime']} -> {e['correctStart']}-{e['correctEnd']}")
        fixed += 1

    print(f'\nfixed {fixed} rows, {already_ok} already correct, {len(not_found)} not matched')
    for nf in not_found:
        print('NOT MATCHED:', nf)


if __name__ == '__main__':
    main()
