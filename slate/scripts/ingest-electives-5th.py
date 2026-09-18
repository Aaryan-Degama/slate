"""
Elective/common-period busy blocks for the 5th-sem sheet, same principle
as ingest-electives.py -- see NOTES.md for the reasoning (no per-student
enrollment data, so we mark the union of real meeting times as busy for
the whole cohort rather than guessing who picked what).

This sheet has MDM-3 (the minor/elective basket, genuinely meeting at
three different times -- confirms the "options within a basket can have
different hour patterns" case flagged earlier), plus HI and CE, each of
which also has its own separate common slot(s) not captured by the
per-section regex.

NOTE: BPM was originally included here too and was wrong -- the sheet
labels it "BPM (L) - IT-BI (LT-3112)", where "IT-BI" is a cohort
qualifier (a separate combined IT+BI program, not "everyone in IT"),
the same shape of label as the regular per-section entries ("- Sec X"),
just naming a different audience instead of a section. It should never
have been treated as a generic elective applying to A/B/C. We don't
track the IT-BI cohort at all right now (no roll-range data for it),
so it's correctly left out entirely rather than wrongly applied here.
"""
import uuid
import boto3

TABLE_NAME = 'TimetableSlot-r6zl3l4akngx5g3dhqm7v5pzd4-NONE'
REGION = 'ap-south-1'

# (label, day, startTime, endTime) -- read directly off the real grid
# (BTech5thSem sheet).
BLOCKS = [
    ('HI', 'MON', '14:30', '15:30'),
    ('MDM-3', 'TUE', '09:00', '10:00'),
    ('MDM-3', 'TUE', '16:30', '17:30'),
    ('MDM-3', 'FRI', '15:30', '16:30'),
    ('CE', 'WED', '17:30', '18:30'),
]
SECTIONS = ['A', 'B', 'C']


def main():
    ddb = boto3.resource('dynamodb', region_name=REGION)
    table = ddb.Table(TABLE_NAME)

    written = 0
    with table.batch_writer() as batch:
        for basket, day, start, end in BLOCKS:
            for section in SECTIONS:
                item = {
                    'id': str(uuid.uuid4()),
                    '__typename': 'TimetableSlot',
                    'program': 'BTech',
                    'branch': 'IT',
                    'semester': 5,
                    'section': section,
                    'day': day,
                    'startTime': start,
                    'endTime': end,
                    'courseId': basket,
                    'createdAt': '2026-09-18T00:00:00.000Z',
                    'updatedAt': '2026-09-18T00:00:00.000Z',
                }
                batch.put_item(Item=item)
                written += 1

    print(f'Wrote {written} elective busy-block rows (5th sem) to {TABLE_NAME}')


if __name__ == '__main__':
    main()
