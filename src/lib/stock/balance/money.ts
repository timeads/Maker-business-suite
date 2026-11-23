/**
 * Money as whole cents, with the handful of operations the vendor ledger
 * needs. Amounts never pass through floating-point arithmetic: they are read
 * from text, kept as integers, and written back with two decimals.
 */
export class Money {
  readonly cents: number;

  constructor(value: Money.Value) {
    if (value instanceof Money) {
      this.cents = value.cents;
      return;
    }
    const text = (typeof value === "number" ? value.toFixed(2) : String(value)).trim();
    const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(text);
    if (!match || (match[2] === "" && !match[3])) throw new Error(`Not an amount: ${text}`);
    const whole = Number(match[2] || "0");
    const fraction = (match[3] ?? "").padEnd(3, "0");
    // Round half up on the third decimal, as amounts on paper are.
    const cents = whole * 100 + Number(fraction.slice(0, 2)) + (Number(fraction[2]) >= 5 ? 1 : 0);
    this.cents = match[1] ? -cents : cents;
  }

  private static of(cents: number): Money {
    const out = Object.create(Money.prototype) as { cents: number };
    out.cents = cents;
    return out as Money;
  }

  static min(...values: Money.Value[]): Money {
    return Money.of(Math.min(...values.map((v) => new Money(v).cents)));
  }
  static max(...values: Money.Value[]): Money {
    return Money.of(Math.max(...values.map((v) => new Money(v).cents)));
  }

  add(other: Money.Value): Money {
    return Money.of(this.cents + new Money(other).cents);
  }
  plus(other: Money.Value): Money {
    return this.add(other);
  }
  sub(other: Money.Value): Money {
    return Money.of(this.cents - new Money(other).cents);
  }
  minus(other: Money.Value): Money {
    return this.sub(other);
  }
  neg(): Money {
    return Money.of(-this.cents);
  }
  abs(): Money {
    return Money.of(Math.abs(this.cents));
  }
  gt(other: Money.Value): boolean {
    return this.cents > new Money(other).cents;
  }
  gte(other: Money.Value): boolean {
    return this.cents >= new Money(other).cents;
  }
  lt(other: Money.Value): boolean {
    return this.cents < new Money(other).cents;
  }
  lte(other: Money.Value): boolean {
    return this.cents <= new Money(other).cents;
  }
  equals(other: Money.Value): boolean {
    return this.cents === new Money(other).cents;
  }
  eq(other: Money.Value): boolean {
    return this.equals(other);
  }
  isZero(): boolean {
    return this.cents === 0;
  }
  isNegative(): boolean {
    return this.cents < 0;
  }
  toNumber(): number {
    return this.cents / 100;
  }
  /** Always two decimals; the argument is accepted for likeness with decimal libraries. */
  toFixed(_places = 2): string {
    const abs = Math.abs(this.cents);
    return `${this.cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  }
  toString(): string {
    return this.toFixed(2);
  }
}

// eslint-disable-next-line @typescript-eslint/no-namespace -- mirrors Decimal.Value so ported code reads the same
export namespace Money {
  export type Value = Money | string | number;
}
