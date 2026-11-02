export type BankConfirmationStatus =
  | "PENDING"
  | "CONFIRMED"
  | "MISMATCH"
  | "UNRESPONSIVE";

export type ReleaseEvidence = {
  confirmationStatus: BankConfirmationStatus | null;
  confirmedAt: Date | null;
  now: Date;
  confirmationFresh: boolean;
  makerId: string | null;
  checkerId: string | null;
};

export type ReleaseDecision = {
  allowed: boolean;
  reason: string;
  simulated: true;
};

export function evaluateRelease(
  evidence: ReleaseEvidence,
): ReleaseDecision {
  if (evidence.confirmationStatus === null) {
    return {
      allowed: false,
      reason: "BANK_CONFIRMATION_MISSING",
      simulated: true,
    };
  }

  if (evidence.confirmationStatus === "PENDING") {
    return {
      allowed: false,
      reason: "BANK_CONFIRMATION_PENDING",
      simulated: true,
    };
  }

  if (evidence.confirmationStatus === "UNRESPONSIVE") {
    return {
      allowed: false,
      reason: "BANK_CONFIRMATION_UNRESPONSIVE",
      simulated: true,
    };
  }

  if (evidence.confirmationStatus === "MISMATCH") {
    return {
      allowed: false,
      reason: "BANK_DETAILS_MISMATCH",
      simulated: true,
    };
  }

  if (
    evidence.confirmedAt === null ||
    !Number.isFinite(evidence.confirmedAt.getTime()) ||
    !evidence.confirmationFresh
  ) {
    return {
      allowed: false,
      reason: "BANK_CONFIRMATION_STALE",
      simulated: true,
    };
  }

  if (!evidence.makerId?.trim() || !evidence.checkerId?.trim()) {
    return {
      allowed: false,
      reason: "MAKER_CHECKER_REQUIRED",
      simulated: true,
    };
  }

  if (evidence.makerId.trim() === evidence.checkerId.trim()) {
    return {
      allowed: false,
      reason: "MAKER_AND_CHECKER_MUST_DIFFER",
      simulated: true,
    };
  }

  return {
    allowed: true,
    reason: "RELEASE_GATES_PASSED",
    simulated: true,
  };
}
