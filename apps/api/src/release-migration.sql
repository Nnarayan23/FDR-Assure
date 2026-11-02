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
);

CREATE INDEX IF NOT EXISTS idx_release_requests_fdrId
ON release_requests(fdrId);
