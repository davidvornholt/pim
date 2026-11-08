import { describe, expect, it } from 'bun:test';
import {
  berlin,
  vcalendarOf,
  vevent,
  weeklySeries,
  windowOf,
} from './ical.fixture';
import { type Occurrence, occurrencesIn } from './occurrences';

const october = windowOf('2026-10-01T00:00:00Z', '2026-11-30T00:00:00Z');

const starts = (occurrences: ReadonlyArray<Occurrence>) =>
  occurrences
    .map(({ startMs }) => new Date(startMs).toISOString())
    .sort((left, right) => left.localeCompare(right));

const override = (...lines: ReadonlyArray<string>) =>
  vevent('UID:series@example.com', 'DTSTAMP:20261001T000000Z', ...lines);

describe('occurrencesIn for a series', () => {
  it('keeps a series at its local time across a DST change', () => {
    const found = occurrencesIn(vcalendarOf(...weeklySeries), october, berlin);
    expect(starts(found)).toEqual([
      '2026-10-20T08:00:00.000Z',
      '2026-10-27T09:00:00.000Z',
      '2026-11-03T09:00:00.000Z',
    ]);
    expect(found.map(({ endMs, startMs }) => endMs - startMs)).toEqual([
      3_600_000, 3_600_000, 3_600_000,
    ]);
    // A UTC UNTIL on the last occurrence includes it, although the data
    // doesn't embed the Berlin VTIMEZONE.
    const until = weeklySeries.map((line) =>
      line.startsWith('RRULE:')
        ? 'RRULE:FREQ=WEEKLY;UNTIL=20261103T090000Z'
        : line,
    );
    expect(
      starts(occurrencesIn(vcalendarOf(...until), october, berlin)),
    ).toEqual(starts(found));
  });

  it('keeps the exact length of a DTEND across a DST change', () => {
    const found = occurrencesIn(
      vcalendarOf(
        ...vevent(
          'UID:night@example.com',
          'DTSTAMP:20260301T000000Z',
          'DTSTART;TZID=Europe/Berlin:20260329T013000',
          'DTEND;TZID=Europe/Berlin:20260329T043000',
          'RRULE:FREQ=DAILY;COUNT=2',
        ),
      ),
      windowOf('2026-03-29T02:00:00Z', '2026-03-30T00:00:00Z'),
      berlin,
    );
    expect(
      found.map(({ startMs, endMs }) =>
        [startMs, endMs].map((ms) => new Date(ms).toISOString()),
      ),
    ).toEqual([
      ['2026-03-29T00:30:00.000Z', '2026-03-29T02:30:00.000Z'],
      ['2026-03-29T23:30:00.000Z', '2026-03-30T01:30:00.000Z'],
    ]);
  });

  it('leaves out excluded occurrences', () => {
    const series = [
      ...weeklySeries.slice(0, -1),
      'EXDATE;TZID=Europe/Berlin:20261027T100000',
      'END:VEVENT',
    ];
    expect(
      starts(occurrencesIn(vcalendarOf(...series), october, berlin)),
    ).toEqual(['2026-10-20T08:00:00.000Z', '2026-11-03T09:00:00.000Z']);
  });

  it('starts a series of dates at DTSTART and ends a period on its own', () => {
    const found = occurrencesIn(
      vcalendarOf(
        ...vevent(
          'UID:dates@example.com',
          'DTSTAMP:20261001T000000Z',
          'DTSTART:20261026T090000Z',
          'DURATION:PT1H',
          'RDATE;VALUE=PERIOD:20261027T090000Z/20261027T120000Z',
        ),
      ),
      october,
      berlin,
    );
    expect(
      found.map(({ startMs, endMs }) =>
        [startMs, endMs].map((ms) => new Date(ms).toISOString()),
      ),
    ).toEqual([
      ['2026-10-26T09:00:00.000Z', '2026-10-26T10:00:00.000Z'],
      ['2026-10-27T09:00:00.000Z', '2026-10-27T12:00:00.000Z'],
    ]);
  });
  it('places an RDATE in the zone it is written in, not the zone of DTSTART', () => {
    const series = vcalendarOf(
      ...vevent(
        'UID:zoned-dates@example.com',
        'DTSTAMP:20261001T000000Z',
        'DTSTART;TZID=Europe/Berlin:20261020T100000',
        'DURATION:PT1H',
        'RDATE;TZID=America/New_York:20261027T100000',
      ),
    );
    const spans = (window: typeof october) =>
      occurrencesIn(series, window, berlin).map(({ startMs, endMs }) =>
        [startMs, endMs].map((ms) => new Date(ms).toISOString()),
      );

    expect(spans(october)).toEqual([
      ['2026-10-20T08:00:00.000Z', '2026-10-20T09:00:00.000Z'],
      ['2026-10-27T14:00:00.000Z', '2026-10-27T15:00:00.000Z'],
    ]);
    expect(
      spans(windowOf('2026-10-27T13:00:00Z', '2026-10-27T16:00:00Z')),
    ).toEqual([['2026-10-27T14:00:00.000Z', '2026-10-27T15:00:00.000Z']]);
  });
});

describe('occurrencesIn for a series with overrides', () => {
  it('takes a changed occurrence from its override', () => {
    const found = occurrencesIn(
      vcalendarOf(
        ...weeklySeries,
        ...override(
          'RECURRENCE-ID;TZID=Europe/Berlin:20261027T100000',
          'DTSTART;TZID=Europe/Berlin:20261027T150000',
          'DTEND;TZID=Europe/Berlin:20261027T160000',
          'SUMMARY:Moved sync',
        ),
      ),
      october,
      berlin,
    );
    const moved = found.find(
      ({ startMs }) => startMs === Date.parse('2026-10-27T14:00:00Z'),
    );
    expect(found).toHaveLength(3);
    expect(moved?.event.summary).toBe('Moved sync');
    expect(moved?.recurrenceId?.ms).toBe(Date.parse('2026-10-27T09:00:00Z'));
  });

  it('finds an occurrence moved into the window from after it', () => {
    const found = occurrencesIn(
      vcalendarOf(
        ...weeklySeries,
        ...override(
          'RECURRENCE-ID;TZID=Europe/Berlin:20261103T100000',
          'DTSTART;TZID=Europe/Berlin:20261022T100000',
          'DTEND;TZID=Europe/Berlin:20261022T110000',
        ),
        ...override(
          'RECURRENCE-ID;TZID=Europe/Berlin:20261020T100000',
          'DTSTART;TZID=Europe/Berlin:20261110T100000',
          'DTEND;TZID=Europe/Berlin:20261110T110000',
        ),
      ),
      windowOf('2026-10-19T00:00:00Z', '2026-10-26T00:00:00Z'),
      berlin,
    );
    expect(starts(found)).toEqual(['2026-10-22T08:00:00.000Z']);
    // An override with RANGE=THISANDFUTURE moves the later occurrences too,
    // here the one of October 29 to October 27.
    const daily = vcalendarOf(
      ...vevent(
        'UID:series@example.com',
        'DTSTAMP:20261001T000000Z',
        'DTSTART:20261026T100000Z',
        'DTEND:20261026T110000Z',
        'RRULE:FREQ=DAILY;COUNT=5',
      ),
      ...override(
        'RECURRENCE-ID;RANGE=THISANDFUTURE:20261028T100000Z',
        'DTSTART:20261026T140000Z',
        'DTEND:20261026T150000Z',
      ),
    );
    expect(
      starts(
        occurrencesIn(
          daily,
          windowOf('2026-10-27T00:00:00Z', '2026-10-28T00:00:00Z'),
          berlin,
        ),
      ),
    ).toEqual(['2026-10-27T10:00:00.000Z', '2026-10-27T14:00:00.000Z']);
  });
});

describe('occurrencesIn for a series it cannot expand', () => {
  it('throws rather than stop a series too long to expand', () => {
    const minutely = vcalendarOf(
      ...vevent(
        'UID:minutely@example.com',
        'DTSTAMP:20261001T000000Z',
        'DTSTART:20261001T000000Z',
        'RRULE:FREQ=MINUTELY',
      ),
    );
    expect(() =>
      occurrencesIn(
        minutely,
        windowOf('2026-11-06T00:00:00Z', '2026-11-07T00:00:00Z'),
        berlin,
      ),
    ).toThrow('minutely@example.com');
  });

  it('throws for a rule that matches no date', () => {
    const never = vcalendarOf(
      ...vevent(
        'UID:never@example.com',
        'DTSTAMP:20261001T000000Z',
        'DTSTART:20260101T100000Z',
        'RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30',
      ),
    );
    expect(() => occurrencesIn(never, october, berlin)).toThrow(
      'never@example.com',
    );
  });
});

describe('occurrencesIn for single events', () => {
  it('lists an invitation to a single occurrence without its series', () => {
    const found = occurrencesIn(
      vcalendarOf(
        ...override(
          'RECURRENCE-ID;TZID=Europe/Berlin:20261027T100000',
          'DTSTART;TZID=Europe/Berlin:20261027T100000',
          'DTEND;TZID=Europe/Berlin:20261027T110000',
        ),
      ),
      october,
      berlin,
    );
    expect(starts(found)).toEqual(['2026-10-27T09:00:00.000Z']);
    expect(found[0]?.recurrenceId?.ms).toBe(found[0]?.startMs);
  });

  it('gives a date-only event without an end one local day', () => {
    const vcalendar = vcalendarOf(
      ...vevent(
        'UID:day@example.com',
        'DTSTAMP:20261001T000000Z',
        'SUMMARY:Holiday',
        'DTSTART;VALUE=DATE:20261027',
      ),
    );
    expect(
      occurrencesIn(
        vcalendar,
        windowOf('2026-10-27T22:00:00Z', '2026-10-28T23:00:00Z'),
        berlin,
      ),
    ).toHaveLength(1);
    expect(
      occurrencesIn(
        vcalendar,
        windowOf('2026-10-27T23:00:00Z', '2026-10-28T23:00:00Z'),
        berlin,
      ),
    ).toHaveLength(0);
  });

  it('counts an event without duration that starts in the window', () => {
    const vcalendar = vcalendarOf(
      ...vevent(
        'UID:reminder@example.com',
        'DTSTAMP:20261001T000000Z',
        'DTSTART:20261027T090000Z',
      ),
    );
    expect(
      occurrencesIn(
        vcalendar,
        windowOf('2026-10-27T09:00:00Z', '2026-10-27T10:00:00Z'),
        berlin,
      ),
    ).toHaveLength(1);
    expect(
      occurrencesIn(
        vcalendar,
        windowOf('2026-10-27T08:00:00Z', '2026-10-27T09:00:00Z'),
        berlin,
      ),
    ).toHaveLength(0);
  });
});
