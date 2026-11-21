const COMMON_CURRENCIES = ["USD", "CAD", "GBP", "EUR", "AUD", "NZD"];

export function timezoneOptions(): string[] {
  const zones = Intl.supportedValuesOf("timeZone");
  return zones.includes("UTC") ? zones : ["UTC", ...zones];
}

export function currencyOptions(): { code: string; label: string }[] {
  const names = new Intl.DisplayNames(["en"], { type: "currency" });
  const rest = Intl.supportedValuesOf("currency").filter((c) => !COMMON_CURRENCIES.includes(c));
  return [...COMMON_CURRENCIES, ...rest].map((code) => ({
    code,
    label: `${code} — ${names.of(code) ?? code}`,
  }));
}
