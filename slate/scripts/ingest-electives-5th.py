"""
INTENTIONALLY DISABLED (writes nothing) -- see ingest-electives.py for
the full reasoning. Same reversal applies here: HI, MDM-3, and CE have
no section named in the source cell, so they're not attached to any
section rather than broadcast-applied to A/B/C.
"""


def main():
    print('Disabled: elective/common-period rows are no longer attached to any '
          'section. See ingest-electives.py for why. Nothing written.')


if __name__ == '__main__':
    main()
