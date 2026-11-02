import { isRealCalendarDate } from "../date-validation.js";

import { describe, expect, it } from "vitest";

type FdrDetails = {
  institution: string;
  amount: number;
  issueDate: string;
  maturityDate: string;
};

function compareFdrDetails(
  registered: FdrDetails,
  supplied: FdrDetails,
) {
  const fieldMatches = {
    institution:
      supplied.institution.trim().toLowerCase() ===
      registered.institution.trim().toLowerCase(),
    amount: supplied.amount === registered.amount,
    issueDate: supplied.issueDate === registered.issueDate,
    maturityDate: supplied.maturityDate === registered.maturityDate,
  };

  const outcome = Object.values(fieldMatches).every(Boolean)
    ? "CONFIRMED"
    : "MISMATCH";

  return { outcome, fieldMatches };
}

const registeredFdr: FdrDetails = {
  institution: "Demo Cooperative Bank",
  amount: 75000,
  issueDate: "2026-02-01",
  maturityDate: "2027-02-01",
};

describe("Simulated bank FDR field comparison", () => {
  it("returns CONFIRMED when all four fields match", () => {
    const result = compareFdrDetails(registeredFdr, {
      ...registeredFdr,
    });

    expect(result.outcome).toBe("CONFIRMED");
    expect(Object.values(result.fieldMatches).every(Boolean)).toBe(true);
  });

  it("ignores institution letter case and surrounding spaces", () => {
    const result = compareFdrDetails(registeredFdr, {
      ...registeredFdr,
      institution: "  DEMO COOPERATIVE BANK  ",
    });

    expect(result.outcome).toBe("CONFIRMED");
  });

  it("returns MISMATCH when the amount differs", () => {
    const result = compareFdrDetails(registeredFdr, {
      ...registeredFdr,
      amount: 70000,
    });

    expect(result.outcome).toBe("MISMATCH");
    expect(result.fieldMatches.amount).toBe(false);
  });

  it("returns MISMATCH when the issue date differs", () => {
    const result = compareFdrDetails(registeredFdr, {
      ...registeredFdr,
      issueDate: "2026-02-02",
    });

    expect(result.outcome).toBe("MISMATCH");
    expect(result.fieldMatches.issueDate).toBe(false);
  });

  it("returns MISMATCH when the maturity date differs", () => {
    const result = compareFdrDetails(registeredFdr, {
      ...registeredFdr,
      maturityDate: "2027-02-02",
    });

    expect(result.outcome).toBe("MISMATCH");
    expect(result.fieldMatches.maturityDate).toBe(false);
  });
});




describe("Calendar date validation", () => {
  it("accepts a valid date", () => {
    expect(isRealCalendarDate("2026-10-27")).toBe(true);
  });

  it("accepts February 29 in a leap year", () => {
    expect(isRealCalendarDate("2024-02-29")).toBe(true);
  });

  it("rejects February 30", () => {
    expect(isRealCalendarDate("2026-02-30")).toBe(false);
  });

  it("rejects February 29 in a non-leap year", () => {
    expect(isRealCalendarDate("2025-02-29")).toBe(false);
  });

  it("rejects an invalid month", () => {
    expect(isRealCalendarDate("2026-13-01")).toBe(false);
  });

  it("rejects an invalid format", () => {
    expect(isRealCalendarDate("27-10-2026")).toBe(false);
  });
});
