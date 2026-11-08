---
name: pim-mail
description: Search, read, move, mark, and draft email and manage server-side mail filters (Sieve) in the user's IMAP accounts with the pim command. Use when the user asks about their email, wants it sorted or cleaned up, wants incoming mail filed automatically, or wants a draft or reply. It cannot send mail.
---

# pim mail

Run `pim mail --help` for the mail commands and `pim <command> --help` for options, such as `pim mail draft save --help`. Output is JSON on stdout. Errors are JSON on stderr and exit 1, or 2 for invalid arguments.

- When the user asks to send a message, save it as a draft.
- Write drafts in the user's voice. Unless the user dictates exact wording, their message is a brief, not a draft: it mixes what the recipient should learn with background and wishes meant for you, such as how the email should come across. Decide what the recipient needs and in which order, and write it in your own sentences, not the user's. Convey wishes about how the email should come across through its content and tone instead of stating them.
- Pipe the body on stdin with a quoted heredoc (`<<'EOF'`).
- To reply, use the message's account and pass its folder and uid as `--reply-folder` and `--reply-uid`. This quotes and threads the message. Set the subject yourself.
- Keep the `account`, `folder`, `uid`, and `uidValidity` values that commands print; later commands need them. `pim mail draft update` prints a new uid.
- A message with a `text/calendar` attachment carries calendar data, such as an invitation. Read and answer it with `pim calendar invitation` and `pim calendar respond` from the pim-calendar skill, not with a plain reply. `pim mail draft update` drops the calendar data from an answer draft; run `pim calendar respond` again instead.
- Delete a draft only when the user asked for it.
- Move or mark messages only when the user asked for it. To delete a message, move it with `--trash`.
- Change Sieve filters only when the user asked for it. `pim mail sieve put` replaces the whole script, so start from `pim mail sieve get` of the active script, keep its other rules, and pipe the result back. Filters act only on mail that arrives later.
- A search lists accounts it could not search under `failures`. Read it before saying nothing was found.
- If an account has no working login, ask the user to run `pim login`.
