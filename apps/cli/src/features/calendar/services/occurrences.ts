import type { DateTime } from 'effect';
import ICAL from 'ical.js';
import {
  formatDate,
  instantOf,
  registerIanaZones,
  type TimeWindow,
} from './ical-time';

// One occurrence of an event: the event itself, or one instance of a
// recurring event, drawn from the override that changed it if there is one.
export type Occurrence = {
  readonly event: ICAL.Event;
  readonly start: ICAL.Time;
  readonly end: ICAL.Time;
  readonly startMs: number;
  readonly endMs: number;
  readonly recurrenceId?: { readonly time: ICAL.Time; readonly ms: number };
};

// Stops a rule without an end, such as FREQ=MINUTELY, from running forever.
// A series with more occurrences before the window ends can't be listed.
const maxRuleSteps = 50_000;

// ical.js 2.2.1 looks for a rule's next date in a loop inside
// RecurIterator.next() that gives up only for MONTHLY and YEARLY rules, so a
// rule that matches no date, such as FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30,
// never returns, and no timeout can stop synchronous code. The loop tests
// each candidate date with check_contracting_rules, so counting those calls
// per iterator bounds its work, including the first search that
// Event.iterator() already runs.
const maxCandidates = 200_000;
const candidatesTested = new WeakMap<ICAL.RecurIterator, number>();
const checkContractingRules =
  ICAL.RecurIterator.prototype.check_contracting_rules;
ICAL.RecurIterator.prototype.check_contracting_rules = function (
  this: ICAL.RecurIterator,
): boolean {
  const tested = (candidatesTested.get(this) ?? 0) + 1;
  if (tested > maxCandidates) {
    throw new Error(
      `its rule ${this.rule.toString()} needed more than ${maxCandidates} candidate dates, so it may match no date at all`,
    );
  }
  candidatesTested.set(this, tested);
  return checkContractingRules.call(this);
};

export const tzidOf = (
  component: ICAL.Component,
  property: string,
): string | undefined => {
  const value = component.getFirstProperty(property)?.getParameter('tzid');
  return typeof value === 'string' ? value : undefined;
};

// The zone a time is written in, else the given one. An RDATE may name
// another zone than DTSTART, and ical.js keeps that zone on the date.
const zoneOf = (
  time: ICAL.Time,
  fallback: string | undefined,
): string | undefined => {
  const tzid = time.zone?.tzid;
  return tzid === undefined || tzid === 'floating' ? fallback : tzid;
};

const uidOf = (component: ICAL.Component): string =>
  String(component.getFirstPropertyValue('uid') ?? '');

// A date-only event without an end lasts one day (RFC 5545, section 3.6.1).
const endOf = (start: ICAL.Time, end: ICAL.Time): ICAL.Time => {
  if (!start.isDate || end.compare(start) > 0) {
    return end;
  }
  const nextDay = start.clone();
  nextDay.adjust(1, 0, 0, 0);
  return nextDay;
};

const millisPerSecond = 1000;

// When an instance ends. A DTEND gives every instance the same exact length
// (RFC 5545, section 3.8.5.3). The weeks and days of a DURATION are
// nominal, so they move the date in the start's zone, but its hours,
// minutes, and seconds are exact time (section 3.3.6). Both matter across a
// DST change.
export const endMsOf = (
  event: ICAL.Event,
  { start, end, startMs }: Pick<Occurrence, 'start' | 'end' | 'startMs'>,
  local: DateTime.TimeZone,
): number => {
  const { component } = event;
  const startTzid = tzidOf(component, 'dtstart');
  const endTzid = tzidOf(component, 'dtend') ?? startTzid;
  if (!start.isDate && component.hasProperty('dtend')) {
    const length =
      instantOf(event.endDate, endTzid, local) -
      instantOf(event.startDate, startTzid, local);
    return Math.max(startMs, startMs + length);
  }
  const duration = component.getFirstPropertyValue('duration');
  if (start.isDate || !(duration instanceof ICAL.Duration)) {
    return Math.max(startMs, instantOf(end, zoneOf(end, endTzid), local));
  }
  const { weeks, days, hours, minutes, seconds, isNegative } = duration;
  const nominalEnd = start.clone();
  nominalEnd.addDuration(new ICAL.Duration({ weeks, days, isNegative }));
  const exact = new ICAL.Duration({ hours, minutes, seconds, isNegative });
  return Math.max(
    startMs,
    instantOf(nominalEnd, zoneOf(nominalEnd, startTzid), local) +
      exact.toSeconds() * millisPerSecond,
  );
};

// Where an instance of a series sits in its rule, before any override moved
// it, and the zone of that slot.
type Slot = {
  readonly time: ICAL.Time;
  readonly tzid: string | undefined;
};

// An event, or one instance of a series, with its times as written. An
// instance from a PERIOD RDATE has its own end, which the event's DURATION
// doesn't change.
type Instance = {
  readonly event: ICAL.Event;
  readonly start: ICAL.Time;
  readonly end: ICAL.Time;
  readonly slot?: Slot;
  readonly ownEnd?: boolean;
};

const occurrence = (
  { event, start, end, slot, ownEnd }: Instance,
  local: DateTime.TimeZone,
): Occurrence => {
  const startTzid = zoneOf(start, tzidOf(event.component, 'dtstart'));
  const startMs = instantOf(start, startTzid, local);
  const fullEnd = endOf(start, end);
  return {
    event,
    start,
    end: fullEnd,
    startMs,
    endMs:
      ownEnd === true
        ? Math.max(
            startMs,
            instantOf(fullEnd, zoneOf(fullEnd, startTzid), local),
          )
        : endMsOf(event, { start, end: fullEnd, startMs }, local),
    ...(slot === undefined
      ? {}
      : {
          recurrenceId: {
            time: slot.time,
            ms: instantOf(slot.time, slot.tzid, local),
          },
        }),
  };
};

// An event as stored, without expanding a rule.
const asStored = (event: ICAL.Event, slot?: Slot): Instance => ({
  event,
  start: event.startDate,
  end: event.endDate,
  ...(slot === undefined ? {} : { slot }),
});

// An event without duration still counts when it starts inside the window.
export const overlaps = (
  { startMs, endMs }: Pick<Occurrence, 'startMs' | 'endMs'>,
  window: TimeWindow,
): boolean =>
  startMs < window.endMs && Math.max(endMs, startMs + 1) > window.startMs;

const inWindow = (
  instance: Instance,
  window: TimeWindow,
  local: DateTime.TimeZone,
): ReadonlyArray<Occurrence> => {
  const found = occurrence(instance, local);
  return overlaps(found, window) ? [found] : [];
};

// The instance of a series at one of its dates, from the override that
// changed it if there is one. ical.js gives a PERIOD RDATE as a period.
const instanceAt = (
  event: ICAL.Event,
  date: ICAL.Time | ICAL.Period,
  ruleTzid: string | undefined,
): Instance => {
  const details = event.getOccurrenceDetails(
    date instanceof ICAL.Period ? date.start : date,
  );
  if (details.item !== event) {
    return {
      event: details.item,
      start: details.startDate,
      end: details.endDate,
      slot: {
        time: details.recurrenceId,
        tzid: tzidOf(details.item.component, 'recurrence-id') ?? ruleTzid,
      },
    };
  }
  const slot = {
    time: details.recurrenceId,
    tzid: zoneOf(details.recurrenceId, ruleTzid),
  };
  return date instanceof ICAL.Period
    ? { event, start: date.start, end: date.getEnd(), slot, ownEnd: true }
    : { event, start: details.startDate, end: details.endDate, slot };
};

// Whether an EXDATE removes the instance at `time`. As in ical.js, a
// date-only EXDATE removes the instances on its date.
const isExcluded = (component: ICAL.Component, time: ICAL.Time): boolean =>
  component
    .getAllProperties('exdate')
    .flatMap((property) => property.getValues())
    .some((excluded: ICAL.Time) =>
      excluded.isDate && !time.isDate
        ? formatDate(excluded) === formatDate(time)
        : excluded.compare(time) === 0,
    );

const millisPerDay = 86_400_000;

// How far the rule must run to find every occurrence that can fall in the
// window. An override with RANGE=THISANDFUTURE moves each later occurrence by
// as much as its own, so one moved back can pull occurrences from after the
// window into it. ical.js moves them by wall-clock time, so a DST change can
// add an hour or two to that; a day covers it. maxRuleSteps still bounds the
// work of a long move.
const horizonOf = (
  overrides: ReadonlyArray<ICAL.Component>,
  ruleTzid: string | undefined,
  window: TimeWindow,
  local: DateTime.TimeZone,
): number =>
  overrides.reduce((horizonMs, component) => {
    const moved = new ICAL.Event(component);
    if (!moved.modifiesFuture()) {
      return horizonMs;
    }
    const slotMs = instantOf(
      moved.recurrenceId,
      tzidOf(component, 'recurrence-id') ?? ruleTzid,
      local,
    );
    const startMs = instantOf(
      moved.startDate,
      tzidOf(component, 'dtstart'),
      local,
    );
    return Math.max(horizonMs, window.endMs + slotMs - startMs + millisPerDay);
  }, window.endMs);

// A window, and how far its series must run to find every occurrence in it.
type SeriesWindow = TimeWindow & { readonly horizonMs: number };

// The rule's occurrences until the horizon, with overrides applied.
const ruleOccurrences = (
  event: ICAL.Event,
  ruleTzid: string | undefined,
  window: SeriesWindow,
  local: DateTime.TimeZone,
): ReadonlyArray<Occurrence> => {
  // DTSTART is always the first instance (RFC 5545, section 3.8.5.2), but
  // ical.js leaves it out of a series of RDATEs without an RRULE.
  const { component, startDate } = event;
  const addsStart = !(
    component.hasProperty('rrule') || isExcluded(component, startDate)
  );
  const found: Array<Occurrence> =
    addsStart && instantOf(startDate, ruleTzid, local) < window.horizonMs
      ? [...inWindow(instanceAt(event, startDate, ruleTzid), window, local)]
      : [];
  const iterator = event.iterator();
  for (
    let step = 0, next: ICAL.Time | ICAL.Period = iterator.next();
    next !== null &&
    next !== undefined &&
    instantOf(
      next instanceof ICAL.Period ? next.start : next,
      zoneOf(next instanceof ICAL.Period ? next.start : next, ruleTzid),
      local,
    ) < window.horizonMs;
    step += 1, next = iterator.next()
  ) {
    if (step === maxRuleSteps) {
      throw new Error(
        `it repeats more than ${maxRuleSteps} times before the end of the requested time range`,
      );
    }
    const instance = instanceAt(event, next, ruleTzid);
    if (!(addsStart && instance.slot?.time.compare(startDate) === 0)) {
      found.push(...inWindow(instance, window, local));
    }
  }
  return found;
};

// An override can move an occurrence from after the horizon into the window;
// the rule stopped before reaching its original slot.
const movedIntoWindow = (
  overrides: ReadonlyArray<ICAL.Component>,
  ruleTzid: string | undefined,
  window: SeriesWindow,
  local: DateTime.TimeZone,
): ReadonlyArray<Occurrence> =>
  overrides.flatMap((component) => {
    const moved = new ICAL.Event(component);
    const slot = {
      time: moved.recurrenceId,
      tzid: tzidOf(component, 'recurrence-id') ?? ruleTzid,
    };
    return instantOf(slot.time, slot.tzid, local) < window.horizonMs
      ? []
      : inWindow(asStored(moved, slot), window, local);
  });

const expandSeries = (
  master: ICAL.Component,
  overrides: ReadonlyArray<ICAL.Component>,
  window: TimeWindow,
  local: DateTime.TimeZone,
): ReadonlyArray<Occurrence> => {
  const event = new ICAL.Event(master, { exceptions: [...overrides] });
  if (!event.isRecurring()) {
    return inWindow(asStored(event), window, local);
  }
  const ruleTzid = tzidOf(master, 'dtstart');
  try {
    const seriesWindow = {
      ...window,
      horizonMs: horizonOf(overrides, ruleTzid, window, local),
    };
    return [
      ...ruleOccurrences(event, ruleTzid, seriesWindow, local),
      ...movedIntoWindow(overrides, ruleTzid, seriesWindow, local),
    ];
  } catch (cause) {
    // ical.js's own errors don't say which event they are about.
    throw new Error(
      `Could not work out the occurrences of event ${event.uid}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
};

// The occurrences of every event in one calendar object that overlap the
// window. Overrides without their series, as when someone invited the user
// to a single instance, stand alone.
export const occurrencesIn = (
  vcalendar: ICAL.Component,
  window: TimeWindow,
  local: DateTime.TimeZone,
): ReadonlyArray<Occurrence> => {
  registerIanaZones(vcalendar);
  const vevents = vcalendar.getAllSubcomponents('vevent');
  const isOverride = (component: ICAL.Component) =>
    component.hasProperty('recurrence-id');
  const masters = vevents.filter((component) => !isOverride(component));
  const overrides = vevents.filter(isOverride);
  const masterUids = new Set(masters.map(uidOf));
  return [
    ...masters.flatMap((master) =>
      expandSeries(
        master,
        overrides.filter((override) => uidOf(override) === uidOf(master)),
        window,
        local,
      ),
    ),
    ...overrides
      .filter((override) => !masterUids.has(uidOf(override)))
      .flatMap((component) => {
        const lone = new ICAL.Event(component);
        const slot = {
          time: lone.recurrenceId,
          tzid: tzidOf(component, 'recurrence-id'),
        };
        return inWindow(asStored(lone, slot), window, local);
      }),
  ];
};
