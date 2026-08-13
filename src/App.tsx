import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type CSSProperties,
  type FormEvent,
  type MutableRefObject,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ActivityPanel } from "./components/ActivityPanel";
import {
  SETTINGS_DIALOG_ID,
  SettingsDialog,
} from "./components/SettingsDialog";
import {
  loadSettings,
  openLastOutput,
  saveSettings,
  startPipeline,
  validateSelection,
  type AppSettings,
  type AppTheme,
  type PipelineEvent,
  type PipelineStage,
  type ProcessingOptions,
  type SelectionRequest,
  type SelectionSummary,
  type ValidationIssue,
} from "./lib/native";
import {
  createInitialRunState,
  runReducer,
  type RunPhase,
  type StageIssueCounts,
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

const DEFAULT_PROCESSING_OPTIONS: ProcessingOptions = {
  pdf: true,
  images: true,
  video: true,
};

function applyTheme(theme: AppTheme) {
  document.documentElement.dataset.theme = theme;
}

const PROCESSING_OPTION_CONTROLS: Array<{
  id: keyof ProcessingOptions;
  label: string;
  detail: string;
  accessibleLabel: string;
}> = [
  {
    id: "pdf",
    label: "PDF",
    detail: "Convert",
    accessibleLabel: "Optimize PDFs",
  },
  {
    id: "images",
    label: "Images",
    detail: "Resize",
    accessibleLabel: "Optimize images",
  },
  {
    id: "video",
    label: "Video",
    detail: "Resize",
    accessibleLabel: "Optimize video",
  },
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

const STAGE_OPTION: Partial<
  Record<PipelineStage, keyof ProcessingOptions>
> = {
  pdf: "pdf",
  images: "images",
  video: "video",
};

function selectedStages(options: ProcessingOptions) {
  return STAGES.filter((stage) => {
    const option = STAGE_OPTION[stage.id];
    return option === undefined || options[option];
  });
}

function requestKey(request: SelectionRequest) {
  const { pdf, images, video } = request.processingOptions;
  return `${request.inputPath}\u0000${request.outputPath}\u0000${request.ticketFilter}\u0000${Number(pdf)}${Number(images)}${Number(video)}`;
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
  const { inputPath, outputPath, ticketFilter, processingOptions } = request;
  const { pdf, images, video } = processingOptions;

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
      void validateSelection({
        inputPath,
        outputPath,
        ticketFilter,
        processingOptions: { pdf, images, video },
      })
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
  }, [images, inputPath, key, outputPath, paused, pdf, ticketFilter, video]);

  return state;
}

function useBatchedEvents(
  dispatch: Dispatch<Parameters<typeof runReducer>[1]>,
  generationRef: MutableRefObject<number>,
) {
  const queueRef = useRef<Array<{ event: PipelineEvent; generation: number }>>([]);
  const frameRef = useRef<{ id: number; animationFrame: boolean } | null>(null);
  const mountedRef = useRef(true);

  const flush = useCallback(
    (generation: number) => {
      const frame = frameRef.current;
      if (frame !== null) {
        if (frame.animationFrame) window.cancelAnimationFrame(frame.id);
        else window.clearTimeout(frame.id);
        frameRef.current = null;
      }

      const events = queueRef.current
        .splice(0)
        .filter(
          (queued) =>
            queued.generation === generation &&
            queued.generation === generationRef.current,
        )
        .map((queued) => queued.event);
      if (mountedRef.current && events.length > 0) {
        dispatch({ type: "events", events });
      }
    },
    [dispatch, generationRef],
  );

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

  const enqueue = useCallback(
    (event: PipelineEvent, generation: number) => {
      queueRef.current.push({ event, generation });
      if (frameRef.current !== null) return;
      if (typeof window.requestAnimationFrame === "function") {
        frameRef.current = {
          id: window.requestAnimationFrame(() => flush(generationRef.current)),
          animationFrame: true,
        };
      } else {
        frameRef.current = {
          id: window.setTimeout(() => flush(generationRef.current), 16),
          animationFrame: false,
        };
      }
    },
    [flush, generationRef],
  );

  return useMemo(() => ({ enqueue, flush }), [enqueue, flush]);
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

function ResetIcon() {
  return (
    <svg
      className="lucide lucide-rotate-ccw"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.42 1.42-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V20h-2v-.08a1.7 1.7 0 0 0-1.1-1.57 1.7 1.7 0 0 0-1.88.34l-.06.06-1.42-1.42.06-.06A1.7 1.7 0 0 0 9.35 15a1.7 1.7 0 0 0-1.56-1.03H7v-2h.08a1.7 1.7 0 0 0 1.57-1.1 1.7 1.7 0 0 0-.34-1.88l-.06-.06 1.42-1.42.06.06a1.7 1.7 0 0 0 1.88.34 1.7 1.7 0 0 0 1.03-1.56V6h2v.08a1.7 1.7 0 0 0 1.1 1.57 1.7 1.7 0 0 0 1.88-.34l.06-.06 1.42 1.42-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.56 1.03H20v2h-.08A1.7 1.7 0 0 0 19.4 15Z" />
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
  stages,
  phase,
  stage,
  ticketStatus,
  failedFiles,
  stageIssues,
}: {
  stages: typeof STAGES;
  phase: RunPhase;
  stage: PipelineStage | null;
  ticketStatus: TicketProgress["status"];
  failedFiles: number;
  stageIssues: StageIssueCounts | null;
}) {
  const activeIndex = stagePosition(stage);
  const recordedErrorCount = stages.reduce((total, item) => {
    const issues = stageIssues?.[item.id];
    return total + (issues?.errors ?? 0);
  }, 0);
  return (
    <ol
      className="asset-route"
      aria-label="Processing stages"
      style={{ "--route-stage-count": stages.length } as CSSProperties}
    >
      {stages.map((item, index) => {
        const stageIndex = stagePosition(item.id);
        const issues = stageIssues?.[item.id];
        const warnings = issues?.warnings ?? 0;
        const errors = issues?.errors ?? 0;
        const issueCount = warnings + errors;
        const current =
          phase === "running" && stageIndex === activeIndex && ticketStatus === null;
        const failed =
          stageIndex === activeIndex &&
          (ticketStatus === "failed" ||
            (phase === "failed" && ticketStatus === null));
        const fallbackPartialIssue =
          ticketStatus === "partialSuccess" &&
          recordedErrorCount === 0 &&
          stageIndex === activeIndex;
        const reached =
          (phase === "success" && ticketStatus === null) ||
          stageIndex < activeIndex ||
          (ticketStatus !== null && stageIndex === activeIndex);
        const state = failed
          ? "failed"
          : errors > 0 || fallbackPartialIssue
            ? "issue"
            : warnings > 0
              ? "warning"
              : reached
                ? "complete"
                : current
                  ? "active"
                  : "pending";
        const issueDescription =
          fallbackPartialIssue
            ? failedFiles > 0
              ? `${failedFiles} failed file${failedFiles === 1 ? "" : "s"}`
              : "errors reported"
            : issueCount === 0
              ? "completed with issues"
              : [
                  warnings > 0
                    ? `${warnings} warning${warnings === 1 ? "" : "s"}`
                    : null,
                  errors > 0
                    ? `${errors} error${errors === 1 ? "" : "s"}`
                    : null,
                ]
                  .filter((description) => description !== null)
                  .join(", ");
        return (
          <li
            className={`asset-route__stop asset-route__stop--${state}${
              state === "issue" && (errors > 0 || fallbackPartialIssue)
                ? " asset-route__stop--issue-error"
                : ""
            }${current ? " asset-route__stop--current" : ""}`}
            key={item.id}
            aria-current={current ? "step" : undefined}
          >
            <span className="asset-route__rail" aria-hidden="true" />
            <span className="asset-route__node" aria-hidden="true">
              {state === "complete" ? (
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                  <path d="m3 8 3 3 7-7" />
                </svg>
              ) : String(index + 1).padStart(2, "0")}
              {issueCount === 0 ? null : (
                <span className="asset-route__issue-count">{issueCount}</span>
              )}
            </span>
            <span className="asset-route__label">{item.short}</span>
            <span className="sr-only">
              {item.label}:{" "}
              {state === "issue" || state === "warning"
                ? issueDescription
                : state}
            </span>
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
      ? summary !== null && summary.warnings > 0
        ? "Files are ready. Warnings remain available in the activity log."
        : "Files are ready in your output folder."
      : phase === "partialSuccess"
        ? "Usable output is ready. Review errors and failed files before delivery."
        : "No ticket completed successfully. Review the error log, then start a new run.");
  const summaryFacts =
    summary === null
      ? []
      : [
          `${summary.totalTickets} ${summary.totalTickets === 1 ? "ticket" : "tickets"} processed`,
          `${summary.errors} ${summary.errors === 1 ? "error" : "errors"}`,
          ...(summary.failedFiles > 0
            ? [
                `${summary.failedFiles} ${summary.failedFiles === 1 ? "failed file" : "failed files"}`,
              ]
            : []),
          ...(summary.warnings > 0
            ? [`${summary.warnings} ${summary.warnings === 1 ? "warning" : "warnings"}`]
            : []),
          formatDuration(summary.elapsedMs),
        ];
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
      <div className="run-result__body">
        <h2 id="result-heading">{title}</h2>
        {summaryFacts.length === 0 ? null : (
          <p className="run-result__summary">{summaryFacts.join(" · ")}</p>
        )}
        <p className="run-result__copy">{copy}</p>
      </div>
      <div className="run-result__actions">
        {summary === null ? null : (
          <button
            type="button"
            className="button button--primary run-result__open"
            onClick={onOpen}
            disabled={opening}
          >
            <FolderIcon /> {opening ? "Opening…" : "Open output"}
          </button>
        )}
        <button type="button" className="run-result__reset" onClick={onReset}>
          <ResetIcon />
          <span>Start another run</span>
        </button>
      </div>
    </section>
  );
}

function App() {
  const [inputPath, setInputPath] = useState("");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsLoadingError, setSettingsLoadingError] = useState<string | null>(null);
  const [settingsSaveError, setSettingsSaveError] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [ticketFilter, setTicketFilter] = useState("");
  const [processingOptions, setProcessingOptions] = useState<ProcessingOptions>(
    DEFAULT_PROCESSING_OPTIONS,
  );
  const [run, dispatch] = useReducer(runReducer, undefined, createInitialRunState);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [openingOutput, setOpeningOutput] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const runGenerationRef = useRef(0);
  const { enqueue: enqueueEvent, flush: flushEvents } = useBatchedEvents(
    dispatch,
    runGenerationRef,
  );
  const outputPath = settings?.defaultOutputPath ?? "";
  const request = useMemo(
    () => ({ inputPath, outputPath, ticketFilter, processingOptions }),
    [inputPath, outputPath, processingOptions, ticketFilter],
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

  const liveTotals = useMemo(() => {
    let completedTickets = 0;
    let copiedFiles = 0;
    let changedFiles = 0;
    let failedFiles = 0;
    let warnings = run.unscopedWarnings;
    let errors = run.unscopedErrors;
    for (const ticket of run.tickets) {
      if (ticket.status !== null) completedTickets += 1;
      copiedFiles += ticket.copiedFiles;
      changedFiles += ticket.changedFiles;
      failedFiles += ticket.failedFiles;
      warnings += ticket.warnings;
      errors += ticket.errors;
    }
    return {
      completedTickets,
      copiedFiles,
      changedFiles,
      failedFiles,
      warnings,
      errors,
    };
  }, [run.tickets, run.unscopedErrors, run.unscopedWarnings]);
  const currentTicketProgress = run.tickets.find(
    (ticket) => ticket.name === run.currentTicket,
  );
  const activeStages = selectedStages(processingOptions);

  useEffect(() => {
    let active = true;
    void loadSettings()
      .then((loaded) => {
        if (!active) return;
        setSettings(loaded);
        setSettingsLoadingError(null);
        applyTheme(loaded.theme);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setSettingsLoadingError(nativeErrorMessage(error));
      });
    return () => {
      active = false;
    };
  }, []);

  async function chooseInputFolder() {
    setDialogError(null);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Choose ticket source",
        defaultPath: inputPath || undefined,
      });
      if (typeof selected === "string") {
        setInputPath(selected);
      }
    } catch (error) {
      setDialogError(nativeErrorMessage(error));
    }
  }

  function openSettings() {
    if (settings === null) return;
    setSettingsSaveError(null);
    setSettingsOpen(true);
  }

  function cancelSettings() {
    if (settings !== null) applyTheme(settings.theme);
    setSettingsSaveError(null);
    setSettingsOpen(false);
  }

  async function persistSettings(nextSettings: AppSettings) {
    setSavingSettings(true);
    setSettingsSaveError(null);
    try {
      const saved = await saveSettings(nextSettings);
      setSettings(saved);
      applyTheme(saved.theme);
      setSettingsOpen(false);
    } catch (error) {
      setSettingsSaveError(nativeErrorMessage(error));
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleStart(event: FormEvent) {
    event.preventDefault();
    if (!canStart) return;
    setOpenError(null);
    const generation = runGenerationRef.current + 1;
    runGenerationRef.current = generation;
    dispatch({ type: "start", startedAt: performance.now() });
    try {
      const result = await startPipeline(request, (pipelineEvent) => {
        if (runGenerationRef.current === generation) {
          enqueueEvent(pipelineEvent, generation);
          if (pipelineEvent.type === "pipelineCompleted") {
            flushEvents(generation);
          }
        }
      });
      if (runGenerationRef.current !== generation) return;
      flushEvents(generation);
      dispatch({ type: "resolved", summary: result, finishedAt: performance.now() });
    } catch (error) {
      if (runGenerationRef.current !== generation) return;
      flushEvents(generation);
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
    queueMicrotask(() => inputRef.current?.focus());
  }

  function setProcessingOption(
    option: keyof ProcessingOptions,
    enabled: boolean,
  ) {
    setProcessingOptions((current) => ({ ...current, [option]: enabled }));
  }

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
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            <img src="/horizon%20traversal%20transparent.png" width="40" height="40" alt="" />
          </span>
          <div>
            <h1>Horizon Traversal</h1>
            <p>Approved asset transfer</p>
          </div>
        </div>
        <div className="app-header__actions">
          <div className={`app-status app-status--${run.phase}`} role="status">
            <span aria-hidden="true" />
            {statusLabel}
          </div>
          <button
            type="button"
            className="settings-trigger"
            onClick={openSettings}
            disabled={settings === null}
            aria-label="Open settings"
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            aria-controls={settingsOpen ? SETTINGS_DIALOG_ID : undefined}
          >
            <SettingsIcon />
          </button>
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
            <div className="field field--full">
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
                <button type="button" onClick={() => void chooseInputFolder()} disabled={configurationLocked}>
                  Choose folder
                </button>
              </div>
              <div id="input-help">
                {inputPath === "" ? <p className="field-message">Required · contains ticket folders</p> : null}
                <FieldIssue issue={inputIssue} />
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
                        : settingsLoadingError !== null
                          ? "Settings unavailable"
                          : settings === null
                            ? "Loading settings…"
                            : outputPath === ""
                              ? "Set a default output folder in Settings"
                              : summary === null
                                ? "Choose an input folder"
                          : `${summary.tickets.length} ticket${summary.tickets.length === 1 ? "" : "s"} matched`}
                  </strong>
                </div>
              </div>
            </div>

            <fieldset className="processing-options" disabled={configurationLocked}>
              <legend className="sr-only">Asset optimization</legend>
              <div className="processing-options__intro">
                <strong>Asset optimization</strong>
                <p id="processing-options-help">Choose formats to optimize after copying.</p>
              </div>
              <div className="processing-options__controls">
                {PROCESSING_OPTION_CONTROLS.map((option) => (
                  <label className="processing-option" key={option.id}>
                    <span className="processing-option__copy">
                      <strong>{option.label}</strong>
                      <small>
                        {processingOptions[option.id] ? option.detail : "Copy only"}
                      </small>
                    </span>
                    <input
                      type="checkbox"
                      checked={processingOptions[option.id]}
                      onChange={(event) =>
                        setProcessingOption(option.id, event.target.checked)
                      }
                      disabled={configurationLocked}
                      aria-label={option.accessibleLabel}
                      aria-describedby="processing-options-help"
                    />
                    <span className="processing-option__switch" aria-hidden="true">
                      <span />
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {dialogError === null ? null : <p className="form-alert" role="alert">{dialogError}</p>}
            {settingsLoadingError === null ? null : (
              <p className="form-alert" role="alert">
                Settings could not be loaded: {settingsLoadingError}
              </p>
            )}
            {currentValidation.error === null ? null : (
              <p className="form-alert" role="alert">{currentValidation.error}</p>
            )}
            {outputIssue === undefined ? null : (
              <p className="form-alert" role="alert">
                {outputIssue.message} Update the default output folder in Settings.
              </p>
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
                      ? "Choose Start another run to prepare another transfer."
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
                  ? `${activeStages.length} selected stages, one ticket at a time.`
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
            stages={activeStages}
            phase={run.phase}
            stage={run.currentStage}
            ticketStatus={currentTicketProgress?.status ?? null}
            failedFiles={currentTicketProgress?.failedFiles ?? 0}
            stageIssues={currentTicketProgress?.stageIssues ?? null}
          />
          <dl className="run-metrics">
            <div>
              <dt>Tickets</dt>
              <dd>
                {run.summary?.totalTickets ?? liveTotals.completedTickets}
                <span>
                  {" / "}
                  {run.totalTickets ||
                    run.summary?.totalTickets ||
                    summary?.tickets.length ||
                    0}
                </span>
              </dd>
            </div>
            <div>
              <dt>Copied</dt>
              <dd>{run.summary?.copiedFiles ?? liveTotals.copiedFiles}</dd>
            </div>
            <div>
              <dt>Optimized</dt>
              <dd>{run.summary?.changedFiles ?? liveTotals.changedFiles}</dd>
            </div>
            <div>
              <dt>Failed files</dt>
              <dd>{run.summary?.failedFiles ?? liveTotals.failedFiles}</dd>
            </div>
            <div>
              <dt>Warnings</dt>
              <dd>{run.summary?.warnings ?? liveTotals.warnings}</dd>
            </div>
            <div>
              <dt>Errors</dt>
              <dd>{run.summary?.errors ?? liveTotals.errors}</dd>
            </div>
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

        <ActivityPanel logs={run.logs} />
      </div>
      {settings === null ? null : (
        <SettingsDialog
          open={settingsOpen}
          settings={settings}
          saving={savingSettings}
          saveError={settingsSaveError}
          onThemePreview={applyTheme}
          onSave={persistSettings}
          onCancel={cancelSettings}
        />
      )}
    </main>
  );
}

export default App;
