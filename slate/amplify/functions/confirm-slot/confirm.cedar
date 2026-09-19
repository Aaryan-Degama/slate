// Who may confirm a proposed slot (CLAUDE.md §3).
//
// Confirming writes ScheduleChange rows that show up on every affected
// section's timetable, so it is limited to faculty (and admins) -- and
// only for a request they raised themselves.
permit (
  principal,
  action == Slate::Action::"Confirm",
  resource is Slate::SlotRequest
)
when {
  (principal.role == "FACULTY" || principal.role == "ADMIN") &&
  resource.requester == principal
};

// Who may cancel a regular class: the faculty member it belongs to (the
// name they linked their login to matches the class's faculty), or an
// admin.
permit (
  principal,
  action == Slate::Action::"Cancel",
  resource is Slate::TimetableSlot
)
when {
  principal.role == "ADMIN" ||
  (principal.role == "FACULTY" && principal.facultyName == resource.faculty)
};
