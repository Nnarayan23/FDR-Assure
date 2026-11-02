import { describe, expect, it } from "vitest";
import { isConfirmationFresh } from "../config.js";

describe("Confirmation freshness", () => {
  const now = new Date("2026-10-27T12:00:00.000Z");

  it("accepts a confirmation made at the current time", () => {
    expect(isConfirmationFresh(now, now)).toBe(true);
  });

  it("accepts a confirmation within the 72-hour default window", () => {
    const confirmedAt = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    expect(isConfirmationFresh(confirmedAt, now)).toBe(true);
  });

  it("accepts a confirmation exactly at the default 72-hour limit", () => {
    const confirmedAt = new Date(now.getTime() - 72 * 60 * 60 * 1000);

    expect(isConfirmationFresh(confirmedAt, now)).toBe(true);
  });

  it("rejects a confirmation older than the default 72-hour limit", () => {
    const confirmedAt = new Date(now.getTime() - 73 * 60 * 60 * 1000);

    expect(isConfirmationFresh(confirmedAt, now)).toBe(false);
  });

  it("rejects a future-dated confirmation", () => {
    const confirmedAt = new Date(now.getTime() + 60 * 1000);

    expect(isConfirmationFresh(confirmedAt, now)).toBe(false);
  });

  it("rejects an invalid confirmation date", () => {
    const confirmedAt = new Date(Number.NaN);

    expect(isConfirmationFresh(confirmedAt, now)).toBe(false);
  });
});
