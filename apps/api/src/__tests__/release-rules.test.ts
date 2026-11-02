import { describe, expect, it } from "vitest";
import { evaluateRelease } from "../release-rules.js";

const now = new Date("2026-10-27T12:00:00.000Z");

const validEvidence = {
  confirmationStatus: "CONFIRMED" as const,
  confirmedAt: new Date("2026-10-27T11:00:00.000Z"),
  now,
  confirmationFresh: true,
  makerId: "maker-001",
  checkerId: "checker-002",
};

describe("Release decision rules", () => {
  it("allows release when all gates pass", () => {
    const result = evaluateRelease(validEvidence);

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("RELEASE_GATES_PASSED");
    expect(result.simulated).toBe(true);
  });

  it("blocks release when bank confirmation is missing", () => {
    const result = evaluateRelease({
      ...validEvidence,
      confirmationStatus: null,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("BANK_CONFIRMATION_MISSING");
  });

  it("blocks a pending bank confirmation", () => {
    const result = evaluateRelease({
      ...validEvidence,
      confirmationStatus: "PENDING",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("BANK_CONFIRMATION_PENDING");
  });

  it("blocks an unresponsive bank without calling it fraud", () => {
    const result = evaluateRelease({
      ...validEvidence,
      confirmationStatus: "UNRESPONSIVE",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("BANK_CONFIRMATION_UNRESPONSIVE");
    expect(result.reason).not.toContain("FRAUD");
  });

  it("blocks mismatched bank details", () => {
    const result = evaluateRelease({
      ...validEvidence,
      confirmationStatus: "MISMATCH",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("BANK_DETAILS_MISMATCH");
  });

  it("blocks stale confirmation evidence", () => {
    const result = evaluateRelease({
      ...validEvidence,
      confirmationFresh: false,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("BANK_CONFIRMATION_STALE");
  });

  it("blocks confirmation without a confirmation timestamp", () => {
    const result = evaluateRelease({
      ...validEvidence,
      confirmedAt: null,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("BANK_CONFIRMATION_STALE");
  });

  it("requires both maker and checker", () => {
    const result = evaluateRelease({
      ...validEvidence,
      checkerId: null,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("MAKER_CHECKER_REQUIRED");
  });

  it("blocks the same person acting as maker and checker", () => {
    const result = evaluateRelease({
      ...validEvidence,
      checkerId: "maker-001",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("MAKER_AND_CHECKER_MUST_DIFFER");
  });
});
