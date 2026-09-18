// Full course names, from the real course-legend tables read during
// ingestion (see scripts/ingest-timetable.py and ingest-timetable-5th.py)
// -- TimetableSlot only stores the short code, so this is a static
// reference lookup for display purposes, not persisted data.
export const COURSE_NAMES: Record<string, string> = {
  // BTech3rdSem
  TOC: 'Theory of Computation',
  OS: 'Operating System',
  OOM: 'Object Oriented Methodologies',
  SE: 'Software Engineering',
  PS: 'Probability and Statistics',
  FinTech: 'Foundations of FinTech',

  // BTech5thSem
  CS: 'Cyber Security',
  IML: 'Introduction to Machine Learning',
  IVP: 'Image and Video Processing',
  AI: 'Artificial Intelligence',
  DTI: 'Design Thinking and Innovation',
  BPM: 'Business Process Management (IT-BI)',
}

export function courseFullName(courseId: string): string | undefined {
  return COURSE_NAMES[courseId]
}
