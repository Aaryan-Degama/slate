"""
Adds elective/common-period busy blocks on top of the section-based rows
already loaded by ingest-timetable.py.

Real IIITA timetables run electives as baskets (e.g. "MDM-1", "HSMC") where
every student takes exactly one option from the basket, but options within
a basket can meet on different day/time patterns from each other (some
1hr x3 MWF, some 1hr+2hr, some a single 3hr block). We have no data on
which specific student picked which option, so per CLAUDE.md's honesty
principle we don't fabricate that precision: instead we mark the basket's
own real meeting time as busy for every section in the cohort, since every
student is doing *something* from the basket then. See NOTES.md §21 for
the full reasoning.

One-time script, not part of the deployed app. Read from the same real
spreadsheet ingest-timetable.py used; doesn't re-touch the rows that
script already wrote.
"""
import uuid
import boto3

TABLE_NAME = 'TimetableSlot-r6zl3l4akngx5g3dhqm7v5pzd4-NONE'
REGION = 'ap-south-1'

# (basket, day, startTime, endTime) — read directly off the real grid
# (BTech3rdSem sheet): HSMC at TUE row5/col11 and FRI row11/col11,
# MDM-1 at WED row7/col11 and FRI row11/col9.
#
# The TUE/WED/FRI "col11" (K) occurrences are all merged cells spanning
# K:L (two genuinely separate 1-hour header columns here -- confirmed by
# checking the header row itself, which does NOT merge K:L on this
# sheet), so those are real 2-hour blocks (16:30-18:30), not 1-hour --
# originally mis-extracted as 1 hour by reading columns independently
# without checking merge spans. Caught by a user cross-checking their
# own real timetable against the rendered grid.
BLOCKS = [
    ('HSMC', 'TUE', '16:30', '18:30'),
    ('HSMC', 'FRI', '16:30', '18:30'),
    ('MDM-1', 'WED', '16:30', '18:30'),
    ('MDM-1', 'FRI', '14:30', '15:30'),
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
                    'semester': 3,
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

    print(f'Wrote {written} elective busy-block rows to {TABLE_NAME}')


if __name__ == '__main__':
    main()
