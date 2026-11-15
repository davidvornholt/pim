---
name: pim-calendar
description: Read the user's calendars and events over CalDAV or in Outlook, create, change, or delete events in either, add Teams meetings, invite people to meetings, and put invitations the user received into the calendar or answer them, with the pim command. Use when the user asks about their schedule, appointments, or free time, wants an event or Teams meeting added, moved, or removed, wants people invited, wants an invitation, update, or cancellation they received in their calendar, or wants an invitation accepted or declined.
---

# pim calendar

Run `pim calendar --help` for the calendar commands and `pim <command> --help` for options. Output is JSON on stdout. Errors are JSON on stderr and exit 1, or 2 for invalid arguments.

- `pim calendar events` takes local dates. To answer "am I free on Friday?", pass that date as both `--from` and `--to`.
- A recurring event appears once per occurrence, each with a `recurrenceId`. `pim calendar get` describes the whole series of a CalDAV event, and the occurrence of an Outlook event together with its series' rule.
- Keep each event's `account` and `href`; `pim calendar get` needs them.
- Read `failures` before saying a day is free: a calendar that failed may hold events.
- Outlook calendars and events have ids without slashes as `href`. An Outlook `href` from `pim calendar events` names one occurrence of a recurring event, and `pim calendar get` shows the series as `seriesHref`.
- A Teams meeting is an Outlook event with a join link. Pass `--teams` only when the user asked for a Teams meeting: only calendars of Microsoft 365 work or school accounts offer one, and pim cannot remove it again.
- Create, change, or delete an event only when the user asked for it. Others may see a shared calendar, so before creating an event, ask which calendar from `pim calendar list` to use if the user did not name one.
- Before `pim calendar update` or `pim calendar delete`, run `pim calendar get` and pass its `etag` exactly, quotes included. If the command reports a conflict, the event changed: get it again and check the change still makes sense.
- Pass `--series` only when the user wants every occurrence of a recurring event renamed, edited, deleted, or answered.
- When you recreate an event, for example to move it to another calendar, pass each reminder's `when` from `pim calendar get` as `--reminder` to `create`, or the reminders are lost.
- `--notify-attendees` lets the calendar server email invitations, updates, or cancellations. Pass it only when the user asked to invite, update, or cancel, and after confirming the exact attendee addresses with them, including those an occurrence lists under `recurrence.changed`. Without it, `create`, `update`, and `delete` refuse any write that would email someone.
- After a write with `--notify-attendees`, check each attendee's `scheduleStatus` ([RFC 6638, section 3.2.9](https://www.rfc-editor.org/rfc/rfc6638.html#section-3.2.9)): 1.0 means pending, 1.1 sent, 1.2 delivered; 3.x and 5.x mean the server did not send it. Without a status, delivery is unknown, as some servers report none for a new event; do not repeat the write.
- An invitation the user received is an email with a `text/calendar` attachment; `pim mail search` finds it. `pim calendar invitation`, `import`, and `respond` take the hit's account, folder, uid, and uidValidity (`--uid-validity`). `pim calendar invitation` shows the meeting and the user's answer in their calendars. `pim calendar import` puts an invitation, update, or cancellation into the calendar without answering it. Run `pim calendar respond` only when the user asked to accept, tentatively accept, or decline it, and pass `--notify-organizer` only then; it lets the calendar server email the answer to the organizer. If it prints `"reply": "draft"`, tell the user the answer is a draft they send themselves. If it prints `"reply": "server"`, check `event.organizer.scheduleStatus` as above.
- Outlook puts the invitations of a mailbox Microsoft hosts into the calendar itself. Answer such a meeting with `pim calendar respond --account <email> --href <href> --partstat <accepted|tentative|declined>`; without `--notify-organizer`, it prints `"reply": "none"` and nobody gets an email.
- If an account has no working calendar login, ask the user to run `pim login --account <email> --only dav`, or `--only graph` for Outlook calendars.
