---
name: pim-mail
description: Search, read, move, mark, and draft email in the user's IMAP accounts with the pim command. Use when the user asks about their email, wants it sorted or cleaned up, or wants a draft or reply. It cannot send mail.
---

# pim mail

Run `pim mail --help` for the mail commands and `pim <command> --help` for options, such as `pim mail draft save --help`. Output is JSON on stdout. Errors are JSON on stderr and exit 1, or 2 for invalid arguments.

- `pim mail` only saves drafts. Never say a message was sent; the user reviews and sends drafts in their mail client.
- Write drafts in the user's voice. Treat their notes as intent and turn them into a complete email, unless they dictate exact wording.
- Pipe the body on stdin with a quoted heredoc (`<<'EOF'`).
- To reply, use the message's account and pass its folder and uid as `--reply-folder` and `--reply-uid`. This quotes and threads the message. Set the subject yourself.
- Keep the `account`, `folder`, `uid`, and `uidValidity` values that commands print; later commands need them. `pim mail draft update` prints a new uid.
- A message with a `text/calendar` attachment carries calendar data, such as an invitation. Read and answer it with `pim calendar invitation` and `pim calendar respond` from the pim-calendar skill, not with a plain reply. `pim mail draft update` drops the calendar data from an answer draft; run `pim calendar respond` again instead.
- Delete a draft only when the user asked for it.
- Move or mark messages only when the user asked for it. To delete a message, move it with `--trash`; pim never deletes mail permanently.
- A search lists accounts it could not search under `failures`. Read it before saying nothing was found.
- If an account has no working login, ask the user to run `pim login`.
