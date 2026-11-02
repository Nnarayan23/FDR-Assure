
import { useEffect, useMemo, useState, type FormEvent } from "react";
import "./App.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:3001";

type HealthResponse = {
  status: string;
  service: string;
  simulated: boolean;
};

type FDR = {
  id: string;
  institution: string;
  amount: number;
  issueDate: string;
  maturityDate: string;
  trustTier: "T0" | "T1" | "T2" | "T3";
};

type AuditEvent = {
  eventId: number;
  fdrId: string;
  action: string;
  eventTimestamp: string;
  details: string;
  previousHash: string | null;
  eventHash: string | null;
};

type AuditVerification = {
  valid: boolean;
  checkedEvents?: number;
  failedEventId?: number;
  reason?: string;
  message?: string;
};

type ApiError = {
  error?: { message?: string };
};

type Page = "overview" | "registry" | "register" | "bank" | "release" | "audit";
type BankRequest = {
  requestId: string;
  fdrId: string;
  idempotencyKey: string;
  status: "PENDING" | "CONFIRMED" | "MISMATCH" | "UNRESPONSIVE";
  createdAt: string;
  respondedAt?: string | null;
  outcome?: string | null;
  bankReference?: string | null;
  responseDetails?: string | null;
  simulated: number | boolean;
};

type BankResponseDetails = {
  outcome?: string;
  fieldMatches?: {
    institution: boolean;
    amount: boolean;
    issueDate: boolean;
    maturityDate: boolean;
  };
  note?: string;
};


const money = (amount: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);

const shortDate = (value: string) => {
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
};

const dateTime = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
};

function readEventDetails(details: string): string {
  try {
    return JSON.stringify(JSON.parse(details), null, 2);
  } catch {
    return details;
  }
}

function tierLabel(tier: FDR["trustTier"]) {
  const labels: Record<FDR["trustTier"], string> = {
    T0: "Declared",
    T1: "Consistent",
    T2: "Bank-confirmed",
    T3: "Reconciled",
  };
  return labels[tier];
}

function App() {
  const [page, setPage] = useState<Page>("overview");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [records, setRecords] = useState<FDR[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [verification, setVerification] = useState<AuditVerification | null>(null);
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState("ALL");
  const [id, setId] = useState("");
  const [institution, setInstitution] = useState("");
  const [amount, setAmount] = useState("");
  const [issueDate, setIssueDate] = useState("");
  const [maturityDate, setMaturityDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [bankRequests, setBankRequests] = useState<BankRequest[]>([]);
  const [selectedFdrId, setSelectedFdrId] = useState("");
  const [bankInstitution, setBankInstitution] = useState("");
  const [bankAmount, setBankAmount] = useState("");
  const [bankIssueDate, setBankIssueDate] = useState("");
  const [bankMaturityDate, setBankMaturityDate] = useState("");
  const [bankReference, setBankReference] = useState("");
  const [activeRequestId, setActiveRequestId] = useState("");
  const [bankDetails, setBankDetails] = useState<BankResponseDetails | null>(null);
  const [bankBusy, setBankBusy] = useState(false);
  const [makerId, setMakerId] = useState("maker-demo-01");
  const [checkerId, setCheckerId] = useState("checker-demo-02");
  const [releaseFdrId, setReleaseFdrId] = useState("");
  const [releaseResult, setReleaseResult] = useState<Record<string, unknown> | null>(null);
  const [releaseBusy, setReleaseBusy] = useState(false);

  async function loadBankRequests() {
    const response = await fetch(`${API}/api/bank-confirmation-requests`);
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result?.error?.message || "Could not load bank requests.");
    }
    setBankRequests(result.data ?? []);
  }

  async function createBankRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFdrId) {
      setError("Select an FDR first.");
      return;
    }

    setBankBusy(true);
    setError("");
    setMessage("");

    try {
      const response = await fetch(
        `${API}/api/fdrs/${encodeURIComponent(selectedFdrId)}/bank-confirmation`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            idempotencyKey: `ui-${selectedFdrId}-${Date.now()}`,
          }),
        },
      );
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result?.error?.message || "Could not create bank request.");
      }

      const requestId = result.data?.requestId;
      if (requestId) setActiveRequestId(requestId);

      const selected = records.find((record) => record.id === selectedFdrId);
      if (selected) {
        setBankInstitution(selected.institution);
        setBankAmount(String(selected.amount));
        setBankIssueDate(selected.issueDate);
        setBankMaturityDate(selected.maturityDate);
      }

      await loadBankRequests();
      setMessage("Simulated bank request created. No real bank was contacted.");
      await loadAuditEvents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bank request failed.");
    } finally {
      setBankBusy(false);
    }
  }

  async function submitBankResponse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeRequestId) {
      setError("Create or select a pending bank request first.");
      return;
    }

    setBankBusy(true);
    setError("");
    setMessage("");
    setBankDetails(null);

    try {
      const response = await fetch(
        `${API}/api/bank-confirmation-requests/${encodeURIComponent(activeRequestId)}/respond`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bankReference: bankReference.trim() || undefined,
            bankResponse: {
              institution: bankInstitution,
              amount: Number(bankAmount),
              issueDate: bankIssueDate,
              maturityDate: bankMaturityDate,
            },
          }),
        },
      );
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result?.error?.message || "Could not submit bank response.");
      }

      const details = result.data?.responseDetails;
      if (details) {
        setBankDetails(
          typeof details === "string" ? JSON.parse(details) : details,
        );
      }

      setMessage(
        `Simulated response recorded: ${result.data?.outcome ?? "saved"}. This is not a real bank confirmation.`,
      );
      await Promise.all([loadBankRequests(), loadRecords(), loadAuditEvents()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bank response failed.");
    } finally {
      setBankBusy(false);
    }
  }
  async function submitReleaseRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    setReleaseBusy(true);
    setReleaseResult(null);

    try {
      const response = await fetch(`${API}/api/release-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fdrId: releaseFdrId, makerId }),
      });
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result?.error?.message || "Could not submit release request.");
      }

      setReleaseResult(result.data ?? null);
      setMessage("Release request evaluated. This demo does not release funds.");
      await loadAuditEvents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Release request failed.");
    } finally {
      setReleaseBusy(false);
    }
  }

  async function checkReleaseRequest(action: "APPROVE" | "REJECT") {
    const releaseId = releaseResult?.releaseId;
    if (typeof releaseId !== "string") {
      setError("Submit a release request first.");
      return;
    }

    setError("");
    setMessage("");
    setReleaseBusy(true);

    try {
      const response = await fetch(
        `${API}/api/release-requests/${encodeURIComponent(releaseId)}/check`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ checkerId, action }),
        },
      );
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result?.error?.message || "Checker decision failed.");
      }

      setReleaseResult(result.data ?? null);
      setMessage(`Checker decision recorded: ${action}. No funds were released.`);
      await loadAuditEvents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Checker decision failed.");
    } finally {
      setReleaseBusy(false);
    }
  }
  async function loadRecords() {
    const response = await fetch(`${API}/api/fdrs`);
    if (!response.ok) throw new Error("Could not load FDR records.");
    const result = await response.json();
    setRecords(result.data ?? []);
  }

  async function loadAuditEvents() {
    const response = await fetch(`${API}/api/audit-log`);
    if (!response.ok) throw new Error("Could not load audit events.");
    const result = await response.json();
    setAuditEvents(result.data ?? []);
  }

  async function refreshAll() {
    setError("");
    setLoading(true);
    try {
      const response = await fetch(`${API}/health`);
      if (!response.ok) throw new Error("Backend health check failed.");
      setHealth(await response.json());
      await Promise.all([loadRecords(), loadAuditEvents(), loadBankRequests()]);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not connect to the API.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshAll();
  }, []);

  async function verifyAuditChain() {
    setError("");
    setVerifying(true);
    setVerification(null);
    try {
      const response = await fetch(`${API}/api/audit-log/verify`);
      const result: AuditVerification = await response.json();
      if (!response.ok) {
        throw new Error("The audit-chain verification request failed.");
      }
      setVerification(result);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not verify the audit chain.",
      );
    } finally {
      setVerifying(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setError("Enter a deposit amount greater than zero.");
      return;
    }
    if (maturityDate < issueDate) {
      setError("Maturity date cannot be earlier than the issue date.");
      return;
    }

    setSaving(true);
    try {
      const response = await fetch(`${API}/api/fdrs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          institution,
          amount: numericAmount,
          issueDate,
          maturityDate,
          trustTier: "T0",
        }),
      });

      const result: ApiError = await response.json();
      if (!response.ok) {
        throw new Error(result.error?.message ?? "FDR registration failed.");
      }

      await Promise.all([loadRecords(), loadAuditEvents()]);
      setMessage(`FDR ${id} was registered as T0 â€” Declared.`);
      setId("");
      setInstitution("");
      setAmount("");
      setIssueDate("");
      setMaturityDate("");
      setPage("registry");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "FDR registration failed.",
      );
    } finally {
      setSaving(false);
    }
  }

  const filteredRecords = useMemo(() => {
    const query = search.trim().toLowerCase();
    return records.filter((record) => {
      const matchesQuery =
        !query ||
        record.id.toLowerCase().includes(query) ||
        record.institution.toLowerCase().includes(query);
      const matchesTier =
        tierFilter === "ALL" || record.trustTier === tierFilter;
      return matchesQuery && matchesTier;
    });
  }, [records, search, tierFilter]);

  const totalValue = records.reduce((sum, record) => sum + record.amount, 0);
  const tierCounts = {
    T0: records.filter((record) => record.trustTier === "T0").length,
    T1: records.filter((record) => record.trustTier === "T1").length,
    T2: records.filter((record) => record.trustTier === "T2").length,
    T3: records.filter((record) => record.trustTier === "T3").length,
  };

  const navigation: { id: Page; label: string; icon: string }[] = [
    { id: "overview", label: "Overview", icon: "â—«" },
    { id: "registry", label: "FDR registry", icon: "â–¤" },
    { id: "register", label: "Register FDR", icon: "+" },
    { id: "bank", label: "Bank confirmation", icon: "B" },
    { id: "release", label: "Release review", icon: "R" },
    { id: "audit", label: "Audit & integrity", icon: "â—‡" },
  ];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">F</div>
          <div>
            <div className="brand-name">FDR Assure</div>
            <div className="brand-caption">FINANCIAL ASSURANCE</div>
          </div>
        </div>

        <div className="nav-caption">WORKSPACE</div>
        <nav className="navigation" aria-label="Main navigation">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? "active" : ""}`}
              onClick={() => {
                setPage(item.id);
                setError("");
                setMessage("");
              }}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
              {page === item.id && <span className="nav-indicator" />}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="environment-card">
            <span className="environment-dot" />
            <div>
              <strong>Demo environment</strong>
              <span>No live bank connection</span>
            </div>
          </div>
          <div className="sidebar-footer">
            <span className="footer-shield">âœ“</span>
            <span>Verification before release</span>
          </div>
          <div className="sidebar-version">FDR ASSURE Â· PROTOTYPE</div>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span>
            <span className="breadcrumb-separator">/</span>
            <strong>
              {navigation.find((item) => item.id === page)?.label}
            </strong>
          </div>
          <div className="topbar-actions">
            <span
              className={`connection-pill ${health ? "connected" : "disconnected"}`}
            >
              <span className="connection-dot" />
              {health ? "API connected" : "API unavailable"}
            </span>
            <button
              className="button button-secondary button-small"
              onClick={() => void refreshAll()}
              disabled={loading}
            >
              â†» Refresh
            </button>
          </div>
        </header>

        <main className="workspace">
          <div className="page-heading">
            <div>
              <div className="eyebrow">FIXED DEPOSIT ASSURANCE PLATFORM</div>
              <h1>
                {page === "overview" && "Overview"}
                {page === "registry" && "FDR registry"}
                {page === "register" && "Register an FDR"}
                {page === "bank" && "Bank confirmation"}
                {page === "release" && "Release review"}
                {page === "audit" && "Audit & integrity"}
              </h1>
              <p>
                {page === "overview" &&
                  "Monitor registered deposits, evidence status, and audit integrity."}
                {page === "registry" &&
                  "Search and inspect the fixed deposit records in your workspace."}
                {page === "register" &&
                  "Create a new fixed deposit record with declared evidence."}
                {page === "bank" &&
                  "Create and review clearly labelled simulated bank confirmations."}
                {page === "release" &&
                  "Evaluate release gates and review maker/checker decisions."}
                {page === "audit" &&
                  "Inspect the event history and verify the audit hash chain."}
              </p>
            </div>
            {page !== "register" && (
              <button
                className="button button-primary"
                onClick={() => {
                  setError("");
                  setMessage("");
                  setPage("register");
                }}
              >
                <span className="button-plus">+</span> Register new FDR
              </button>
            )}
          </div>

          <div className="prototype-banner">
            <span className="banner-icon">i</span>
            <div>
              <strong>SIMULATED PROTOTYPE</strong>
              <span>
                Demo data only. Bank confirmation and fund release are not live
                banking operations.
              </span>
            </div>
          </div>

          {error && (
            <div className="alert alert-error" role="alert">
              <strong>Something needs attention</strong>
              <span>{error}</span>
              <button onClick={() => setError("")} aria-label="Dismiss error">
                Ã—
              </button>
            </div>
          )}

          {message && (
            <div className="alert alert-success" role="status">
              <strong>Success</strong>
              <span>{message}</span>
              <button onClick={() => setMessage("")} aria-label="Dismiss message">
                Ã—
              </button>
            </div>
          )}

          {page === "overview" && (
            <>
              <section className="metric-grid">
                <article className="metric-card">
                  <div className="metric-top">
                    <span className="metric-label">Registered FDRs</span>
                    <span className="metric-icon icon-blue">â–¤</span>
                  </div>
                  <div className="metric-value">
                    {loading ? "â€”" : records.length}
                  </div>
                  <div className="metric-foot">Records in the local registry</div>
                </article>
                <article className="metric-card">
                  <div className="metric-top">
                    <span className="metric-label">Total declared value</span>
                    <span className="metric-icon icon-violet">â‚¹</span>
                  </div>
                  <div className="metric-value metric-currency">
                    {loading ? "â€”" : money(totalValue)}
                  </div>
                  <div className="metric-foot">
                    Declared amount, not independently verified
                  </div>
                </article>
                <article className="metric-card">
                  <div className="metric-top">
                    <span className="metric-label">Audit events</span>
                    <span className="metric-icon icon-teal">â—‡</span>
                  </div>
                  <div className="metric-value">
                    {loading ? "â€”" : auditEvents.length}
                  </div>
                  <div className="metric-foot">Recorded events in the ledger</div>
                </article>
                <article className="metric-card">
                  <div className="metric-top">
                    <span className="metric-label">Audit integrity</span>
                    <span className="metric-icon icon-green">âœ“</span>
                  </div>
                  <div className="metric-value metric-status">
                    {verification === null
                      ? "Not checked"
                      : verification.valid
                        ? "Valid"
                        : "Failed"}
                  </div>
                  <div className="metric-foot">Hash-chain check only</div>
                </article>
              </section>

              <section className="content-grid">
                <article className="panel tier-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Assurance distribution</h2>
                      <p>Current recorded trust tiers</p>
                    </div>
                    <span className="subtle-tag">BY RECORD COUNT</span>
                  </div>
                  <div className="tier-list">
                    {(["T0", "T1", "T2", "T3"] as const).map((tier) => {
                      const count = tierCounts[tier];
                      const percent =
                        records.length > 0 ? (count / records.length) * 100 : 0;
                      return (
                        <div className="tier-row" key={tier}>
                          <span className={`tier-badge tier-${tier.toLowerCase()}`}>
                            {tier}
                          </span>
                          <div className="tier-detail">
                            <div className="tier-description">
                              <strong>{tierLabel(tier)}</strong>
                              <span>{count} records</span>
                            </div>
                            <div className="progress-track">
                              <div
                                className={`progress-fill fill-${tier.toLowerCase()}`}
                                style={{ width: `${percent}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="info-note">
                    T1 indicates internal consistency, not authenticity. T2 and
                    T3 require evidence that this prototype does not yet
                    establish as live bank verification.
                  </div>
                </article>

                <article className="panel integrity-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Audit integrity</h2>
                      <p>SHA-256 hash-chain verification</p>
                    </div>
                    <span className="metric-icon icon-green">âœ“</span>
                  </div>
                  <div className="integrity-status">
                    <span
                      className={`integrity-indicator ${
                        verification?.valid === true
                          ? "integrity-good"
                          : verification?.valid === false
                            ? "integrity-bad"
                            : ""
                      }`}
                    />
                    <div>
                      <strong>
                        {verification === null
                          ? "Verification not run"
                          : verification.valid
                            ? "Chain verified"
                            : "Verification failed"}
                      </strong>
                      <span>
                        {verification === null
                          ? "Run a check to inspect ledger integrity."
                          : verification.valid
                            ? `${verification.checkedEvents ?? 0} events checked`
                            : verification.reason ??
                              `Failure at event ${verification.failedEventId ?? "unknown"}`}
                      </span>
                    </div>
                  </div>
                  <button
                    className="button button-primary full-width"
                    onClick={() => void verifyAuditChain()}
                    disabled={verifying}
                  >
                    {verifying ? "Verifyingâ€¦" : "Verify audit chain"}
                  </button>
                  <button
                    className="button button-secondary full-width"
                    onClick={() => setPage("audit")}
                  >
                    Explore audit events
                  </button>
                  <p className="disclaimer">
                    A valid hash chain detects changes to recorded events. It
                    does not prove that a bank confirmed an FDR.
                  </p>
                </article>
              </section>

              <section className="panel table-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Recent FDR records</h2>
                    <p>The latest records returned by the API</p>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => setPage("registry")}
                  >
                    View registry â†’
                  </button>
                </div>
                <FDRTable
                  records={[...records].slice(-5).reverse()}
                  onSelect={() => setPage("registry")}
                />
              </section>
            </>
          )}

          {page === "registry" && (
            <section className="panel table-panel">
              <div className="panel-heading registry-heading">
                <div>
                  <h2>All registered deposits</h2>
                  <p>{records.length} records returned by the API</p>
                </div>
                <span className="subtle-tag">LIVE API DATA</span>
              </div>
              <div className="filter-row">
                <label className="search-box">
                  <span>âŒ•</span>
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search FDR ID or institutionâ€¦"
                    aria-label="Search FDR records"
                  />
                </label>
                <select
                  className="filter-select"
                  value={tierFilter}
                  onChange={(event) => setTierFilter(event.target.value)}
                  aria-label="Filter by trust tier"
                >
                  <option value="ALL">All trust tiers</option>
                  <option value="T0">T0 Â· Declared</option>
                  <option value="T1">T1 Â· Consistent</option>
                  <option value="T2">T2 Â· Bank-confirmed</option>
                  <option value="T3">T3 Â· Reconciled</option>
                </select>
              </div>
              <FDRTable records={filteredRecords} onSelect={() => {}} />
              <div className="table-footer">
                Showing {filteredRecords.length} of {records.length} records.
                Trust-tier labels reflect stored data and are not independent
                proof of authenticity.
              </div>
            </section>
          )}

          {page === "register" && (
            <section className="panel form-panel">
              <div className="form-intro">
                <div className="form-icon">+</div>
                <div>
                  <h2>New fixed deposit record</h2>
                  <p>
                    Start at T0 â€” Declared. Higher tiers must be earned through
                    implemented evidence workflows, not selected manually.
                  </p>
                </div>
              </div>
              <form className="registration-form" onSubmit={handleSubmit}>
                <div className="form-field">
                  <label htmlFor="fdr-id">FDR identifier</label>
                  <input
                    id="fdr-id"
                    value={id}
                    onChange={(event) => setId(event.target.value)}
                    placeholder="e.g. FDR-DEMO-009"
                    required
                  />
                  <span>Use a unique identifier for this record.</span>
                </div>
                <div className="form-field">
                  <label htmlFor="institution">Issuing institution</label>
                  <input
                    id="institution"
                    value={institution}
                    onChange={(event) => setInstitution(event.target.value)}
                    placeholder="e.g. Demo Cooperative Bank"
                    required
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="amount">Principal amount (INR)</label>
                  <div className="input-prefix">
                    <span>â‚¹</span>
                    <input
                      id="amount"
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                      placeholder="250000"
                      required
                    />
                  </div>
                </div>
                <div className="form-field">
                  <label htmlFor="trust-tier">Initial assurance tier</label>
                  <input id="trust-tier" value="T0 â€” Declared" readOnly />
                  <span>Assigned by the backend during registration.</span>
                </div>
                <div className="form-field">
                  <label htmlFor="issue-date">Issue date</label>
                  <input
                    id="issue-date"
                    type="date"
                    value={issueDate}
                    onChange={(event) => setIssueDate(event.target.value)}
                    required
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="maturity-date">Maturity date</label>
                  <input
                    id="maturity-date"
                    type="date"
                    min={issueDate || undefined}
                    value={maturityDate}
                    onChange={(event) => setMaturityDate(event.target.value)}
                    required
                  />
                </div>
                <div className="form-guidance">
                  <span className="guidance-icon">i</span>
                  <div>
                    <strong>Evidence and assurance</strong>
                    <p>
                      This action registers declared information and records an
                      audit event. It does not verify document authenticity or
                      contact a bank.
                    </p>
                  </div>
                </div>
                <div className="form-actions">
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => setPage("registry")}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="button button-primary"
                    disabled={saving}
                  >
                    {saving ? "Registeringâ€¦" : "Register FDR"}
                  </button>
                </div>
              </form>
            </section>
          )}

          {page === "bank" && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Simulated bank confirmation</h2>
                  <p>Compare registered FDR details with a simulated bank response.</p>
                </div>
                <span className="status-pill status-warning">DEMO ONLY</span>
              </div>

              <form className="form-grid" onSubmit={createBankRequest}>
                <label className="field field-full">
                  <span>Select registered FDR</span>
                  <select
                    value={selectedFdrId}
                    onChange={(event) => {
                      const nextId = event.target.value;
                      setSelectedFdrId(nextId);
                      const selected = records.find((record) => record.id === nextId);
                      if (selected) {
                        setBankInstitution(selected.institution);
                        setBankAmount(String(selected.amount));
                        setBankIssueDate(selected.issueDate);
                        setBankMaturityDate(selected.maturityDate);
                      }
                    }}
                    required
                  >
                    <option value="">Choose an FDR…</option>
                    {records.map((record) => (
                      <option key={record.id} value={record.id}>
                        {record.id} — {money(record.amount)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="field field-full">
                  <button type="submit" disabled={bankBusy || !selectedFdrId}>
                    {bankBusy ? "Working…" : "Create confirmation request"}
                  </button>
                </div>
              </form>

              <div className="divider" />

              <div className="panel-heading">
                <div>
                  <h2>Bank console</h2>
                  <p>Submit matching details to simulate a bank's response.</p>
                </div>
              </div>

              <form className="form-grid" onSubmit={submitBankResponse}>
                <label className="field field-full">
                  <span>Pending request</span>
                  <select
                    value={activeRequestId}
                    onChange={(event) => {
                      setActiveRequestId(event.target.value);
                      setBankDetails(null);
                    }}
                    required
                  >
                    <option value="">Select a request…</option>
                    {bankRequests
                      .filter((request) => request.status === "PENDING")
                      .map((request) => (
                        <option key={request.requestId} value={request.requestId}>
                          {request.fdrId} — {request.requestId}
                        </option>
                      ))}
                  </select>
                </label>

                <label className="field">
                  <span>Institution</span>
                  <input value={bankInstitution} onChange={(event) => setBankInstitution(event.target.value)} required />
                </label>
                <label className="field">
                  <span>Amount (?)</span>
                  <input type="number" min="0.01" step="0.01" value={bankAmount} onChange={(event) => setBankAmount(event.target.value)} required />
                </label>
                <label className="field">
                  <span>Issue date</span>
                  <input type="date" value={bankIssueDate} onChange={(event) => setBankIssueDate(event.target.value)} required />
                </label>
                <label className="field">
                  <span>Maturity date</span>
                  <input type="date" value={bankMaturityDate} onChange={(event) => setBankMaturityDate(event.target.value)} required />
                </label>
                <label className="field field-full">
                  <span>Demo bank reference (optional)</span>
                  <input value={bankReference} onChange={(event) => setBankReference(event.target.value)} placeholder="SIM-REF-001" />
                </label>
                <div className="field field-full">
                  <button type="submit" disabled={bankBusy || !activeRequestId}>
                    {bankBusy ? "Submitting…" : "Submit simulated bank response"}
                  </button>
                </div>
              </form>

              {bankDetails && (
                <div className="result-card">
                  <h3>Comparison result: {bankDetails.outcome ?? "Recorded"}</h3>
                  <p>{bankDetails.note ?? "Simulated comparison only; not a real bank confirmation."}</p>
                  {bankDetails.fieldMatches && (
                    <div className="match-grid">
                      {Object.entries(bankDetails.fieldMatches).map(([field, matched]) => (
                        <div className="match-item" key={field}>
                          <span>{field}</span>
                          <strong>{matched ? "MATCH" : "MISMATCH"}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>
          )}
          {page === "release" && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Release assurance review</h2>
                  <p>Evaluate evidence, then route eligible requests to a separate checker.</p>
                </div>
                <span className="status-pill status-warning">SIMULATED</span>
              </div>

              <div className="form-guidance">
                <span className="guidance-icon">i</span>
                <div>
                  <strong>No funds are released by this demo.</strong>
                  <p>Bank confirmation is simulated. Demo IDs are entered by the operator and are not authenticated user accounts.</p>
                </div>
              </div>

              <form className="registration-form" onSubmit={submitReleaseRequest}>
                <div className="form-field">
                  <label htmlFor="release-fdr">Registered FDR</label>
                  <select
                    id="release-fdr"
                    value={releaseFdrId}
                    onChange={(event) => setReleaseFdrId(event.target.value)}
                    required
                  >
                    <option value="">Choose an FDR…</option>
                    {records.map((record) => (
                      <option key={record.id} value={record.id}>
                        {record.id} — {money(record.amount)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-field">
                  <label htmlFor="release-maker">Maker demo ID</label>
                  <input
                    id="release-maker"
                    value={makerId}
                    onChange={(event) => setMakerId(event.target.value)}
                    required
                  />
                  <span>The maker submits the request.</span>
                </div>

                <div className="form-actions">
                  <button
                    type="submit"
                    className="button button-primary"
                    disabled={releaseBusy}
                  >
                    {releaseBusy ? "Evaluating…" : "Evaluate release request"}
                  </button>
                </div>
              </form>

              {releaseResult && (
                <div className="result-card">
                  <h3>Release decision</h3>
                  <div className="match-grid">
                    <div className="match-item">
                      <span>Request ID</span>
                      <strong>{String(releaseResult.releaseId ?? "—")}</strong>
                    </div>
                    <div className="match-item">
                      <span>Status</span>
                      <strong>{String(releaseResult.status ?? "—")}</strong>
                    </div>
                    <div className="match-item">
                      <span>Decision reason</span>
                      <strong>{String(releaseResult.decisionReason ?? "—")}</strong>
                    </div>
                    <div className="match-item">
                      <span>Bank evidence</span>
                      <strong>{String(releaseResult.confirmationStatus ?? "—")}</strong>
                    </div>
                    <div className="match-item">
                      <span>Evidence fresh</span>
                      <strong>{releaseResult.confirmationFresh === true ? "YES" : "NO"}</strong>
                    </div>
                  </div>

                  {releaseResult.status === "PENDING_CHECKER" && (
                    <>
                      <div className="divider" />
                      <h3>Independent checker</h3>
                      <div className="form-field">
                        <label htmlFor="release-checker">Checker demo ID</label>
                        <input
                          id="release-checker"
                          value={checkerId}
                          onChange={(event) => setCheckerId(event.target.value)}
                          required
                        />
                        <span>Must differ from the maker ID. Backend validation applies.</span>
                      </div>
                      <div className="form-actions">
                        <button
                          type="button"
                          className="button button-primary"
                          disabled={releaseBusy}
                          onClick={() => void checkReleaseRequest("APPROVE")}
                        >
                          Approve request
                        </button>
                        <button
                          type="button"
                          className="button button-secondary"
                          disabled={releaseBusy}
                          onClick={() => void checkReleaseRequest("REJECT")}
                        >
                          Reject request
                        </button>
                      </div>
                    </>
                  )}

                  <p className="table-footer">
                    Demo workflow only. Approval records a simulated decision; it does not transfer money or authenticate the operator.
                  </p>
                </div>
              )}
            </section>
          )}
          {page === "audit" && (
            <>
              <section className="audit-summary-grid">
                <article className="metric-card">
                  <div className="metric-label">Recorded events</div>
                  <div className="metric-value">{auditEvents.length}</div>
                  <div className="metric-foot">Loaded from the API</div>
                </article>
                <article className="metric-card">
                  <div className="metric-label">Hash-chain status</div>
                  <div className="metric-value metric-status">
                    {verification === null
                      ? "Not checked"
                      : verification.valid
                        ? "Valid"
                        : "Failed"}
                  </div>
                  <div className="metric-foot">
                    Integrity check, not bank confirmation
                  </div>
                </article>
                <article className="metric-card audit-action-card">
                  <div className="metric-label">Integrity verification</div>
                  <button
                    className="button button-primary"
                    onClick={() => void verifyAuditChain()}
                    disabled={verifying}
                  >
                    {verifying ? "Verifyingâ€¦" : "Verify chain"}
                  </button>
                </article>
              </section>
              {verification && (
                <div
                  className={`verification-result ${
                    verification.valid ? "result-good" : "result-bad"
                  }`}
                >
                  <strong>
                    {verification.valid
                      ? "Audit-chain verification passed"
                      : "Audit-chain verification failed"}
                  </strong>
                  <span>
                    {verification.message ??
                      verification.reason ??
                      `${verification.checkedEvents ?? 0} events checked.`}
                  </span>
                </div>
              )}
              <section className="panel audit-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Event ledger</h2>
                    <p>Newest events are shown first</p>
                  </div>
                  <span className="subtle-tag">APPEND-ONLY DESIGN</span>
                </div>
                {auditEvents.length === 0 ? (
                  <EmptyState
                    title="No audit events found"
                    text="Register an FDR to create the first event."
                  />
                ) : (
                  <div className="audit-list">
                    {[...auditEvents].reverse().map((event) => (
                      <article className="audit-event" key={event.eventId}>
                        <div className="audit-event-marker">â—‡</div>
                        <div className="audit-event-content">
                          <div className="audit-event-top">
                            <div>
                              <strong>{event.action.replaceAll("_", " ")}</strong>
                              <span>
                                Event #{event.eventId} Â· {event.fdrId}
                              </span>
                            </div>
                            <time>{dateTime(event.eventTimestamp)}</time>
                          </div>
                          <details className="audit-details">
                            <summary>Inspect hashes and event details</summary>
                            <div className="hash-field">
                              <span>Previous hash</span>
                              <code>{event.previousHash ?? "Genesis event"}</code>
                            </div>
                            <div className="hash-field">
                              <span>Event hash Â· SHA-256</span>
                              <code>{event.eventHash ?? "Hash missing"}</code>
                            </div>
                            <div className="hash-field">
                              <span>Event details</span>
                              <pre>{readEventDetails(event.details)}</pre>
                            </div>
                          </details>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
              <div className="info-note audit-note">
                Hash-chain verification checks whether recorded events remain
                linked consistently. It cannot independently establish the
                authenticity of an FDR or a bank response.
              </div>
            </>
          )}

          <footer className="workspace-footer">
            <span>FDR Assure Â· Financial document assurance</span>
            <span>Prototype build Â· Simulated data only</span>
          </footer>
        </main>
      </div>
    </div>
  );
}

function FDRTable({
  records,
  onSelect,
}: {
  records: FDR[];
  onSelect: (record: FDR) => void;
}) {
  if (records.length === 0) {
    return (
      <EmptyState
        title="No matching FDR records"
        text="Try a different search or register a new demonstration record."
      />
    );
  }

  return (
    <div className="table-scroll">
      <table className="fdr-table">
        <thead>
          <tr>
            <th>FDR / Institution</th>
            <th>Principal amount</th>
            <th>Issue date</th>
            <th>Maturity date</th>
            <th>Trust tier</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr
              key={record.id}
              onClick={() => onSelect(record)}
              className="table-row-clickable"
            >
              <td>
                <div className="fdr-identity">
                  <span className="fdr-avatar">FD</span>
                  <span>
                    <strong>{record.id}</strong>
                    <small>{record.institution}</small>
                  </span>
                </div>
              </td>
              <td className="amount-cell">{money(record.amount)}</td>
              <td>{shortDate(record.issueDate)}</td>
              <td>{shortDate(record.maturityDate)}</td>
              <td>
                <span className={`tier-badge tier-${record.trustTier.toLowerCase()}`}>
                  {record.trustTier}
                </span>
                <span className="tier-table-label">{tierLabel(record.trustTier)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">â–¤</div>
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}

export default App;
