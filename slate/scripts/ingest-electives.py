"""
INTENTIONALLY DISABLED (writes nothing) -- kept for the historical
record, not deleted, because the reasoning matters if this comes up
again.

This used to write elective/common-period busy blocks (MDM-1, HSMC)
to every section (A/B/C) in the cohort, on the theory that every
student is doing *something* from the basket at that time even though
we don't know which specific option. Reversed: per direct instruction,
if the source cell doesn't name a section, the entry doesn't get
attached to any section at all, rather than broadcast-applied to every
one. TimetableSlot has no "no section" representation and every query
in the app filters by section, so the correct action is to not write
these rows -- not to invent a section for them.

If real per-student elective registration data becomes available
(CourseRegistration), that's the correct place for this information,
tied to the actual students who take it -- not a blanket TimetableSlot
row.
"""


def main():
    print('Disabled: elective/common-period rows are no longer attached to any '
          'section. See the module docstring for why. Nothing written.')


if __name__ == '__main__':
    main()
