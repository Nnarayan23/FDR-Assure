
import express from "express";
import cors from "cors";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { FDRSchema, type FDR } from "@fdr-assure/shared";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRealCalendarDate } from "./date-validation.js";
import { isConfirmationFresh, systemClock } from "./config.js";
import { evaluateRelease } from "./release-rules.js";

const app = express();
const PORT = Number(process.env.PORT) || 3001;
function calculateEventHash(
  event: {
    eventId: number;
    fdrId: string;
    action: string;
    eventTimestamp: string;
    details: string;
  },
  previousHash: string | null,
): string {
  const canonicalEvent = JSON.stringify({
    eventId: event.eventId,
    fdrId: event.fdrId,
    action: event.action,
    eventTimestamp: event.eventTimestamp,
    details: event.details,
    previousHash,
  });

  return createHash("sha256").update(canonicalEvent).digest("hex");
}


// Append an event to the existing tamper-evident audit chain.
// Call this inside the caller's database transaction.
function appendAuditEvent(
  fdrId: string,
  action: string,
  detailsObject: Record<string, unknown>,
): void {
  const previousEvent = db
    .prepare(`
      SELECT eventHash FROM audit_log
      ORDER BY eventId DESC LIMIT 1
    `)
    .get() as { eventHash: string | null } | undefined;

  if (previousEvent && !previousEvent.eventHash) {
    throw new Error("AUDIT_CHAIN_NOT_INITIALIZED");
  }

  const previousHash = previousEvent?.eventHash ?? null;
  const eventTimestamp = new Date().toISOString();
  const details = JSON.stringify({
    ...detailsObject,
    simulated: true,
  });

  const inserted = db.prepare(`
    INSERT INTO audit_log
      (fdrId, action, eventTimestamp, details)
    VALUES (?, ?, ?, ?)
  `).run(fdrId, action, eventTimestamp, details);

  const eventId = Number(inserted.lastInsertRowid);
  const eventHash = calculateEventHash(
    { eventId, fdrId, action, eventTimestamp, details },
    previousHash,
  );

  db.prepare(`
    UPDATE audit_log
    SET previousHash = ?, eventHash = ?
    WHERE eventId = ?
  `).run(previousHash, eventHash, eventId);
}
// Store the database in the apps/api folder.
const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);
const databasePath = process.env.FDR_DATABASE_PATH || path.resolve(currentDirectory, "../fdr-assure.db");

const db = new DatabaseSync(databasePath);

db.exec(`
  CREATE TABLE IF NOT EXISTS fdrs (
    id TEXT PRIMARY KEY,
    institution TEXT NOT NULL,
    amount REAL NOT NULL,
    issueDate TEXT NOT NULL,
    maturityDate TEXT NOT NULL,
    trustTier TEXT NOT NULL
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    eventId INTEGER PRIMARY KEY AUTOINCREMENT,
    fdrId TEXT NOT NULL,
    action TEXT NOT NULL,
    eventTimestamp TEXT NOT NULL,
    details TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS bank_confirmation_requests (
    requestId TEXT PRIMARY KEY,
    fdrId TEXT NOT NULL,
    idempotencyKey TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (
      status IN ('PENDING', 'CONFIRMED', 'MISMATCH', 'UNRESPONSIVE')
    ),
    createdAt TEXT NOT NULL,
    respondedAt TEXT,
    outcome TEXT,
    bankReference TEXT,
    responseDetails TEXT,
    simulated INTEGER NOT NULL DEFAULT 1 CHECK (simulated = 1)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS release_requests (
    releaseId TEXT PRIMARY KEY,
    fdrId TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN ('BLOCKED', 'PENDING_CHECKER', 'APPROVED', 'REJECTED')
    ),
    makerId TEXT NOT NULL,
    checkerId TEXT,
    decisionReason TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    simulated INTEGER NOT NULL DEFAULT 1 CHECK (simulated = 1)
  )
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_release_requests_fdrId
  ON release_requests(fdrId)
`);

const auditColumns = db
  .prepare("PRAGMA table_info(audit_log)")
  .all() as Array<{ name: string }>;

if (!auditColumns.some((column) => column.name === "previousHash")) {
  db.exec("ALTER TABLE audit_log ADD COLUMN previousHash TEXT");
}

if (!auditColumns.some((column) => column.name === "eventHash")) {
  db.exec("ALTER TABLE audit_log ADD COLUMN eventHash TEXT");
}

const unhashedEvents = db
  .prepare(`
    SELECT eventId, fdrId, action, eventTimestamp, details,
           previousHash, eventHash
    FROM audit_log
    WHERE eventHash IS NULL
    ORDER BY eventId ASC
  `)
  .all() as Array<{
    eventId: number;
    fdrId: string;
    action: string;
    eventTimestamp: string;
    details: string;
    previousHash: string | null;
    eventHash: string | null;
  }>;

if (unhashedEvents.length > 0) {
  console.log(
    `Found ${unhashedEvents.length} legacy audit event(s) without hashes. They have not been verified.`,
  );
}


app.use(cors({ origin: process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(",").map((url) => url.trim()) : true }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "FDR Assure API",
    simulated: true,
  });
});

app.get("/api/audit-log", (_req, res) => {
  try {
    const events = db
      .prepare(`
       SELECT
  eventId,
  fdrId,
  action,
  eventTimestamp,
  details,
  previousHash,
  eventHash
FROM audit_log
ORDER BY eventId DESC
      `)
      .all();

    return res.json({
      data: events,
      simulated: true,
    });
  } catch (error) {
    console.error("Audit log query failed:", error);

    return res.status(500).json({
      error: {
        code: "AUDIT_LOG_READ_FAILED",
        message: "Could not retrieve audit events.",
      },
      simulated: true,
    });
  }
});

app.post("/api/audit-log/initialize-chain", (_req, res) => {
  try {
    const existing = db
      .prepare(`
        SELECT eventId, eventHash
        FROM audit_log
        WHERE eventHash IS NOT NULL
        ORDER BY eventId ASC
      `)
      .all();

    if (existing.length > 0) {
      return res.status(409).json({
        error: {
          code: "CHAIN_ALREADY_INITIALIZED",
          message:
            "The audit chain already contains hashed events. Initialization was not performed.",
        },
        simulated: true,
      });
    }

    const events = db
      .prepare(`
        SELECT eventId, fdrId, action, eventTimestamp, details
        FROM audit_log
        ORDER BY eventId ASC
      `)
      .all() as Array<{
        eventId: number;
        fdrId: string;
        action: string;
        eventTimestamp: string;
        details: string;
      }>;

    db.exec("BEGIN");

    try {
      const update = db.prepare(`
        UPDATE audit_log
        SET previousHash = ?, eventHash = ?
        WHERE eventId = ?
      `);

      let previousHash: string | null = null;

      for (const event of events) {
        const eventHash = calculateEventHash(event, previousHash);

        update.run(previousHash, eventHash, event.eventId);
        previousHash = eventHash;
      }

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return res.json({
      message:
        "Baseline initialized. Existing events were hashed now; this does not prove their historical integrity.",
      initializedEvents: events.length,
      simulated: true,
    });
  } catch (error) {
    console.error("Audit-chain initialization failed:", error);

    return res.status(500).json({
      error: {
        code: "CHAIN_INITIALIZATION_FAILED",
        message: "Could not initialize the audit chain.",
      },
      simulated: true,
    });
  }
});

app.get("/api/audit-log/verify", (_req, res) => {
  try {
    const events = db
      .prepare(`
        SELECT eventId, fdrId, action, eventTimestamp, details,
               previousHash, eventHash
        FROM audit_log
        ORDER BY eventId ASC
      `)
      .all() as Array<{
        eventId: number;
        fdrId: string;
        action: string;
        eventTimestamp: string;
        details: string;
        previousHash: string | null;
        eventHash: string | null;
      }>;

    let expectedPreviousHash: string | null = null;

    for (const event of events) {
      if (!event.eventHash) {
        return res.json({
          valid: false,
          checkedEvents: events.length,
          failedEventId: event.eventId,
          reason: "Event is missing its hash.",
          simulated: true,
        });
      }

      if (event.previousHash !== expectedPreviousHash) {
        return res.json({
          valid: false,
          checkedEvents: events.length,
          failedEventId: event.eventId,
          reason: "Previous-hash link does not match.",
          simulated: true,
        });
      }

      const calculatedHash = calculateEventHash(
        event,
        expectedPreviousHash,
      );

      if (event.eventHash !== calculatedHash) {
        return res.json({
          valid: false,
          checkedEvents: events.length,
          failedEventId: event.eventId,
          reason: "Event hash does not match its contents.",
          simulated: true,
        });
      }

      expectedPreviousHash = event.eventHash;
    }

    return res.json({
      valid: true,
      checkedEvents: events.length,
      message: "All checked audit events have a consistent hash chain.",
      simulated: true,
    });
  } catch (error) {
    console.error("Audit-chain verification failed:", error);

    return res.status(500).json({
      error: {
        code: "CHAIN_VERIFICATION_FAILED",
        message: "Could not verify the audit chain.",
      },
      simulated: true,
    });
  }
});



// Register an FDR after validation.

app.post("/api/fdrs", (req, res) => {
  const result = FDRSchema.safeParse(req.body);

  if (req.body?.trustTier !== "T0") {
    return res.status(403).json({
      error: {
        code: "TRUST_TIER_NOT_ALLOWED",
        message:
          "Only T0 (Declared) is allowed until the required verification workflows are implemented.",
      },
      simulated: true,
    });
  }

  if (!result.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "FDR data failed validation.",
        details: result.error.issues,
      },
      simulated: true,
    });
  }

  const fdr: FDR = result.data;

  try {
    db.exec("BEGIN");

    try {
      // Find the previous audit event.
      const previousEvent = db
        .prepare(`
          SELECT eventId, eventHash
          FROM audit_log
          ORDER BY eventId DESC
          LIMIT 1
        `)
        .get() as
        | { eventId: number; eventHash: string | null }
        | undefined;

      // Do not extend a chain that has not been initialized correctly.
      if (previousEvent && !previousEvent.eventHash) {
        throw new Error("AUDIT_CHAIN_NOT_INITIALIZED");
      }

      const previousHash = previousEvent?.eventHash ?? null;

      // Save the FDR.
      db.prepare(`
        INSERT INTO fdrs
        (id, institution, amount, issueDate, maturityDate, trustTier)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        fdr.id,
        fdr.institution,
        fdr.amount,
        fdr.issueDate,
        fdr.maturityDate,
        fdr.trustTier,
      );

      const eventTimestamp = new Date().toISOString();

      const details = JSON.stringify({
        institution: fdr.institution,
        amount: fdr.amount,
        issueDate: fdr.issueDate,
        maturityDate: fdr.maturityDate,
        trustTier: fdr.trustTier,
        simulated: true,
      });

      // Insert the audit event first to obtain its event ID.
      const insertResult = db.prepare(`
        INSERT INTO audit_log
        (fdrId, action, eventTimestamp, details)
        VALUES (?, ?, ?, ?)
      `).run(
        fdr.id,
        "FDR_REGISTERED",
        eventTimestamp,
        details,
      );

      const eventId = Number(insertResult.lastInsertRowid);

      const event = {
        eventId,
        fdrId: fdr.id,
        action: "FDR_REGISTERED",
        eventTimestamp,
        details,
      };

      // Calculate and store the event's hash and its link to the previous event.
      const eventHash = calculateEventHash(event, previousHash);

      db.prepare(`
        UPDATE audit_log
        SET previousHash = ?, eventHash = ?
        WHERE eventId = ?
      `).run(previousHash, eventHash, eventId);

      // Save both records together.
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return res.status(201).json({
      data: fdr,
      simulated: true,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("UNIQUE constraint failed")
    ) {
      return res.status(409).json({
        error: {
          code: "DUPLICATE_ID",
          message: "An FDR with this ID already exists.",
        },
        simulated: true,
      });
    }

    if (
      error instanceof Error &&
      error.message === "AUDIT_CHAIN_NOT_INITIALIZED"
    ) {
      return res.status(409).json({
        error: {
          code: "AUDIT_CHAIN_NOT_INITIALIZED",
          message:
            "The audit chain must be initialized before registering new FDRs.",
        },
        simulated: true,
      });
    }

    console.error("Database error:", error);

    return res.status(500).json({
      error: {
        code: "DATABASE_ERROR",
        message: "The FDR could not be saved.",
      },
      simulated: true,
    });
  }
});


// Retrieve all registered FDRs.
app.get("/api/fdrs", (_req, res) => {
  const records = db
    .prepare("SELECT * FROM fdrs ORDER BY id")
    .all() as FDR[];

  res.json({
    data: records,
    simulated: true,
  });
});

app.get("/api/bank-confirmation-requests", (_req, res) => {
  const requests = db.prepare(`
    SELECT requestId, fdrId, idempotencyKey, status, createdAt,
           respondedAt, outcome, bankReference, responseDetails, simulated
    FROM bank_confirmation_requests
    ORDER BY createdAt DESC
  `).all();

  return res.json({ data: requests, simulated: true });
});

app.post("/api/fdrs/:id/bank-confirmation", (req, res) => {
  const fdrId = String(req.params.id);
  const idempotencyKey = String(
    req.get("Idempotency-Key") ?? req.body?.idempotencyKey ?? ""
  ).trim();

  if (!idempotencyKey || idempotencyKey.length > 200) {
    return res.status(400).json({
      error: {
        code: "IDEMPOTENCY_KEY_REQUIRED",
        message: "Provide a non-empty Idempotency-Key header (maximum 200 characters).",
      },
      simulated: true,
    });
  }

  const fdr = db.prepare(
    "SELECT id FROM fdrs WHERE id = ?"
  ).get(fdrId);

  if (!fdr) {
    return res.status(404).json({
      error: {
        code: "FDR_NOT_FOUND",
        message: "No registered FDR exists with this ID.",
      },
      simulated: true,
    });
  }

  const existing = db.prepare(`
    SELECT requestId, fdrId, idempotencyKey, status, createdAt,
           respondedAt, outcome, bankReference, responseDetails, simulated
    FROM bank_confirmation_requests
    WHERE idempotencyKey = ?
  `).get(idempotencyKey) as
    | { requestId: string; fdrId: string }
    | undefined;

  if (existing) {
    if (existing.fdrId !== fdrId) {
      return res.status(409).json({
        error: {
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "This idempotency key was already used for another FDR.",
        },
        simulated: true,
      });
    }

    const sameRequest = db.prepare(`
      SELECT requestId, fdrId, idempotencyKey, status, createdAt,
             respondedAt, outcome, bankReference, responseDetails, simulated
      FROM bank_confirmation_requests WHERE requestId = ?
    `).get(existing.requestId);

    return res.json({
      data: sameRequest,
      reused: true,
      simulated: true,
    });
  }

  const requestId = randomUUID();
  const createdAt = new Date().toISOString();

  try {
    db.exec("BEGIN");

    db.prepare(`
      INSERT INTO bank_confirmation_requests
        (requestId, fdrId, idempotencyKey, status, createdAt, simulated)
      VALUES (?, ?, ?, 'PENDING', ?, 1)
    `).run(requestId, fdrId, idempotencyKey, createdAt);

    appendAuditEvent(fdrId, "BANK_CONFIRMATION_REQUESTED", {
      requestId,
      idempotencyKey,
      status: "PENDING",
    });

    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction may already have rolled back.
    }

    if (error instanceof Error &&
        error.message.includes("UNIQUE constraint failed")) {
      return res.status(409).json({
        error: {
          code: "IDEMPOTENCY_CONFLICT",
          message: "A request with this idempotency key already exists.",
        },
        simulated: true,
      });
    }

    if (error instanceof Error &&
        error.message === "AUDIT_CHAIN_NOT_INITIALIZED") {
      return res.status(409).json({
        error: {
          code: "AUDIT_CHAIN_NOT_INITIALIZED",
          message: "The existing audit chain must be repaired before adding events.",
        },
        simulated: true,
      });
    }

    console.error("Bank-confirmation request failed:", error);

    return res.status(500).json({
      error: {
        code: "BANK_REQUEST_FAILED",
        message: "Could not create the simulated bank-confirmation request.",
      },
      simulated: true,
    });
  }

  return res.status(201).json({
    data: {
      requestId,
      fdrId,
      idempotencyKey,
      status: "PENDING",
      createdAt,
      simulated: true,
    },
    simulated: true,
  });
});
app.post("/api/bank-confirmation-requests/:requestId/respond", (req, res) => {
  const requestId = String(req.params.requestId);

const bankResponse = req.body?.bankResponse;

if (
  !bankResponse ||
  typeof bankResponse !== "object" ||
  Array.isArray(bankResponse)
) {
  return res.status(400).json({
    error: {
      code: "INVALID_SIMULATED_BANK_RESPONSE",
      message:
        "Provide bankResponse with institution, amount, issueDate, and maturityDate.",
    },
    simulated: true,
  });
}




 const validBankResponse =
  typeof bankResponse.institution === "string" &&
  bankResponse.institution.trim().length > 0 &&
  typeof bankResponse.amount === "number" &&
  Number.isFinite(bankResponse.amount) &&
  bankResponse.amount > 0 &&
  typeof bankResponse.issueDate === "string" &&
  isRealCalendarDate(bankResponse.issueDate) &&
  typeof bankResponse.maturityDate === "string" &&
  isRealCalendarDate(bankResponse.maturityDate);

if (!validBankResponse) {
  return res.status(400).json({
    error: {
      code: "INVALID_SIMULATED_BANK_RESPONSE",
      message:
        "Bank response must include a non-empty institution, positive amount, and dates in YYYY-MM-DD format.",
    },
    simulated: true,
  });
}

  const request = db.prepare(`
    SELECT requestId, fdrId, status
    FROM bank_confirmation_requests
    WHERE requestId = ?
  `).get(requestId) as
    | { requestId: string; fdrId: string; status: string }
    | undefined;

  if (!request) {
    return res.status(404).json({
      error: {
        code: "CONFIRMATION_REQUEST_NOT_FOUND",
        message: "No confirmation request exists with this request ID.",
      },
      simulated: true,
    });
  }

  if (request.status !== "PENDING") {
    return res.status(409).json({
      error: {
        code: "CONFIRMATION_REQUEST_ALREADY_PROCESSED",
        message: "Only PENDING requests can receive a simulated response.",
      },
      simulated: true,
    });
  }

  const fdr = db.prepare(`
    SELECT id, institution, amount, issueDate, maturityDate
    FROM fdrs
    WHERE id = ?
  `).get(request.fdrId) as
    | {
        id: string;
        institution: string;
        amount: number;
        issueDate: string;
        maturityDate: string;
      }
    | undefined;

  if (!fdr) {
    return res.status(409).json({
      error: {
        code: "REGISTERED_FDR_NOT_FOUND",
        message: "The registered FDR for this request no longer exists.",
      },
      simulated: true,
    });
  }

  const bankReference =
    typeof req.body?.bankReference === "string" &&
    req.body.bankReference.trim().length > 0
      ? req.body.bankReference.trim().slice(0, 200)
      : null;


const normalizedBankResponse = {
  institution: bankResponse.institution.trim(),
  amount: bankResponse.amount,
  issueDate: bankResponse.issueDate,
  maturityDate: bankResponse.maturityDate,
};

const fieldMatches = {
  institution:
    normalizedBankResponse.institution.toLowerCase() ===
    fdr.institution.trim().toLowerCase(),
  amount: normalizedBankResponse.amount === fdr.amount,
  issueDate: normalizedBankResponse.issueDate === fdr.issueDate,
  maturityDate:
    normalizedBankResponse.maturityDate === fdr.maturityDate,
};

const outcome = Object.values(fieldMatches).every(Boolean)
  ? "CONFIRMED"
  : "MISMATCH";

const responseDetails = {
  simulated: true,
  outcome,
  receivedAt: new Date().toISOString(),
  registeredFdr: {
    id: fdr.id,
    institution: fdr.institution,
    amount: fdr.amount,
    issueDate: fdr.issueDate,
    maturityDate: fdr.maturityDate,
  },
  suppliedBankResponse: normalizedBankResponse,
  fieldMatches,
  note:
    "Demo comparison only; this is not evidence received from a real bank.",
};


  try {
    db.exec("BEGIN");

    const update = db.prepare(`
      UPDATE bank_confirmation_requests
      SET status = ?,
          respondedAt = ?,
          outcome = ?,
          bankReference = ?,
          responseDetails = ?
      WHERE requestId = ? AND status = 'PENDING'
    `).run(
      outcome,
      responseDetails.receivedAt,
      outcome,
      bankReference,
      JSON.stringify(responseDetails),
      requestId,
    );

    if (update.changes !== 1) {
      throw new Error("Confirmation request changed before response could be saved.");
    }

    appendAuditEvent(request.fdrId, "SIMULATED_BANK_RESPONSE_RECORDED", {
      requestId,
      outcome,
      bankReference,
      simulated: true,
    });

    db.exec("COMMIT");
  } catch (error) {
    try {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
    } catch (rollbackError) {
      console.error("Database rollback failed:", rollbackError);
    }

    console.error("Simulated bank response failed:", error);
    return res.status(500).json({
      error: {
        code: "SIMULATED_RESPONSE_FAILED",
        message: "Could not record the simulated response.",
      },
      simulated: true,
    });
  }

  return res.json({
    data: {
      requestId,
      fdrId: request.fdrId,
      status: outcome,
      outcome,
      bankReference,
      simulated: true,
      assuranceTierChanged: false,
    },
    simulated: true,
  });
});
function getReleaseEvidence(fdrId: string) {
  const confirmation = db.prepare(`
    SELECT status, respondedAt
    FROM bank_confirmation_requests
    WHERE fdrId = ?
    ORDER BY createdAt DESC
    LIMIT 1
  `).get(fdrId) as {
    status: string;
    respondedAt: string | null;
  } | undefined;

  const now = systemClock();
  let confirmationStatus:
    | "PENDING"
    | "CONFIRMED"
    | "MISMATCH"
    | "UNRESPONSIVE"
    | null = null;
  let confirmedAt: Date | null = null;

  if (confirmation) {
    if (
      confirmation.status === "PENDING" ||
      confirmation.status === "CONFIRMED" ||
      confirmation.status === "MISMATCH" ||
      confirmation.status === "UNRESPONSIVE"
    ) {
      confirmationStatus = confirmation.status;
    }

    if (confirmation.respondedAt) {
      const parsedDate = new Date(confirmation.respondedAt);
      if (Number.isFinite(parsedDate.getTime())) {
        confirmedAt = parsedDate;
      }
    }
  }

  const confirmationFresh =
    confirmationStatus === "CONFIRMED" &&
    confirmedAt !== null &&
    isConfirmationFresh(confirmedAt, now);

  return { confirmationStatus, confirmedAt, now, confirmationFresh };
}

app.post("/api/release-requests", (req, res) => {
  const fdrId =
    typeof req.body?.fdrId === "string" ? req.body.fdrId.trim() : "";
  const makerId =
    typeof req.body?.makerId === "string" ? req.body.makerId.trim() : "";

  if (!fdrId || !makerId) {
    return res.status(400).json({
      error: {
        code: "RELEASE_FIELDS_REQUIRED",
        message: "Provide fdrId and makerId.",
      },
      simulated: true,
    });
  }

  const fdr = db.prepare(
    "SELECT id FROM fdrs WHERE id = ?",
  ).get(fdrId) as { id: string } | undefined;

  if (!fdr) {
    return res.status(404).json({
      error: {
        code: "FDR_NOT_FOUND",
        message: "No registered FDR exists with this ID.",
      },
      simulated: true,
    });
  }

  const evidence = getReleaseEvidence(fdrId);
  const decision = evaluateRelease({
    ...evidence,
    makerId,
    checkerId: `pending-checker-${randomUUID()}`,
  });

  const releaseId = randomUUID();
  const createdAt = evidence.now.toISOString();
  const status = decision.allowed ? "PENDING_CHECKER" : "BLOCKED";

  try {
    db.exec("BEGIN");

    db.prepare(`
      INSERT INTO release_requests (
        releaseId, fdrId, status, makerId, checkerId,
        decisionReason, createdAt, updatedAt, simulated
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 1)
    `).run(
      releaseId,
      fdrId,
      status,
      makerId,
      decision.reason,
      createdAt,
      createdAt,
    );

    appendAuditEvent(fdrId, "RELEASE_REQUEST_EVALUATED", {
      releaseId,
      status,
      reason: decision.reason,
      confirmationStatus: evidence.confirmationStatus,
      confirmationFresh: evidence.confirmationFresh,
      demoIdentity: true,
    });

    db.exec("COMMIT");
  } catch (error) {
    try {
      if (db.isTransaction) db.exec("ROLLBACK");
    } catch (rollbackError) {
      console.error("Release-request rollback failed:", rollbackError);
    }

    console.error("Release-request creation failed:", error);
    return res.status(500).json({
      error: {
        code: "RELEASE_REQUEST_FAILED",
        message: "Could not save the release request.",
      },
      simulated: true,
    });
  }

  return res.status(201).json({
    data: {
      releaseId,
      fdrId,
      status,
      decisionReason: decision.reason,
      confirmationStatus: evidence.confirmationStatus,
      confirmationFresh: evidence.confirmationFresh,
      simulated: true,
      demoIdentities: true,
      note: "Demo decision only; no funds are released.",
    },
    simulated: true,
  });
});

app.post("/api/release-requests/:releaseId/check", (req, res) => {
  const releaseId =
    typeof req.params.releaseId === "string"
      ? req.params.releaseId.trim()
      : "";
  const checkerId =
    typeof req.body?.checkerId === "string"
      ? req.body.checkerId.trim()
      : "";
  const action =
    typeof req.body?.action === "string"
      ? req.body.action.trim().toUpperCase()
      : "";

  if (!releaseId || !checkerId || !["APPROVE", "REJECT"].includes(action)) {
    return res.status(400).json({
      error: {
        code: "CHECK_FIELDS_INVALID",
        message: "Provide checkerId and action: APPROVE or REJECT.",
      },
      simulated: true,
    });
  }

  const request = db.prepare(`
    SELECT releaseId, fdrId, status, makerId
    FROM release_requests
    WHERE releaseId = ?
  `).get(releaseId) as {
    releaseId: string;
    fdrId: string;
    status: string;
    makerId: string;
  } | undefined;

  if (!request) {
    return res.status(404).json({
      error: {
        code: "RELEASE_REQUEST_NOT_FOUND",
        message: "Release request was not found.",
      },
      simulated: true,
    });
  }

  if (request.status !== "PENDING_CHECKER") {
    return res.status(409).json({
      error: {
        code: "RELEASE_REQUEST_NOT_PENDING",
        message: "Only a pending request can be checked.",
      },
      simulated: true,
    });
  }

  if (request.makerId.trim() === checkerId) {
    return res.status(409).json({
      error: {
        code: "MAKER_CHECKER_MUST_DIFFER",
        message: "The maker cannot act as the checker.",
      },
      simulated: true,
    });
  }

  const evidence = getReleaseEvidence(request.fdrId);
  let status: "APPROVED" | "REJECTED" | "BLOCKED";
  let reason: string;

  if (action === "REJECT") {
    status = "REJECTED";
    reason = "CHECKER_REJECTED";
  } else {
    const decision = evaluateRelease({
      ...evidence,
      makerId: request.makerId,
      checkerId,
    });

    if (!decision.allowed) {
      status = "BLOCKED";
      reason = decision.reason;
    } else {
      status = "APPROVED";
      reason = "CHECKER_APPROVED_DEMO";
    }
  }

  const updatedAt = evidence.now.toISOString();

  try {
    db.exec("BEGIN");

    const update = db.prepare(`
      UPDATE release_requests
      SET status = ?, checkerId = ?, decisionReason = ?, updatedAt = ?
      WHERE releaseId = ? AND status = 'PENDING_CHECKER'
    `).run(status, checkerId, reason, updatedAt, releaseId);

    if (Number(update.changes) !== 1) {
      db.exec("ROLLBACK");
      return res.status(409).json({
        error: {
          code: "RELEASE_REQUEST_ALREADY_CHECKED",
          message: "The request is no longer pending.",
        },
        simulated: true,
      });
    }

    appendAuditEvent(request.fdrId, "RELEASE_CHECKED", {
      releaseId,
      status,
      reason,
      checkerId,
      confirmationStatus: evidence.confirmationStatus,
      confirmationFresh: evidence.confirmationFresh,
      demoIdentity: true,
    });

    db.exec("COMMIT");
  } catch (error) {
    try {
      if (db.isTransaction) db.exec("ROLLBACK");
    } catch (rollbackError) {
      console.error("Checker-decision rollback failed:", rollbackError);
    }

    console.error("Checker decision failed:", error);
    return res.status(500).json({
      error: {
        code: "CHECKER_DECISION_FAILED",
        message: "Could not save the checker decision.",
      },
      simulated: true,
    });
  }

  return res.status(200).json({
    data: {
      releaseId,
      fdrId: request.fdrId,
      status,
      decisionReason: reason,
      confirmationStatus: evidence.confirmationStatus,
      confirmationFresh: evidence.confirmationFresh,
      simulated: true,
      demoIdentities: true,
      note: "Demo decision only; no funds are released.",
    },
    simulated: true,
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`FDR Assure API running on port ${PORT}`);
  console.log(`SQLite database: ${databasePath}`);
});
