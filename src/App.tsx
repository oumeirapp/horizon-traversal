import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type MutableRefObject,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ActivityPanel } from "./components/ActivityPanel";
import {
  openLastOutput,
  startPipeline,
  validateSelection,
  type PipelineEvent,
  type PipelineStage,
  type SelectionRequest,
  type SelectionSummary,
  type ValidationIssue,
} from "./lib/native";
import {
  createInitialRunState,
  runReducer,
  type RunPhase,
  type TicketProgress,
} from "./lib/run-state";
import "./App.css";

const STAGES: Array<{ id: PipelineStage; label: string; short: string }> = [
  { id: "discover", label: "Discover sources", short: "Discover" },
  { id: "copy", label: "Copy assets", short: "Copy" },
  { id: "pdf", label: "Convert PDFs", short: "PDF" },
  { id: "images", label: "Resize images", short: "Images" },
  { id: "video", label: "Resize video", short: "Video" },
  { id: "report", label: "Write report", short: "Report" },
];

interface ValidationState {
  status: "idle" | "pending" | "ready" | "error";
  key: string;
  summary: SelectionSummary | null;
  error: string | null;
}

const initialValidation: ValidationState = {
  status: "idle",
  key: "",
  summary: null,
  error: null,
};

function requestKey(request: SelectionRequest) {
  return `${request.inputPath}\u0000${request.outputPath}\u0000${request.ticketFilter}`;
}

function nativeErrorMessage(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function useSelectionValidation(
  request: SelectionRequest,
  paused: boolean,
): ValidationState {
  const [state, setState] = useState<ValidationState>(initialValidation);
  const versionRef = useRef(0);
  const key = requestKey(request);
  const { inputPath, outputPath, ticketFilter } = request;

  useEffect(() => {
    versionRef.current += 1;
    const version = versionRef.current;
    if (paused) return;

    if (inputPath.trim() === "" || outputPath.trim() === "") {
      setState({ ...initialValidation, key });
      return;
    }

    setState({ status: "pending", key, summary: null, error: null });
    const timer = window.setTimeout(() => {
      void validateSelection({ inputPath, outputPath, ticketFilter })
        .then((summary) => {
          if (versionRef.current !== version) return;
          setState({ status: "ready", key, summary, error: null });
        })
        .catch((error: unknown) => {
          if (versionRef.current !== version) return;
          setState({
            status: "error",
            key,
            summary: null,
            error: nativeErrorMessage(error),
          });
        });
    }, 350);

    return () => window.clearTimeout(timer);
  }, [inputPath, key, outputPath, paused, ticketFilter]);

  return state;
}

function useBatchedEvents(
  dispatch: Dispatch<Parameters<typeof runReducer>[1]>,
  generationRef: MutableRefObject<number>,
) {
  const queueRef = useRef<Array<{ event: PipelineEvent; generation: number }>>([]);
  const frameRef = useRef<{ id: number; animationFrame: boolean } | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const frame = frameRef.current;
      if (frame !== null) {
        if (frame.animationFrame) window.cancelAnimationFrame(frame.id);
        else window.clearTimeout(frame.id);
      }
      frameRef.current = null;
      queueRef.current = [];
    };
  }, []);

  return useCallback(
    (event: PipelineEvent, generation: number) => {
      queueRef.current.push({ event, generation });
      if (frameRef.current !== null) return;
      const flush = () => {
        frameRef.current = null;
        const events = queueRef.current
          .splice(0)
          .filter((queued) => queued.generation === generationRef.current)
          .map((queued) => queued.event);
        if (mountedRef.current && events.length > 0) {
          dispatch({ type: "events", events });
        }
      };
      if (typeof window.requestAnimationFrame === "function") {
        frameRef.current = {
          id: window.requestAnimationFrame(flush),
          animationFrame: true,
        };
      } else {
        frameRef.current = {
          id: window.setTimeout(flush, 16),
          animationFrame: false,
        };
      }
    },
    [dispatch, generationRef],
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M3.5 7.5v10.25A2.25 2.25 0 0 0 5.75 20h12.5a2.25 2.25 0 0 0 2.25-2.25V9.5a2 2 0 0 0-2-2h-6l-2-2h-5a2 2 0 0 0-2 2Z" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M5 12h14M14 7l5 5-5 5" />
    </svg>
  );
}

function FieldIssue({ issue }: { issue: ValidationIssue | undefined }) {
  return issue === undefined ? null : (
    <p className="field-message field-message--error" role="alert">
      {issue.message}
    </p>
  );
}

function stagePosition(stage: PipelineStage | null) {
  return stage === null ? -1 : STAGES.findIndex((item) => item.id === stage);
}

function AssetRoute({
  phase,
  stage,
  ticketStatus,
}: {
  phase: RunPhase;
  stage: PipelineStage | null;
  ticketStatus: TicketProgress["status"];
}) {
  const activeIndex = stagePosition(stage);
  const routeComplete =
    phase === "success" ||
    (phase === "partialSuccess" && stage === "report" && ticketStatus !== "failed");
  return (
    <ol className="asset-route" aria-label="Processing stages">
      {STAGES.map((item, index) => {
        const state = routeComplete
          ? "complete"
          : index < activeIndex
            ? "complete"
            : index === activeIndex
              ? phase === "failed"
                ? "failed"
                : "active"
              : "pending";
        return (
          <li
            className={`asset-route__stop asset-route__stop--${state}`}
            key={item.id}
            aria-current={state === "active" ? "step" : undefined}
          >
            <span className="asset-route__rail" aria-hidden="true" />
            <span className="asset-route__node" aria-hidden="true">
              {state === "complete" ? (
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                  <path d="m3 8 3 3 7-7" />
                </svg>
              ) : String(index + 1).padStart(2, "0")}
            </span>
            <span className="asset-route__label">{item.short}</span>
            <span className="sr-only">{item.label}: {state}</span>
          </li>
        );
      })}
    </ol>
  );
}

function RunClock({
  startedAt,
  finishedAt,
  tickets,
  totalTickets,
}: {
  startedAt: number | null;
  finishedAt: number | null;
  tickets: TicketProgress[];
  totalTickets: number;
}) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (startedAt === null || finishedAt !== null) return;
    const timer = window.setInterval(() => setNow(performance.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [finishedAt, startedAt]);

  const completed = tickets.filter(
    (ticket) => ticket.status !== null && ticket.status !== "failed",
  );
  const finishedCount = tickets.filter((ticket) => ticket.status !== null).length;
  const learnedAverage =
    completed.length === 0
      ? null
      : completed.reduce((total, ticket) => total + ticket.elapsedMs, 0) / completed.length;
  const remaining = Math.max(0, totalTickets - finishedCount);
  const elapsed = startedAt === null ? 0 : (finishedAt ?? now) - startedAt;
  return (
    <div className="run-clock">
      <span><small>Elapsed</small><strong>{formatDuration(elapsed)}</strong></span>
      <span>
        <small>Learned ETA</small>
        <strong>{learnedAverage === null ? "Learning…" : formatDuration(learnedAverage * remaining)}</strong>
      </span>
    </div>
  );
}

function RunResult({
  phase,
  summary,
  fatalError,
  onOpen,
  onReset,
  opening,
}: {
  phase: RunPhase;
  summary: ReturnType<typeof createInitialRunState>["summary"];
  fatalError: string | null;
  onOpen: () => void;
  onReset: () => void;
  opening: boolean;
}) {
  if (phase === "idle" || phase === "running") return null;
  const title =
    phase === "success"
      ? "Transfer complete"
      : phase === "partialSuccess"
        ? "Transfer completed with issues"
        : "Transfer could not complete";
  const copy =
    fatalError ??
    (phase === "success"
      ? "Every selected ticket reached the destination and has a report."
      : phase === "partialSuccess"
        ? "Usable output is ready. Review warnings and errors before delivery."
        : "No ticket completed successfully. Review the error log, then start a new run.");
  return (
    <section className={`run-result run-result--${phase}`} aria-labelledby="result-heading" tabIndex={-1}>
      <div className="run-result__mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="24" height="24">
          {phase === "success" ? (
            <path d="m5 12 4 4L19 6" />
          ) : phase === "partialSuccess" ? (
            <><path d="M12 7v6" /><path d="M12 17h.01" /></>
          ) : (
            <><path d="m7 7 10 10" /><path d="M17 7 7 17" /></>
          )}
        </svg>
      </div>
      <div>
        <p className="section-kicker">Run outcome</p>
        <h2 id="result-heading">{title}</h2>
        <p>{copy}</p>
      </div>
      {summary === null ? null : (
        <dl className="result-totals">
          <div><dt>Tickets</dt><dd>{summary.totalTickets}</dd></div>
          <div><dt>Copied</dt><dd>{summary.copiedFiles}</dd></div>
          <div><dt>Changed</dt><dd>{summary.changedFiles}</dd></div>
          <div><dt>Issues</dt><dd>{summary.warnings + summary.errors}</dd></div>
        </dl>
      )}
      <div className="run-result__actions">
        {summary === null ? null : (
          <button type="button" className="button button--secondary" onClick={onOpen} disabled={opening}>
            <FolderIcon /> {opening ? "Opening…" : "Open output"}
          </button>
        )}
        <button type="button" className="button button--quiet" onClick={onReset}>New run</button>
      </div>
    </section>
  );
}

function App() {
  const [inputPath, setInputPath] = useState("");
  const [outputPath, setOutputPath] = useState("");
  const [ticketFilter, setTicketFilter] = useState("");
  const [run, dispatch] = useReducer(runReducer, undefined, createInitialRunState);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [openingOutput, setOpeningOutput] = useState(false);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const logExpandButtonRef = useRef<HTMLButtonElement>(null);
  const runGenerationRef = useRef(0);
  const enqueueEvent = useBatchedEvents(dispatch, runGenerationRef);
  const request = useMemo(
    () => ({ inputPath, outputPath, ticketFilter }),
    [inputPath, outputPath, ticketFilter],
  );
  const running = run.phase === "running";
  const configurationLocked = run.phase !== "idle";
  const validation = useSelectionValidation(request, configurationLocked);
  const key = requestKey(request);
  const currentValidation = validation.key === key ? validation : initialValidation;
  const summary = currentValidation.summary;
  const issues = summary?.issues ?? [];
  const inputIssue = issues.find((issue) => issue.field === "input");
  const outputIssue = issues.find((issue) => issue.field === "output");
  const filterIssue = issues.find(
    (issue) => issue.field === "filter" || issue.field === "selection",
  );
  const generalIssue = issues.find((issue) => issue.field === "general");
  const canStart =
    run.phase === "idle" &&
    currentValidation.status === "ready" &&
    summary?.valid === true;

  const completedTickets = run.tickets.filter((ticket) => ticket.status !== null).length;
  const liveCopied = run.tickets.reduce((total, ticket) => total + ticket.copiedFiles, 0);
  const liveChanged = run.tickets.reduce((total, ticket) => total + ticket.changedFiles, 0);
  const liveIssues = run.tickets.reduce(
    (total, ticket) => total + ticket.warnings + ticket.errors,
    0,
  );
  const currentTicketProgress = run.tickets.find(
    (ticket) => ticket.name === run.currentTicket,
  );

  useEffect(() => {
    if (!logsExpanded) return;
    function closeExpandedLog(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setLogsExpanded(false);
      queueMicrotask(() => logExpandButtonRef.current?.focus());
    }
    window.addEventListener("keydown", closeExpandedLog);
    return () => window.removeEventListener("keydown", closeExpandedLog);
  }, [logsExpanded]);

  async function chooseFolder(kind: "input" | "output") {
    setDialogError(null);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: kind === "input" ? "Choose ticket source" : "Choose transfer destination",
        defaultPath: (kind === "input" ? inputPath : outputPath) || undefined,
      });
      if (typeof selected === "string") {
        if (kind === "input") setInputPath(selected);
        else setOutputPath(selected);
      }
    } catch (error) {
      setDialogError(nativeErrorMessage(error));
    }
  }

  async function handleStart(event: FormEvent) {
    event.preventDefault();
    if (!canStart) return;
    setOpenError(null);
    setLogsExpanded(false);
    const generation = runGenerationRef.current + 1;
    runGenerationRef.current = generation;
    dispatch({ type: "start", startedAt: performance.now() });
    try {
      const result = await startPipeline(request, (pipelineEvent) => {
        if (runGenerationRef.current === generation) {
          enqueueEvent(pipelineEvent, generation);
        }
      });
      if (runGenerationRef.current !== generation) return;
      dispatch({ type: "resolved", summary: result, finishedAt: performance.now() });
    } catch (error) {
      if (runGenerationRef.current !== generation) return;
      dispatch({
        type: "rejected",
        message: nativeErrorMessage(error),
        finishedAt: performance.now(),
      });
    }
  }

  async function handleOpenOutput() {
    setOpenError(null);
    setOpeningOutput(true);
    try {
      await openLastOutput();
    } catch (error) {
      setOpenError(nativeErrorMessage(error));
    } finally {
      setOpeningOutput(false);
    }
  }

  function handleNewRun() {
    runGenerationRef.current += 1;
    dispatch({ type: "reset" });
    setOpenError(null);
    setLogsExpanded(false);
    queueMicrotask(() => inputRef.current?.focus());
  }

  const toggleLogs = useCallback(() => setLogsExpanded((expanded) => !expanded), []);
  const statusLabel =
    run.phase === "running"
      ? "Transfer in progress"
      : run.phase === "success"
        ? "Complete"
        : run.phase === "partialSuccess"
          ? "Review issues"
          : run.phase === "failed"
            ? "Run failed"
            : summary?.valid
              ? "Ready to transfer"
              : "Set up transfer";
  const runAnnouncement =
    run.phase === "running"
      ? `${run.currentTicket ?? "Preparing tickets"}. ${
          run.currentStage === null
            ? "Waiting for the next stage"
            : STAGES.find((stage) => stage.id === run.currentStage)?.label
        }.`
      : run.phase === "success"
        ? "Transfer complete."
        : run.phase === "partialSuccess"
          ? "Transfer completed with issues."
          : run.phase === "failed"
            ? "Transfer failed."
            : statusLabel;

  return (
    <main className={`app-shell${logsExpanded ? " app-shell--logs-expanded" : ""}`}>
      <header className="app-header">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            <img src="/horizon%20traversal.png" width="40" height="40" alt="" />
          </span>
          <div>
            <h1>X Traversal</h1>
            <p>Approved asset transfer</p>
          </div>
        </div>
        <div className={`app-status app-status--${run.phase}`} role="status">
          <span aria-hidden="true" />
          {statusLabel}
        </div>
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {runAnnouncement}
        </p>
      </header>

      <div className="workspace">
        <section className="setup-card" aria-labelledby="setup-heading">
          <div className="section-heading">
            <div>
              <p className="section-kicker">01 · Configure</p>
              <h2 id="setup-heading">Choose the transfer route</h2>
            </div>
            <p>Folders stay on this device.</p>
          </div>
          <form onSubmit={handleStart} noValidate>
            <div className="field">
              <label htmlFor="input-path">Input folder</label>
              <div className={`path-control${inputIssue ? " path-control--invalid" : ""}`}>
                <FolderIcon />
                <input
                  ref={inputRef}
                  id="input-path"
                  value={inputPath}
                  onChange={(event) => setInputPath(event.target.value)}
                  placeholder="Path to ticket folders"
                  disabled={configurationLocked}
                  aria-invalid={inputIssue !== undefined}
                  aria-describedby="input-help"
                />
                <button type="button" onClick={() => void chooseFolder("input")} disabled={configurationLocked}>
                  Choose folder
                </button>
              </div>
              <div id="input-help">
                {inputPath === "" ? <p className="field-message">Required · contains ticket folders</p> : null}
                <FieldIssue issue={inputIssue} />
              </div>
            </div>

            <div className="field">
              <label htmlFor="output-path">Output folder</label>
              <div className={`path-control${outputIssue ? " path-control--invalid" : ""}`}>
                <FolderIcon />
                <input
                  id="output-path"
                  value={outputPath}
                  onChange={(event) => setOutputPath(event.target.value)}
                  placeholder="Path for collected assets"
                  disabled={configurationLocked}
                  aria-invalid={outputIssue !== undefined}
                  aria-describedby="output-help"
                />
                <button type="button" onClick={() => void chooseFolder("output")} disabled={configurationLocked}>
                  Choose folder
                </button>
              </div>
              <div id="output-help">
                {outputPath === "" ? <p className="field-message">Required · must not overlap the input</p> : null}
                <FieldIssue issue={outputIssue} />
              </div>
            </div>

            <div className="filter-row">
              <div className="field">
                <label htmlFor="ticket-filter">Ticket filter <span>Optional</span></label>
                <input
                  id="ticket-filter"
                  className={filterIssue ? "text-input text-input--invalid" : "text-input"}
                  value={ticketFilter}
                  onChange={(event) => setTicketFilter(event.target.value)}
                  placeholder="All immediate ticket folders"
                  disabled={configurationLocked}
                  aria-invalid={filterIssue !== undefined}
                  aria-describedby="filter-help"
                />
                <div id="filter-help">
                  <p className="field-message">Examples: P5 · P1-P4 · P8, P12-P10</p>
                  <FieldIssue issue={filterIssue} />
                </div>
              </div>
              <div className="match-readout" aria-live="polite">
                <span className={`match-readout__signal${summary?.valid ? " is-ready" : ""}`} aria-hidden="true" />
                <div>
                  <small>Live selection</small>
                  <strong>
                    {currentValidation.status === "pending"
                      ? "Checking tickets…"
                      : currentValidation.status === "error"
                        ? "Validation unavailable"
                        : summary === null
                          ? "Choose both folders"
                          : `${summary.tickets.length} ticket${summary.tickets.length === 1 ? "" : "s"} matched`}
                  </strong>
                </div>
              </div>
            </div>

            {dialogError === null ? null : <p className="form-alert" role="alert">{dialogError}</p>}
            {currentValidation.error === null ? null : (
              <p className="form-alert" role="alert">{currentValidation.error}</p>
            )}
            <FieldIssue issue={generalIssue} />
            {summary?.warnings.map((warning) => (
              <p className="form-warning" key={warning}>{warning}</p>
            ))}

            <div className="start-row">
              <button
                type="submit"
                className="button button--primary"
                disabled={!canStart}
              >
                <span>{running ? "Processing…" : "Start processing"}</span>
                <ArrowIcon />
              </button>
              <p>
                {canStart
                  ? "Ready. Existing ticket outputs will be replaced safely."
                  : running
                    ? "Keep this window open while assets move."
                    : configurationLocked
                      ? "Choose New run to prepare another transfer."
                      : "A valid route is required before processing."}
              </p>
            </div>
          </form>
        </section>

        <section className="run-card" aria-labelledby="run-heading">
          <div className="run-card__heading">
            <div>
              <p className="section-kicker">02 · Process</p>
              <h2 id="run-heading">
                {run.currentTicket ?? (run.phase === "idle" ? "Asset route" : "Preparing tickets")}
              </h2>
              <p>
                {run.phase === "idle"
                  ? "Six deterministic stages, one ticket at a time."
                  : run.currentStage === null
                    ? "Preparing the next ticket"
                    : STAGES.find((stage) => stage.id === run.currentStage)?.label}
              </p>
            </div>
            <RunClock
              startedAt={run.startedAt}
              finishedAt={run.finishedAt}
              tickets={run.tickets}
              totalTickets={run.totalTickets}
            />
          </div>

          <AssetRoute
            phase={run.phase}
            stage={run.currentStage}
            ticketStatus={currentTicketProgress?.status ?? null}
          />
          <dl className="run-metrics">
            <div><dt>Tickets</dt><dd>{completedTickets}<span> / {run.totalTickets || summary?.tickets.length || 0}</span></dd></div>
            <div><dt>Copied</dt><dd>{run.summary?.copiedFiles ?? liveCopied}</dd></div>
            <div><dt>Optimized</dt><dd>{run.summary?.changedFiles ?? liveChanged}</dd></div>
            <div><dt>Issues</dt><dd>{run.summary === null ? liveIssues : run.summary.warnings + run.summary.errors}</dd></div>
          </dl>
        </section>

        <RunResult
          phase={run.phase}
          summary={run.summary}
          fatalError={run.fatalError}
          onOpen={() => void handleOpenOutput()}
          onReset={handleNewRun}
          opening={openingOutput}
        />
        {openError === null ? null : <p className="form-alert output-alert" role="alert">{openError}</p>}

        <ActivityPanel
          logs={run.logs}
          isExpanded={logsExpanded}
          onToggleExpanded={toggleLogs}
          toggleButtonRef={logExpandButtonRef}
        />
      </div>
    </main>
  );
}

export default App;
