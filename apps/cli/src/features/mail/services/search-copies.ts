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

// Drops hits whose key matches a hit already kept from another location, such
// as another folder. Hits from one location are distinct messages, so they
// stay even when their keys match. An empty key never matches.
export const withoutCopies = <Hit>(
  hits: ReadonlyArray<Hit>,
  keyOf: (hit: Hit) => string,
  locationOf: (hit: Hit) => string,
): ReadonlyArray<Hit> => {
  const firstLocations = new Map<string, string>();
  return hits.filter((hit) => {
    const key = keyOf(hit);
    if (key === '') {
      return true;
    }
    const location = locationOf(hit);
    const firstLocation = firstLocations.get(key);
    if (firstLocation === undefined) {
      firstLocations.set(key, location);
      return true;
    }
    return firstLocation === location;
  });
};
