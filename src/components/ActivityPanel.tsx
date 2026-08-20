import {
  memo,
  useDeferredValue,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Check, Info, Logs, Search, TriangleAlert, X } from "lucide-react";
import type { RunLogEntry } from "../lib/run-state";

type LogTab = "activity" | "warning" | "error";

interface ActivityPanelProps {
  logs: RunLogEntry[];
  heading?: string;
  kicker?: string;
  emptyMessage?: string;
}

const LOG_RENDER_LIMIT = 750;

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function matchesTab(entry: RunLogEntry, tab: LogTab) {
  return tab === "activity" || entry.level === tab;
}

function LogLevelMark({ level }: { level: RunLogEntry["level"] }) {
  return (
    <span className={`log-level log-level--${level}`} aria-label={level}>
      {level === "success" ? (
        <Check size={12} aria-hidden="true" />
      ) : level === "warning" ? (
        <TriangleAlert size={12} aria-hidden="true" />
      ) : level === "error" ? (
        <X size={12} aria-hidden="true" />
      ) : (
        <Info size={12} aria-hidden="true" />
      )}
    </span>
  );
}

function ActivityPanelComponent({
  logs,
  heading = "Activity",
  kicker = "Run record",
  emptyMessage = "Run details will appear here as each asset moves.",
}: ActivityPanelProps) {
  const [tab, setTab] = useState<LogTab>("activity");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const counts = useMemo(() => {
    let warnings = 0;
    let errors = 0;
    for (const entry of logs) {
      if (entry.level === "warning") warnings += 1;
      if (entry.level === "error") errors += 1;
    }
    return { activity: logs.length, warning: warnings, error: errors };
  }, [logs]);

  const { groups, matchingCount } = useMemo(() => {
    const matching: RunLogEntry[] = [];
    for (const entry of logs) {
      if (!matchesTab(entry, tab)) continue;
      if (
        deferredQuery !== "" &&
        !`${entry.level} ${entry.ticket ?? "run"} ${entry.message} ${entry.path ?? ""}`
          .toLocaleLowerCase()
          .includes(deferredQuery)
      ) {
        continue;
      }
      matching.push(entry);
    }

    const grouped = new Map<string, RunLogEntry[]>();
    for (const entry of matching.slice(-LOG_RENDER_LIMIT)) {
      const key = entry.ticket ?? "Run";
      const group = grouped.get(key);
      if (group === undefined) grouped.set(key, [entry]);
      else group.push(entry);
    }
    return { groups: [...grouped.entries()], matchingCount: matching.length };
  }, [deferredQuery, logs, tab]);

  const visibleCount = useMemo(
    () => groups.reduce((total, [, entries]) => total + entries.length, 0),
    [groups],
  );

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const tabs: LogTab[] = ["activity", "warning", "error"];
    const current = tabs.indexOf(tab);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
            tabs.length;
    setTab(tabs[nextIndex]);
    tabRefs.current[nextIndex]?.focus();
  }

  return (
    <section className="activity-panel" aria-labelledby="activity-heading">
      <div className="activity-panel__header">
        <div>
          <p className="section-kicker">{kicker}</p>
          <h2 id="activity-heading">{heading}</h2>
        </div>
        <div className="activity-panel__tools">
          <label className="log-search">
            <span className="sr-only">Search run activity</span>
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search this run"
            />
          </label>
        </div>
      </div>

      <div className="activity-tabs" role="tablist" aria-label="Log level">
        {(["activity", "warning", "error"] as const).map((item, index) => (
          <button
            key={item}
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            type="button"
            role="tab"
            aria-selected={tab === item}
            tabIndex={tab === item ? 0 : -1}
            onClick={() => setTab(item)}
            onKeyDown={handleTabKeyDown}
          >
            {item === "activity"
              ? "Activity"
              : item === "warning"
                ? "Warnings"
                : "Errors"}
            <span>{counts[item].toLocaleString()}</span>
          </button>
        ))}
        <p className="activity-tabs__limit" aria-live="polite">
          {visibleCount.toLocaleString()} shown
          {matchingCount > visibleCount ? ` · newest of ${matchingCount.toLocaleString()}` : ""}
          {" · 10,000 retained"}
        </p>
      </div>

      <div
        className="log-viewport"
        role="tabpanel"
        aria-label={`${tab} log`}
        tabIndex={0}
      >
        {groups.length === 0 ? (
          <div className="log-empty">
            <Logs size={28} aria-hidden="true" />
            <p>
              {logs.length === 0
                ? emptyMessage
                : "No entries match this view."}
            </p>
          </div>
        ) : (
          groups.map(([ticket, entries]) => (
            <section className="log-group" key={ticket}>
              <header>
                <h3>{ticket}</h3>
                <span>{entries.length.toLocaleString()}</span>
              </header>
              <ol>
                {entries.map((entry) => (
                  <li className={`log-entry log-entry--${entry.level}`} key={entry.id}>
                    <time dateTime={new Date(entry.timestampMs).toISOString()}>
                      {timeFormatter.format(entry.timestampMs)}
                    </time>
                    <LogLevelMark level={entry.level} />
                    <div>
                      <p>{entry.message}</p>
                      {entry.path === null ? null : (
                        <div className="log-entry__path">
                          <span>Path</span>
                          <code>{entry.path}</code>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          ))
        )}
      </div>
    </section>
  );
}

export const ActivityPanel = memo(ActivityPanelComponent);
