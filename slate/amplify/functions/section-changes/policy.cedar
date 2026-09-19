// Who may change a section's timetable (CLAUDE.md §2, revised Day 3).
//
// Every section has at most one class representative (CR). A student
// claims the role for their own section; after that, only that CR can
// add a class to, cancel a class in, or undo a change on that section's
// timetable. Every change is stamped with who made it.
//
// principal.section is resolved by the server from the student's roll
// number (their email), never taken from the request, so nobody can act
// on a section they aren't in.

// Claim: your own section, and only while it has no CR.
permit (
  principal,
  action == Slate::Action::"ClaimCr",
  resource is Slate::Section
)
when { principal.section == resource.key && !resource.hasCr };

// Add / cancel / undo: only the section's current CR.
permit (
  principal,
  action in [Slate::Action::"AddClass", Slate::Action::"CancelClass", Slate::Action::"UndoChange"],
  resource is Slate::Section
)
when { resource.hasCr && resource.cr == principal };

// Admins can do all of it (e.g. fix a mistake, or step in when a CR is revoked).
permit (principal, action, resource)
when { principal.role == "ADMIN" };
