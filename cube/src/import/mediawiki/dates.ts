/**
 * MW-era fuzzy date strings to ISO partials (YYYY, YYYY-MM, YYYY-MM-DD).
 * HP infoboxes mix "Sep 29, 1992", "29 Sep 1992", "May 1992", "1992-09-29",
 * bare years, and sometimes a trailing time of day.
 */

const MONTHS: Record<string, number> = (() => {
  const names = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const map: Record<string, number> = {};
  names.forEach((name, idx) => {
    map[name] = idx + 1;
    map[name.slice(0, 3)] = idx + 1;
  });
  // "Sept" is a common four-letter abbreviation in HP infoboxes.
  map["sept"] = 9;
  return map;
})();

function monthNumber(token: string): number | null {
  return MONTHS[token.toLowerCase().replace(/\.$/, "")] ?? null;
}

function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

function iso(year: number, month?: number, day?: number): string | null {
  if (month === undefined) return String(year).padStart(4, "0");
  if (month < 1 || month > 12) return null;
  const ym = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
  if (day === undefined) return ym;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return `${ym}-${String(day).padStart(2, "0")}`;
}

export function parseFuzzyDate(text: string): string | null {
  let s = text.trim();
  // HP infoboxes append a time of day ("Sep 29, 1992 10:33:00"); drop it.
  s = s
    .replace(/[\sT]+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp]\.?[Mm]\.?)?$/, "")
    .trim();
  if (!s) return null;

  let m = /^(\d{4})$/.exec(s);
  if (m) return iso(Number(m[1]));

  m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (m) return iso(Number(m[1]), Number(m[2]));

  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));

  // "May 1992" (comma after the month tolerated)
  m = /^([A-Za-z]+\.?),?\s+(\d{4})$/.exec(s);
  if (m) {
    const month = monthNumber(m[1]!);
    return month === null ? null : iso(Number(m[2]), month);
  }

  // "Sep 29, 1992" / "September 29 1992" (ordinal suffixes tolerated)
  m = /^([A-Za-z]+\.?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i.exec(s);
  if (m) {
    const month = monthNumber(m[1]!);
    return month === null ? null : iso(Number(m[3]), month, Number(m[2]));
  }

  // "29 Sep 1992"
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+\.?),?\s+(\d{4})$/i.exec(s);
  if (m) {
    const month = monthNumber(m[2]!);
    return month === null ? null : iso(Number(m[3]), month, Number(m[1]));
  }

  return null;
}
