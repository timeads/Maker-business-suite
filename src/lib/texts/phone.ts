/**
 * Phone numbers for text reminders, in the international form text services
 * want (E.164: "+", the country code, then the number, 8 to 15 digits).
 *
 * People type numbers every which way ("(215) 555-0134", "07700 900123",
 * "+44 7700 900123"). A number that starts with "+" or "00" already says its
 * country. A number without one is read as a number of the workspace's own
 * country (the `default_country` setting), and only for the countries listed
 * here, whose national numbering we know. Anything else is refused rather
 * than guessed: a text to the wrong country is worse than no text.
 *
 * Pure, so it can be tested and used on the server and in the editor alike.
 */

type Country = {
  /** The country calling code, without "+". */
  code: string;
  /** Plain words for the settings screen. */
  name: string;
  /** Turns the national digits (no country code) into the digits after the code, or null. */
  national(digits: string): string | null;
};

/** North America: 10 digits, or 11 starting with the 1 people sometimes add. */
const northAmerica = (digits: string) => {
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  // Area codes and exchanges never start with 0 or 1.
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? ten : null;
};

/** Countries whose national form is a leading 0 and a set number of digits after it. */
const trunkZero = (min: number, max: number) => (digits: string) => {
  const rest = digits.startsWith("0") ? digits.slice(1) : digits;
  return rest.length >= min && rest.length <= max && /^[1-9]/.test(rest) ? rest : null;
};

export const COUNTRIES: Record<string, Country> = {
  US: { code: "1", name: "United States", national: northAmerica },
  CA: { code: "1", name: "Canada", national: northAmerica },
  GB: { code: "44", name: "United Kingdom", national: trunkZero(10, 10) },
  IE: { code: "353", name: "Ireland", national: trunkZero(9, 9) },
  AU: { code: "61", name: "Australia", national: trunkZero(9, 9) },
  NZ: { code: "64", name: "New Zealand", national: trunkZero(8, 10) },
};
export type CountryKey = keyof typeof COUNTRIES;
export const COUNTRY_KEYS = Object.keys(COUNTRIES) as CountryKey[];

export const isCountryKey = (value: unknown): value is CountryKey =>
  typeof value === "string" && Object.hasOwn(COUNTRIES, value);

/** Only digits, a leading "+", spaces, dots, dashes, slashes and brackets are allowed in. */
const TYPED = /^\+?[\d\s().\-/]+$/;

/**
 * The number in E.164, or null when it can't be read for sure. `country` is
 * the workspace's own: used only for a number typed without a country code.
 */
export function toE164(raw: string, country: CountryKey | null): string | null {
  const typed = (raw ?? "").trim();
  if (typed === "" || typed.length > 40 || !TYPED.test(typed)) return null;
  const digits = typed.replace(/\D/g, "");
  if (typed.startsWith("+") || (digits.startsWith("00") && !typed.startsWith("+"))) {
    const international = typed.startsWith("+") ? digits : digits.slice(2);
    // A country code never starts with 0, and the whole is 8 to 15 digits.
    if (!/^[1-9]\d{7,14}$/.test(international)) return null;
    // A country we know the shape of is checked against it.
    for (const known of Object.values(COUNTRIES)) {
      if (international.startsWith(known.code)) {
        const rest = international.slice(known.code.length);
        if (known.code === "1") return northAmerica(rest) ? `+1${rest}` : null;
        return known.national(rest) === rest ? `+${international}` : null;
      }
    }
    return `+${international}`;
  }
  if (!country) return null;
  const known = COUNTRIES[country];
  const national = known.national(digits);
  return national ? `+${known.code}${national}` : null;
}

/** "+1 215 555 0134"-ish, for showing a number back to a person. Never used for sending. */
export function showPhone(e164: string): string {
  if (/^\+1\d{10}$/.test(e164)) {
    return `+1 ${e164.slice(2, 5)} ${e164.slice(5, 8)} ${e164.slice(8)}`;
  }
  return e164;
}
