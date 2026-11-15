// Some senders reuse one Message-ID for different messages, so the ID alone
// doesn't prove two hits are copies of one message. A copy also keeps the
// sender's Date, subject, and From.
export const copyFingerprint = ({
  messageId,
  sentAt,
  subject,
  from,
}: {
  readonly messageId: string;
  readonly sentAt: string;
  readonly subject: string;
  readonly from: string;
}): string => {
  const id = messageId.trim();
  return id === '' ? '' : JSON.stringify([id, sentAt, subject, from]);
};

// Drops hits that are copies of hits from another location, such as another
// folder. Hits from one location are distinct messages even when their keys
// match, so each key keeps as many hits as the location that has the most of
// them, and a copy elsewhere stands in for one of those. An empty key never
// matches.
export const withoutCopies = <Hit>(
  hits: ReadonlyArray<Hit>,
  keyOf: (hit: Hit) => string,
  locationOf: (hit: Hit) => string,
): ReadonlyArray<Hit> => {
  const seenPerLocation = new Map<string, number>();
  const keptPerKey = new Map<string, number>();
  return hits.filter((hit) => {
    const key = keyOf(hit);
    if (key === '') {
      return true;
    }
    const locationKey = JSON.stringify([key, locationOf(hit)]);
    const seen = (seenPerLocation.get(locationKey) ?? 0) + 1;
    seenPerLocation.set(locationKey, seen);
    const kept = keptPerKey.get(key) ?? 0;
    if (seen <= kept) {
      return false;
    }
    keptPerKey.set(key, kept + 1);
    return true;
  });
};
