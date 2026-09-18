"""
Real Bedrock ingestion step (CLAUDE.md §3): takes the raw cell+merge
structure dump (dump-sheet-structure.py) for one timetable sheet and
asks Claude, via Bedrock, to normalize it into a flat schema -- one row
per real class session, with merge ranges correctly resolved into real
durations. Replaces the hand-written regex extraction, which repeatedly
missed merged cells because it only checked merge state for cells that
already looked unusual, not systematically.

Output: a JSON list of class sessions, printed to stdout. Meant to be
spot-checked against a real, known schedule before being loaded into
DynamoDB (see load-normalized-timetable.py).
"""
import json
import sys
import boto3

REGION = 'ap-south-1'
MODEL_ID = 'apac.anthropic.claude-3-5-sonnet-20241022-v2:0'

SYSTEM_PROMPT = """You are normalizing a real university timetable spreadsheet into structured data.

You will be given:
1. A raw dump of every non-empty cell in a timetable grid sheet: its coordinate, row, column, column letter, text value, and merge range (if the cell is merged with others).
2. The time-slot header row content (which column/row holds which time label).
3. A course legend mapping short course codes to full names, credit structure (L-T-P-S), and faculty.

Your job: produce one JSON object per real class SESSION (a contiguous block of time on one day for one specific section/cohort and one course), with the CORRECT start and end time -- using the merge ranges to determine true duration. A cell merged across two time-slot columns (e.g. columns C and D, where C=09:00-10:00 and D=10:00-11:00) means that class runs the FULL 09:00-11:00, not just one hour. Do not guess durations from course type (L/P) alone -- only extend duration when the merge range or explicit multi-column span in the data actually supports it, OR when a cell's own text unambiguously spans multiple listed time labels.

Cell text follows patterns like:
- "IML (P) - Sec A (CC3-5404)" -- course code IML, session type P (practical) or L (lecture) or T (tutorial), one or more sections after "Sec", room in parens.
- "BPM (L) - IT-BI (LT-3112)" -- "IT-BI" here is a COHORT/PROGRAM qualifier, not a section. Treat it as its own audience, output section as "IT-BI" (do not apply it to regular section students).
- A cell may stack multiple sessions separated by newlines -- split into separate output entries.
- Cells with no "Sec X" or cohort label and no course-legend room-per-option breakdown (e.g. a basket like "MDM-3" followed by several course codes with rooms, no section) are elective/common baskets where every section takes ONE option -- output ONE entry per option listed, with section "ALL" (meaning: every section in scope attends something from this basket during this time, we don't know which specific option each individual student picked).
- "LUNCH" cells are not classes -- omit them.
- Ignore cells that are part of the course-legend table below the grid (columns/rows describing course code -> full name -> L-T-P-S -> faculty), except to use that legend as reference context.

Output STRICT JSON: a list of objects, each with exactly these fields:
{"day": "MON|TUE|WED|THU|FRI", "startTime": "HH:MM", "endTime": "HH:MM", "courseId": "...", "sessionType": "L|P|T|null", "section": "A|B|B1|B2|C|ALL|IT-BI|...", "room": "..." or null, "faculty": "..." or null}

Use faculty from the legend, matched by course code and section where the legend gives per-section faculty; null if not determinable. Output ONLY the JSON list, no explanation, no markdown code fences."""


def main():
    dump_path = sys.argv[1]
    legend_path = sys.argv[2] if len(sys.argv) > 2 else None

    with open(dump_path) as f:
        sheet_dump = f.read()

    legend_text = ''
    if legend_path:
        with open(legend_path) as f:
            legend_text = f.read()

    user_content = f"""Raw cell + merge dump:
{sheet_dump}

Course legend (code | L-T-P-S | full name | faculty):
{legend_text}

Produce the normalized JSON list of class sessions now."""

    client = boto3.client('bedrock-runtime', region_name=REGION)
    response = client.converse(
        modelId=MODEL_ID,
        system=[{'text': SYSTEM_PROMPT}],
        messages=[{'role': 'user', 'content': [{'text': user_content}]}],
        inferenceConfig={'maxTokens': 8192, 'temperature': 0},
    )

    output_text = response['output']['message']['content'][0]['text']
    print(output_text)


if __name__ == '__main__':
    main()
