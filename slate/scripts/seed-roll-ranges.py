"""
Moves the roll-number-to-section ranges out of hardcoded app code
(src/lib/rollLookup.ts) into the real RollRange table, per the decision
to keep this as actual database data an admin (eventually via a real
upload/OCR pipeline) manages, not something baked into the frontend.

Data given directly by the team, standing in for the admin role until a
real upload flow exists (same pattern as the timetable ingestion).
"""
import uuid
import boto3

TABLE_NAME = 'RollRange-r6zl3l4akngx5g3dhqm7v5pzd4-NONE'
REGION = 'ap-south-1'

# Batch admitted 2024 (graduating 2028), currently 5th semester.
# IEC range not yet provided -- left out rather than guessed.
RANGES = [
    ('2024', 'BTech', 'IT', 5, 1, 107, 'A'),
    ('2024', 'BTech', 'IT', 5, 108, 214, 'B'),
    ('2024', 'BTech', 'IT', 5, 215, 276, 'C'),
]


def main():
    ddb = boto3.resource('dynamodb', region_name=REGION)
    table = ddb.Table(TABLE_NAME)

    written = 0
    with table.batch_writer() as batch:
        for admission_year, program, branch, semester, min_roll, max_roll, section in RANGES:
            item = {
                'id': str(uuid.uuid4()),
                '__typename': 'RollRange',
                'admissionYear': admission_year,
                'program': program,
                'branch': branch,
                'semester': semester,
                'minRoll': min_roll,
                'maxRoll': max_roll,
                'section': section,
                'createdAt': '2026-09-18T00:00:00.000Z',
                'updatedAt': '2026-09-18T00:00:00.000Z',
            }
            batch.put_item(Item=item)
            written += 1

    print(f'Wrote {written} RollRange rows to {TABLE_NAME}')


if __name__ == '__main__':
    main()
