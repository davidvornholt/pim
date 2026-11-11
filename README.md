# pim

> Built on [davidvornholt/standards](https://github.com/davidvornholt/standards).

`pim` is a command-line tool for AI agents to work with a person's information. Its `mail` commands search, read, move, mark, and draft email in IMAP accounts. It works with any IMAP server that accepts a password or app password, and with Outlook.com and Microsoft 365 accounts through Microsoft sign-in. They never send mail: drafts go to the account's drafts folder, where you review and send them from your mail client. They also read and replace the account's server-side mail filters, Sieve scripts that file incoming mail, over ManageSieve on port 4190 of the IMAP host with the mail password. Its `calendar` commands read calendars over CalDAV and Outlook calendars through Microsoft Graph, create, change, and delete events in both, and add Teams meetings in Microsoft 365 calendars. They invite attendees, and change or cancel meetings the user organizes, only with `--notify-attendees`; the calendar server then emails the attendees, and pim refuses servers that do not. They answer invitations: in Outlook and through a calendar server that sends the answer itself, they email the organizer only with `--notify-organizer`; otherwise pim saves the answer as a reply draft. Its `contacts` commands read address books over CardDAV and create, change, and delete contacts.

## Install

pim builds from source with [Bun](https://bun.sh) on Linux, macOS, and Windows. In a clone of this repository, run:

```bash
bun install
bun run --filter @pim/cli install:user
```

`just install` does the same where [`just`](https://just.systems) is installed. This builds a standalone binary to `~/.local/bin/pim` (`pim.exe` on Windows) and installs the agent skills from [`apps/cli/skills`](apps/cli/skills) to `~/.agents/skills`, where Codex and Claude Code find them. `~` is your home folder, `%USERPROFILE%` on Windows. Run it again after pulling changes. The installer tells you when `~/.local/bin` is not on your PATH; on Windows it usually is not, so add `%USERPROFILE%\.local\bin` to your user PATH.

## Configure

Copy [`apps/cli/accounts.example.toml`](apps/cli/accounts.example.toml) to `~/.config/pim/accounts.toml` (or set `PIM_CONFIG`). It has one `[accounts."<email>"]` table per account with a `name` and at least one service: `mail` for IMAP, `dav` for calendars and contacts, and `graph` for Outlook calendars. Unknown keys are rejected, and `pim accounts` prints each account with its defaults filled in. Then log in to each account and check that it works:

```bash
pim login
pim status
```

`pim login` checks each login against the server before storing it in the keyring service `pim` under `mail:<email>`, the calendar and contacts login under `dav:<email>`, and the Microsoft sign-in for Outlook calendars under `graph:<email>`. On Linux this needs a running Secret Service provider such as gnome-keyring.

### Drafting guide

Notes on how agents should write your drafts, such as your sign-off or when to address someone formally, go in `drafting.md` in the same folder as `accounts.toml`. The file is optional and free text. `pim mail draft guide` prints it, and the pim-mail skill has agents read it before they write a draft.

### Calendars and contacts

An account gets calendars and contacts from a `dav` table with the server's DAV root URL, such as `dav = { url = "https://sync.infomaniak.com/" }` for Infomaniak. pim finds the calendars and address books from there. `user` defaults to the mail user; some providers, Infomaniak among them, use a separate DAV username and app password. `pim login --account <email> --only dav` logs in to calendars and contacts alone.

### Outlook and Microsoft 365

Microsoft does not accept passwords over IMAP, so these accounts need `mail = { host = "outlook.office365.com", auth = "microsoft" }`. `pim login` then shows a code to enter at Microsoft's sign-in page in any browser and stores the resulting refresh token instead of a password. Each command trades it for a short-lived access token, and a sign-in lasts until Microsoft revokes it or it goes 90 days unused.

For mail, pim uses Mozilla Thunderbird's public app ID, so Microsoft's consent screen asks you to allow Thunderbird. Work or school tenants can block IMAP, device code sign-in, or apps that an administrator has not approved; in that case, ask the administrator.

### Outlook calendars

A `graph` table, such as `graph = {}`, gives an account its Outlook calendars through Microsoft Graph, including calendars others shared with the user.

For Outlook calendars, pim uses its own app ID and asks for read and write access to the user's calendars and those shared with them. `pim login` shows a link for it instead of a code. Open the link in a browser on the same computer, because Microsoft returns the sign-in to pim through a local address. Work or school tenants that do not let users consent to apps from unverified publishers need an administrator to consent to pim once. Alternatively, register an app in the tenant and set its application ID as `client-id` in the account's `graph` table. pim signs in through Microsoft's `common` endpoint, so the app must support accounts in any organizational directory, plus personal Microsoft accounts for Outlook.com; it must also have the mobile and desktop redirect URI `http://localhost` and the delegated Microsoft Graph permissions `Calendars.ReadWrite` and `Calendars.ReadWrite.Shared`.

## Use

Run `pim --help` for the commands, `pim mail --help`, `pim calendar --help`, or `pim contacts --help` for a group, and `pim <command> --help` for their options. The skills in [`apps/cli/skills`](apps/cli/skills) tell agents how to use each group.

## Develop

`bun run check` runs the standards drift check, lint, type checks, tests, and the build. It must pass before a change is done. Run the command from source with `bun apps/cli/src/app/cli.ts`.

## License

[MIT](LICENSE) © David Vornholt
