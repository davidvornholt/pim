export type FolderInfo = {
  readonly path: string;
  readonly name: string;
  readonly specialUse: string | null;
  readonly subscribed: boolean;
};

export const searchScopes = ['all', 'folder', 'subtree'] as const;

export type SearchScope = (typeof searchScopes)[number];

type SearchCriteria = {
  readonly limit: number;
  readonly query?: string;
  readonly from?: string;
  readonly subject?: string;
  readonly since?: string;
};

export type SearchLocation =
  | { readonly scope: 'all' }
  | { readonly scope: 'folder' | 'subtree'; readonly folder: string };

export type SearchOptions = SearchCriteria & SearchLocation;

export type SearchOptionsInput = SearchCriteria & {
  readonly scope?: SearchScope;
  readonly folder?: string;
};

export type SearchHit = {
  readonly account: string;
  readonly uid: number;
  readonly uidValidity: string;
  readonly folder: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly date: string;
};

export type SearchFailure = {
  readonly account: string;
  readonly errorTag: string;
  readonly message: string;
};

export type SearchResult = {
  readonly hits: ReadonlyArray<SearchHit>;
  readonly failures: ReadonlyArray<SearchFailure>;
};

export type FullMessage = {
  readonly uid: number;
  readonly folder: string;
  readonly from: string;
  readonly to: string;
  readonly cc: string;
  readonly bcc: string;
  readonly subject: string;
  readonly date: string;
  readonly attributionDate: string;
  readonly messageId: string;
  readonly inReplyTo: string;
  readonly references: ReadonlyArray<string>;
  readonly text: string;
  readonly html: string | null;
  readonly attachments: ReadonlyArray<MessageAttachment>;
};

export type MessageThread = Pick<
  FullMessage,
  'messageId' | 'inReplyTo' | 'references'
>;

// The iCalendar data a message carries, as an invitation does (RFC 6047).
export type CalendarMessage = MessageThread & {
  readonly account: string;
  readonly folder: string;
  readonly uid: number;
  readonly from: string;
  readonly subject: string;
  // The iTIP method of its text/calendar part, such as REQUEST.
  readonly method?: string;
  readonly ics: string;
};

export type MessageAttachment = {
  readonly part: string;
  readonly filename: string | null;
  readonly contentType: string;
  readonly size: number | null;
  readonly disposition: string | null;
  readonly contentId: string | null;
};

export type AttachmentContent = MessageAttachment & {
  readonly content: Uint8Array;
};

export type MessageHandle = {
  readonly folder: string;
  readonly uid: number;
};

export type DraftInput = {
  readonly account: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  // Local file paths; each attachment is named after its file.
  readonly attachments?: ReadonlyArray<string>;
  readonly cc?: string;
  readonly bcc?: string;
  // Quotes this message and derives In-Reply-To and References from it.
  readonly replySource?: MessageHandle;
};

export type DraftLocation = {
  readonly folder: string;
  readonly uid: number | null;
  // UIDVALIDITY of the folder when the uid was minted, serialized (it is a
  // bigint). Null when the server lacks UIDPLUS.
  readonly uidValidity: string | null;
};

// An answer to an invitation: a short note with the iTIP REPLY (RFC 5546)
// the organizer's calendar reads. It threads on the invitation without
// quoting it.
export type CalendarReplyDraft = {
  readonly account: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly ics: string;
  readonly repliedTo: MessageThread;
};

// Identifies an existing draft. uidValidity guards against a mailbox reindex
// reassigning the uid to a different message.
export type DraftHandle = {
  readonly account: string;
  readonly folder: string;
  readonly uid: number;
  readonly uidValidity: string;
};

export type UpdateDraftInput = DraftInput & DraftHandle;

export type TagDraftsInput = {
  readonly account: string;
  readonly folder: string;
  readonly uidValidity: string;
  readonly uids: ReadonlyArray<number>;
  readonly keyword: string;
};

export type TagDraftsResult = {
  readonly account: string;
  readonly folder: string;
  readonly uidValidity: string;
  readonly uids: ReadonlyArray<number>;
  readonly keyword: string;
};

// A server-side mail filter. The server runs at most one active script on
// incoming mail.
export type SieveScript = {
  readonly name: string;
  readonly active: boolean;
};

// warnings holds what the server reported about a script it accepted.
export type SavedSieveScript = SieveScript & {
  readonly warnings: string | null;
};

export const defaultSearchLimit = 20;
