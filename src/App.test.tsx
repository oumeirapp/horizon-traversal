import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PipelineEvent,
  PipelineSummary,
  SelectionSummary,
} from "./lib/native";
import App from "./App";

const nativeMocks = vi.hoisted(() => ({
  validateSelection: vi.fn(),
  startPipeline: vi.fn(),
  openLastOutput: vi.fn(),
  openDialog: vi.fn(),
}));

vi.mock("./lib/native", () => ({
  validateSelection: nativeMocks.validateSelection,
  startPipeline: nativeMocks.startPipeline,
  openLastOutput: nativeMocks.openLastOutput,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: nativeMocks.openDialog,
}));

const validSelection: SelectionSummary = {
  valid: true,
  inputPath: "/tickets",
  outputPath: "/exports",
  tickets: [
    { name: "P1 Launch", path: "/tickets/P1 Launch" },
    { name: "P2 Brand", path: "/tickets/P2 Brand" },
  ],
  warnings: [],
  issues: [],
};

const partialSummary: PipelineSummary = {
  status: "partialSuccess",
  totalTickets: 1,
  successfulTickets: 0,
  partialTickets: 1,
  failedTickets: 0,
  copiedFiles: 4,
  changedFiles: 2,
  failedFiles: 1,
  warnings: 1,
  errors: 1,
  elapsedMs: 2_500,
  outputPath: "/exports",
};

async function configureValidRun() {
  fireEvent.change(screen.getByLabelText("Input folder"), {
    target: { value: "/tickets" },
  });
  fireEvent.change(screen.getByLabelText("Output folder"), {
    target: { value: "/exports" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(360);
  });
}

describe("X Traversal workbench", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    nativeMocks.validateSelection.mockReset();
    nativeMocks.startPipeline.mockReset();
    nativeMocks.openLastOutput.mockReset();
    nativeMocks.openDialog.mockReset();
    nativeMocks.validateSelection.mockResolvedValue(validSelection);
  });

  it("starts with an accessible, incomplete transfer route", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "X Traversal" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Start processing" })).toBeDisabled();
    expect(screen.getByText("Choose both folders")).toBeVisible();
    expect(screen.getByRole("list", { name: "Processing stages" })).toBeVisible();
    expect(screen.getByRole("tab", { name: /Activity/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("debounces validation and reports the matched ticket count", async () => {
    render(<App />);
    await configureValidRun();

    expect(nativeMocks.validateSelection).toHaveBeenCalledTimes(1);
    expect(nativeMocks.validateSelection).toHaveBeenCalledWith({
      inputPath: "/tickets",
      outputPath: "/exports",
      ticketFilter: "",
    });
    expect(screen.getByText("2 tickets matched")).toBeVisible();
    expect(screen.getByRole("button", { name: "Start processing" })).toBeEnabled();
  });

  it("ignores a stale validation response after the filter changes", async () => {
    const resolvers: Array<(summary: SelectionSummary) => void> = [];
    nativeMocks.validateSelection.mockImplementation(
      () =>
        new Promise<SelectionSummary>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    render(<App />);

    fireEvent.change(screen.getByLabelText("Input folder"), {
      target: { value: "/tickets" },
    });
    fireEvent.change(screen.getByLabelText("Output folder"), {
      target: { value: "/exports" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(360);
    });
    fireEvent.change(screen.getByLabelText("Ticket filter Optional"), {
      target: { value: "P2" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(360);
    });

    await act(async () => {
      resolvers[1]({
        ...validSelection,
        tickets: [validSelection.tickets[1]],
      });
      await Promise.resolve();
    });
    await act(async () => {
      resolvers[0]({
        ...validSelection,
        valid: false,
        tickets: [],
        issues: [
          {
            field: "selection",
            code: "noMatchingTickets",
            message: "No tickets matched the old request.",
          },
        ],
      });
      await Promise.resolve();
    });

    expect(screen.getByText("1 ticket matched")).toBeVisible();
    expect(screen.queryByText("No tickets matched the old request.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start processing" })).toBeEnabled();
  });

  it("uses native directory selection while keeping paths editable", async () => {
    nativeMocks.openDialog.mockResolvedValueOnce("/chosen/tickets");
    render(<App />);

    const chooseButtons = screen.getAllByRole("button", { name: "Choose folder" });
    await act(async () => {
      fireEvent.click(chooseButtons[0]);
      await Promise.resolve();
    });

    expect(nativeMocks.openDialog).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true, multiple: false }),
    );
    expect(screen.getByLabelText("Input folder")).toHaveValue("/chosen/tickets");
  });

  it("reduces streamed events into partial-success controls and filtered logs", async () => {
    const streamed: PipelineEvent[] = [
      { type: "pipelineStarted", totalTickets: 1 },
      { type: "ticketStarted", ticket: "P1 Launch", index: 1, totalTickets: 1 },
      { type: "stageChanged", ticket: "P1 Launch", stage: "images" },
      {
        type: "log",
        ticket: "P1 Launch",
        level: "warning",
        message: "Skipped a large preview",
        path: "/tickets/P1 Launch/preview.mov",
        timestampMs: 1_750_000_000_000,
      },
      {
        type: "log",
        ticket: "P1 Launch",
        level: "error",
        message: "Could not resize one image",
        path: null,
        timestampMs: 1_750_000_000_100,
      },
      {
        type: "ticketCompleted",
        ticket: "P1 Launch",
        status: "partialSuccess",
        copiedFiles: 4,
        changedFiles: 2,
        failedFiles: 1,
        warnings: 1,
        errors: 1,
        elapsedMs: 2_500,
      },
      { type: "pipelineCompleted", summary: partialSummary },
    ];
    nativeMocks.startPipeline.mockImplementation(
      async (_request: unknown, onEvent: (event: PipelineEvent) => void) => {
        streamed.forEach(onEvent);
        return partialSummary;
      },
    );
    nativeMocks.openLastOutput.mockResolvedValue(undefined);
    render(<App />);
    await configureValidRun();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start processing" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      screen.getByRole("heading", { name: "Transfer completed with issues" }),
    ).toBeVisible();
    expect(screen.getByRole("tab", { name: /Warnings 0/ })).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    const warningTab = screen.getByRole("tab", { name: /Warnings 1/ });
    fireEvent.click(warningTab);
    expect(screen.getByText("Skipped a large preview")).toBeVisible();
    expect(screen.queryByText("Could not resize one image")).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open output" }));
      await Promise.resolve();
    });
    expect(nativeMocks.openLastOutput).toHaveBeenCalledOnce();
  });

  it("shows a live stage before resolving a successful run and starts a focused new run", async () => {
    const successSummary: PipelineSummary = {
      ...partialSummary,
      status: "success",
      successfulTickets: 1,
      partialTickets: 0,
      failedFiles: 0,
      warnings: 0,
      errors: 0,
    };
    let resolveRun: (summary: PipelineSummary) => void = () => undefined;
    nativeMocks.startPipeline.mockImplementation(
      (_request: unknown, onEvent: (event: PipelineEvent) => void) => {
        onEvent({ type: "pipelineStarted", totalTickets: 1 });
        onEvent({ type: "ticketStarted", ticket: "P1 Launch", index: 1, totalTickets: 1 });
        onEvent({ type: "stageChanged", ticket: "P1 Launch", stage: "video" });
        return new Promise<PipelineSummary>((resolve) => {
          resolveRun = resolve;
        });
      },
    );
    render(<App />);
    await configureValidRun();

    fireEvent.click(screen.getByRole("button", { name: "Start processing" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(screen.getByRole("button", { name: "Processing…" })).toBeDisabled();
    expect(screen.getByText("Resize video")).toBeVisible();
    expect(screen.getByLabelText("Input folder")).toBeDisabled();

    await act(async () => {
      resolveRun(successSummary);
      await Promise.resolve();
    });
    expect(screen.getByRole("heading", { name: "Transfer complete" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "New run" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByLabelText("Input folder")).toHaveValue("/tickets");
    expect(screen.getByLabelText("Input folder")).toHaveFocus();
  });

  it("keeps unreached stages pending when a ticket fails during discovery", async () => {
    const failedSummary: PipelineSummary = {
      ...partialSummary,
      status: "failed",
      successfulTickets: 0,
      partialTickets: 0,
      failedTickets: 1,
      copiedFiles: 0,
      changedFiles: 0,
      warnings: 0,
      errors: 1,
    };
    nativeMocks.startPipeline.mockImplementation(
      async (_request: unknown, onEvent: (event: PipelineEvent) => void) => {
        onEvent({ type: "pipelineStarted", totalTickets: 1 });
        onEvent({ type: "ticketStarted", ticket: "P1 Launch", index: 1, totalTickets: 1 });
        onEvent({ type: "stageChanged", ticket: "P1 Launch", stage: "discover" });
        onEvent({
          type: "ticketCompleted",
          ticket: "P1 Launch",
          status: "failed",
          copiedFiles: 0,
          changedFiles: 0,
          failedFiles: 0,
          warnings: 0,
          errors: 1,
          elapsedMs: 100,
        });
        return failedSummary;
      },
    );
    render(<App />);
    await configureValidRun();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start processing" }));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(screen.getByRole("heading", { name: "Transfer could not complete" })).toBeVisible();
    expect(screen.getByText("Discover sources: failed")).toBeInTheDocument();
    expect(screen.getByText("Copy assets: pending")).toBeInTheDocument();
    expect(screen.getByText("Write report: pending")).toBeInTheDocument();
  });

  it("supports arrow-key log tabs and restores focus after Escape", async () => {
    render(<App />);
    const activityTab = screen.getByRole("tab", { name: /Activity/ });
    fireEvent.keyDown(activityTab, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /Warnings/ })).toHaveFocus();

    const expand = screen.getByRole("button", { name: "Expand activity log" });
    fireEvent.click(expand);
    const collapse = screen.getByRole("button", { name: "Collapse activity log" });
    expect(collapse).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(window, { key: "Escape" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Expand activity log" })).toHaveFocus();
  });

  it("shows backend validation guidance beside the related field", async () => {
    nativeMocks.validateSelection.mockResolvedValue({
      ...validSelection,
      valid: false,
      tickets: [],
      issues: [
        {
          field: "filter",
          code: "invalidFilter",
          message: "Use P5, a list, or a numeric range.",
        },
      ],
    } satisfies SelectionSummary);
    render(<App />);
    fireEvent.change(screen.getByLabelText("Ticket filter Optional"), {
      target: { value: "nope" },
    });
    await configureValidRun();

    const filter = screen.getByLabelText("Ticket filter Optional");
    expect(filter).toHaveAttribute("aria-invalid", "true");
    expect(within(filter.parentElement as HTMLElement).getByRole("alert")).toHaveTextContent(
      "Use P5, a list, or a numeric range.",
    );
    expect(screen.getByRole("button", { name: "Start processing" })).toBeDisabled();
  });
});
