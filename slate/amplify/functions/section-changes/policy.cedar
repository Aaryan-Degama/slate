// Who may change a timetable (see CLAUDE.md §2 and docs/PLAN.md).
//
// Every section has at most one class representative (CR), claimed by a
// student of that section. A CR records changes (cancel, extra class, move)
// for a *course*, and each change applies to every section of the batch
// that takes the course. Every change records who made it.
//
// principal.section is resolved by the server from the student's verified
// email (roll number), and resource.crs from the timetable and the CR list;
// nothing here comes from the request itself.

// Claim: your own section, and only while it has no CR.
permit (
  principal,
  action == Slate::Action::"ClaimCr",
  resource is Slate::Section
)
when { principal.section == resource.key && !resource.hasCr };

// Cancel / add / move a class of an offering (one course, one professor,
// one audience): a CR of a section that offering is taught to.
permit (
  principal,
  action in [Slate::Action::"Cancel", Slate::Action::"AddExtra", Slate::Action::"Move"],
  resource is Slate::Offering
)
when { resource.crs.contains(principal) };

// Undo a whole change: whoever made it.
permit (
  principal,
  action == Slate::Action::"UndoGroup",
  resource is Slate::Change
)
when { resource.maker == principal };

// Undo a change for one section only: that section's CR (e.g. another
// section's CR added a class this section can't attend).
permit (
  principal,
  action == Slate::Action::"UndoSection",
  resource is Slate::Section
)
when { resource.hasCr && resource.cr == principal };

// Admins can do all of it (fix mistakes, step in after revoking a CR).
permit (principal, action, resource)
when { principal.role == "ADMIN" };
