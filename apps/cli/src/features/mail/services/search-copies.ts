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

// Keeps one hit per key, dropping its copies from other locations, such as
// other folders. Hits from one location are distinct messages even when their
// keys match, and nothing tells which of them a copy elsewhere copies, so a key
// that occurs twice in one location keeps all its hits. An empty key never
// matches.
export const withoutCopies = <Hit>(
  hits: ReadonlyArray<Hit>,
  keyOf: (hit: Hit) => string,
  locationOf: (hit: Hit) => string,
): ReadonlyArray<Hit> => {
  const seenPerLocation = new Set<string>();
  const ambiguousKeys = new Set<string>();
  for (const hit of hits) {
    const key = keyOf(hit);
    const locationKey = JSON.stringify([key, locationOf(hit)]);
    if (seenPerLocation.has(locationKey)) {
      ambiguousKeys.add(key);
    }
    seenPerLocation.add(locationKey);
  }
  const keptKeys = new Set<string>();
  return hits.filter((hit) => {
    const key = keyOf(hit);
    if (key === '' || ambiguousKeys.has(key)) {
      return true;
    }
    if (keptKeys.has(key)) {
      return false;
    }
    keptKeys.add(key);
    return true;
  });
};
