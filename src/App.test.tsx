import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppSettings,
  PipelineEvent,
  PipelineSummary,
  SelectionSummary,
} from "./lib/native";
import App from "./App";

const nativeMocks = vi.hoisted(() => ({
  validateSelection: vi.fn(),
  startPipeline: vi.fn(),
  openLastOutput: vi.fn(),
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  openDialog: vi.fn(),
}));

vi.mock("./lib/native", () => ({
  validateSelection: nativeMocks.validateSelection,
  startPipeline: nativeMocks.startPipeline,
  openLastOutput: nativeMocks.openLastOutput,
  loadSettings: nativeMocks.loadSettings,
  saveSettings: nativeMocks.saveSettings,
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

const warningOnlySummary: PipelineSummary = {
  ...partialSummary,
  failedFiles: 0,
  errors: 0,
};

const defaultSettings: AppSettings = {
  defaultOutputPath: "/exports",
  powerpointOutputPath: "/powerpoint-exports",
  theme: "dark",
};

async function settleSettings() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function configureValidRun() {
  await settleSettings();
  fireEvent.change(screen.getByLabelText("Input folder"), {
    target: { value: "/tickets" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(360);
  });
}

describe("Horizon Traversal workbench", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    nativeMocks.validateSelection.mockReset();
    nativeMocks.startPipeline.mockReset();
    nativeMocks.openLastOutput.mockReset();
    nativeMocks.loadSettings.mockReset();
    nativeMocks.saveSettings.mockReset();
    nativeMocks.openDialog.mockReset();
    nativeMocks.validateSelection.mockResolvedValue(validSelection);
    nativeMocks.loadSettings.mockResolvedValue(defaultSettings);
    nativeMocks.saveSettings.mockImplementation(async (settings: AppSettings) => settings);
    document.documentElement.dataset.theme = "dark";
  });

  it("starts with an accessible, incomplete transfer route", async () => {
    render(<App />);
    await settleSettings();

    expect(
      screen.getByRole("heading", { name: "Horizon Traversal" }),
    ).toBeVisible();
    expect(
      screen.getByRole("tab", { name: /Asset processing/ }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("tab", { name: /PowerPoint only/ }),
    ).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("button", { name: "Start processing" })).toBeDisabled();
    expect(screen.getByText("Choose an input folder")).toBeVisible();
    expect(screen.queryByLabelText("Output folder")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Input folder").closest(".field")).toHaveClass(
      "field--full",
    );
    const route = screen.getByRole("list", { name: "Processing stages" });
    expect(route).toBeVisible();
    expect(within(route).getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByRole("checkbox", { name: "Optimize PDFs" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Optimize images" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Optimize video" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Create PPTX" })).not.toBeChecked();
    expect(
      screen.getByRole("group", { name: "Processing steps" }),
    ).toBeVisible();
    expect(screen.getByText("Processed")).toBeVisible();
    expect(screen.getByRole("tab", { name: /Activity/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("uses Radix workflow tabs and keeps independent input folders", async () => {
    render(<App />);
    await settleSettings();

    const assetTab = screen.getByRole("tab", { name: /Asset processing/ });
    const powerpointTab = screen.getByRole("tab", { name: /PowerPoint only/ });
    fireEvent.change(screen.getByLabelText("Input folder"), {
      target: { value: "/asset-tickets" },
    });

    const workflowTabs = screen.getByRole("tablist", { name: "Workflow mode" });
    workflowTabs.focus();
    fireEvent.focus(workflowTabs);
    expect(assetTab).toHaveFocus();
    await act(async () => {
      fireEvent.keyDown(assetTab, { key: "ArrowRight" });
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(powerpointTab).toHaveFocus();
    expect(powerpointTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("PowerPoint preview")).toBeVisible();
    expect(
      screen.queryByLabelText("Ticket filter Optional"),
    ).not.toBeInTheDocument();

    nativeMocks.openDialog.mockResolvedValueOnce("/powerpoint-tickets");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
      await Promise.resolve();
    });
    expect(nativeMocks.openDialog).toHaveBeenLastCalledWith({
      directory: true,
      multiple: false,
      title: "Choose PowerPoint ticket source",
      defaultPath: undefined,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(360);
    });

    expect(nativeMocks.validateSelection).toHaveBeenLastCalledWith({
      inputPath: "/powerpoint-tickets",
      outputPath: "/powerpoint-exports",
      ticketFilter: "",
      processingOptions: {
        pdf: false,
        images: false,
        video: false,
      },
    });
    expect(screen.queryByText("Slide plan")).not.toBeInTheDocument();
    expect(screen.queryByText(/planned slides?/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "P1 Launch" })).toBeVisible();
    expect(screen.getByText("Slide 1 of 2 · Preview")).toBeVisible();
    expect(
      screen.getByRole("list", { name: "PowerPoint creation stages" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "PowerPoint activity" }),
    ).toBeVisible();
    expect(
      screen.getByText(/Ticket and slide activity will appear here/),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Create PowerPoint" })).toBeDisabled();
    expect(nativeMocks.startPipeline).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(powerpointTab, { key: "ArrowLeft" });
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(assetTab).toHaveFocus();
    expect(assetTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Input folder")).toHaveValue("/asset-tickets");
  });

  it("keeps an invalid PowerPoint source in the non-generating preview", async () => {
    nativeMocks.validateSelection.mockResolvedValue({
      ...validSelection,
      valid: false,
      tickets: [],
      issues: [
        {
          field: "selection",
          code: "noTickets",
          message: "No immediate ticket folders were found.",
        },
      ],
    } satisfies SelectionSummary);
    render(<App />);
    await settleSettings();

    const workflowTabs = screen.getByRole("tablist", { name: "Workflow mode" });
    const assetTab = screen.getByRole("tab", { name: /Asset processing/ });
    workflowTabs.focus();
    fireEvent.focus(workflowTabs);
    await act(async () => {
      fireEvent.keyDown(assetTab, { key: "ArrowRight" });
      await vi.advanceTimersByTimeAsync(1);
    });
    fireEvent.change(screen.getByLabelText("Root folder"), {
      target: { value: "/empty-root" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(360);
    });

    expect(screen.getByLabelText("Root folder")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByText("No immediate ticket folders were found.")).toBeVisible();
    expect(screen.queryByText("Slide plan")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ticket preview" })).toBeVisible();
    expect(screen.queryByText(/Slide 1 of/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create PowerPoint" })).toBeDisabled();
    expect(nativeMocks.startPipeline).not.toHaveBeenCalled();
  });

  it("previews frontend-only PPTX without changing the native request", async () => {
    const successSummary: PipelineSummary = {
      ...partialSummary,
      status: "success",
      successfulTickets: 1,
      partialTickets: 0,
      failedFiles: 0,
      warnings: 0,
      errors: 0,
    };
    nativeMocks.startPipeline.mockResolvedValue(successSummary);
    render(<App />);
    await settleSettings();

    const pptxOption = screen.getByRole("checkbox", { name: "Create PPTX" });
    fireEvent.click(pptxOption);

    expect(pptxOption).toBeChecked();
    expect(
      screen.getByText(/PPTX is not available yet/),
    ).toBeVisible();
    const route = screen.getByRole("list", { name: "Processing stages" });
    expect(within(route).getAllByRole("listitem")).toHaveLength(7);
    const powerpointStage = within(route).getByText("PowerPoint").closest("li");
    expect(powerpointStage).toHaveClass("asset-route__stop--warning");

    await configureValidRun();
    const expectedRequest = {
      inputPath: "/tickets",
      outputPath: "/exports",
      ticketFilter: "",
      processingOptions: {
        pdf: true,
        images: true,
        video: true,
      },
    };
    expect(nativeMocks.validateSelection).toHaveBeenLastCalledWith(expectedRequest);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start processing" }));
      await Promise.resolve();
    });

    expect(nativeMocks.startPipeline).toHaveBeenCalledWith(
      expectedRequest,
      expect.any(Function),
    );
    expect(powerpointStage).toHaveClass("asset-route__stop--warning");
    expect(powerpointStage).not.toHaveClass("asset-route__stop--complete");
    const assetTab = screen.getByRole("tab", { name: /Asset processing/ });
    const powerpointTab = screen.getByRole("tab", { name: /PowerPoint only/ });
    expect(assetTab).toBeEnabled();
    expect(powerpointTab).toBeDisabled();
    fireEvent.keyDown(assetTab, { key: "ArrowRight" });
    expect(assetTab).toHaveAttribute("aria-selected", "true");
  });

  it("previews appearance changes and restores the saved theme on cancel", async () => {
    render(<App />);
    await settleSettings();

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "Asset output folder" }),
    ).toHaveValue("/exports");

    fireEvent.click(screen.getByRole("radio", { name: /^Light/ }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(nativeMocks.saveSettings).not.toHaveBeenCalled();
  });

  it("applies the saved appearance when settings load", async () => {
    nativeMocks.loadSettings.mockResolvedValueOnce({
      ...defaultSettings,
      theme: "light",
    });

    render(<App />);
    await settleSettings();

    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });

  it("saves the selected theme and asset output folder", async () => {
    nativeMocks.openDialog.mockResolvedValueOnce("/new-exports");
    render(<App />);
    await settleSettings();

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    fireEvent.click(screen.getByRole("radio", { name: /^Light/ }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Choose asset output folder" }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await Promise.resolve();
    });

    expect(nativeMocks.saveSettings).toHaveBeenCalledWith({
      defaultOutputPath: "/new-exports",
      powerpointOutputPath: "/powerpoint-exports",
      theme: "light",
    });
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Input folder"), {
      target: { value: "/tickets" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(360);
    });
    expect(nativeMocks.validateSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({ outputPath: "/new-exports" }),
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
      processingOptions: {
        pdf: true,
        images: true,
        video: true,
      },
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

    await settleSettings();

    fireEvent.change(screen.getByLabelText("Input folder"), {
      target: { value: "/tickets" },
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

  it("sends the selected optimization options and locks them during the run", async () => {
    nativeMocks.startPipeline.mockImplementation(
      () => new Promise<PipelineSummary>(() => undefined),
    );
    render(<App />);

    const pdfOption = screen.getByRole("checkbox", { name: "Optimize PDFs" });
    const imageOption = screen.getByRole("checkbox", { name: "Optimize images" });
    const videoOption = screen.getByRole("checkbox", { name: "Optimize video" });
    fireEvent.click(pdfOption);
    fireEvent.click(videoOption);

    expect(pdfOption).not.toBeChecked();
    expect(imageOption).toBeChecked();
    expect(videoOption).not.toBeChecked();
    const route = screen.getByRole("list", { name: "Processing stages" });
    expect(within(route).queryByText("PDF")).not.toBeInTheDocument();
    expect(within(route).getByText("Images")).toBeVisible();
    expect(within(route).queryByText("Video")).not.toBeInTheDocument();
    expect(within(route).getAllByRole("listitem")).toHaveLength(4);
    expect(
      screen.getByText("4 selected stages, one ticket at a time."),
    ).toBeVisible();

    await configureValidRun();

    const expectedRequest = {
      inputPath: "/tickets",
      outputPath: "/exports",
      ticketFilter: "",
      processingOptions: {
        pdf: false,
        images: true,
        video: false,
      },
    };
    expect(nativeMocks.validateSelection).toHaveBeenLastCalledWith(expectedRequest);

    fireEvent.click(screen.getByRole("button", { name: "Start processing" }));

    expect(nativeMocks.startPipeline).toHaveBeenCalledWith(
      expectedRequest,
      expect.any(Function),
    );
    expect(pdfOption).toBeDisabled();
    expect(imageOption).toBeDisabled();
    expect(videoOption).toBeDisabled();
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
    const warningTab = screen.getByRole("tab", { name: /Warnings 1/ });
    expect(screen.getByText("Resize images: 1 warning, 1 error")).toBeVisible();
    const imageStage = screen.getByText("Resize images: 1 warning, 1 error").closest("li");
    expect(imageStage).toHaveClass(
      "asset-route__stop--issue",
      "asset-route__stop--issue-error",
    );

    const result = screen.getByRole("region", {
      name: "Transfer completed with issues",
    });
    expect(result).toHaveTextContent(
      "1 ticket processed · 1 error · 1 failed file · 1 warning · 00:02",
    );
    expect(within(result).queryByText("Successful tickets")).not.toBeInTheDocument();

    fireEvent.click(warningTab);
    expect(screen.getByText("Skipped a large preview")).toBeVisible();
    expect(screen.queryByText("Could not resize one image")).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open output" }));
      await Promise.resolve();
    });
    expect(nativeMocks.openLastOutput).toHaveBeenCalledOnce();
  });

  it("displays a warning-only backend partial result as successful", async () => {
    const streamed: PipelineEvent[] = [
      { type: "pipelineStarted", totalTickets: 1 },
      { type: "ticketStarted", ticket: "P1 Launch", index: 1, totalTickets: 1 },
      { type: "stageChanged", ticket: "P1 Launch", stage: "images" },
      {
        type: "log",
        ticket: "P1 Launch",
        level: "warning",
        message: "Skipped an unsupported preview",
        path: null,
        timestampMs: 1_750_000_000_000,
      },
      { type: "stageChanged", ticket: "P1 Launch", stage: "report" },
      {
        type: "ticketCompleted",
        ticket: "P1 Launch",
        status: "partialSuccess",
        copiedFiles: 4,
        changedFiles: 2,
        failedFiles: 0,
        warnings: 1,
        errors: 0,
        elapsedMs: 2_500,
      },
      { type: "pipelineCompleted", summary: warningOnlySummary },
    ];
    nativeMocks.startPipeline.mockImplementation(
      async (_request: unknown, onEvent: (event: PipelineEvent) => void) => {
        streamed.forEach(onEvent);
        return warningOnlySummary;
      },
    );
    render(<App />);
    await configureValidRun();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start processing" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const result = screen.getByRole("region", { name: "Transfer complete" });
    expect(
      screen.queryByRole("heading", { name: "Transfer completed with issues" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Complete");
    expect(
      screen.getByText(
        "Files are ready. Warnings remain available in the activity log.",
      ),
    ).toBeVisible();
    expect(result).toHaveTextContent(
      "1 ticket processed · 0 errors · 1 warning · 00:02",
    );
    expect(screen.getByText("Resize images: 1 warning").closest("li")).toHaveClass(
      "asset-route__stop--warning",
    );
    expect(
      screen.getByText("Resize images: 1 warning").closest("li"),
    ).not.toHaveClass(
      "asset-route__stop--issue",
      "asset-route__stop--issue-error",
    );
  });

  it("shows batched warning counts on the active stage while a run is live", async () => {
    nativeMocks.startPipeline.mockImplementation(
      (_request: unknown, onEvent: (event: PipelineEvent) => void) => {
        onEvent({ type: "pipelineStarted", totalTickets: 1 });
        onEvent({
          type: "ticketStarted",
          ticket: "P1 Launch",
          index: 1,
          totalTickets: 1,
        });
        onEvent({ type: "stageChanged", ticket: "P1 Launch", stage: "copy" });
        onEvent({
          type: "log",
          ticket: "P1 Launch",
          level: "warning",
          message: "Skipped an unsupported source",
          path: null,
          timestampMs: 1_750_000_000_000,
        });
        return new Promise<PipelineSummary>(() => undefined);
      },
    );
    render(<App />);
    await configureValidRun();

    fireEvent.click(screen.getByRole("button", { name: "Start processing" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    const runCard = screen.getByRole("region", { name: "P1 Launch" });
    expect(within(runCard).getByText("Warnings").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByText("Copy assets: 1 warning")).toBeVisible();
    expect(screen.getByText("Copy assets: 1 warning").closest("li")).toHaveClass(
      "asset-route__stop--warning",
      "asset-route__stop--current",
    );
  });

  it("keeps a failed-file partial ticket from rendering an all-green route", async () => {
    const failedFileSummary: PipelineSummary = {
      ...partialSummary,
      warnings: 0,
    };
    nativeMocks.startPipeline.mockImplementation(
      async (_request: unknown, onEvent: (event: PipelineEvent) => void) => {
        onEvent({ type: "pipelineStarted", totalTickets: 1 });
        onEvent({
          type: "ticketStarted",
          ticket: "P1 Launch",
          index: 1,
          totalTickets: 1,
        });
        onEvent({ type: "stageChanged", ticket: "P1 Launch", stage: "report" });
        onEvent({
          type: "ticketCompleted",
          ticket: "P1 Launch",
          status: "partialSuccess",
          copiedFiles: 4,
          changedFiles: 2,
          failedFiles: 1,
          warnings: 0,
          errors: 1,
          elapsedMs: 2_500,
        });
        onEvent({ type: "pipelineCompleted", summary: failedFileSummary });
        return failedFileSummary;
      },
    );
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
    const reportStage = screen.getByText("Write report: 1 failed file");
    expect(reportStage).toBeVisible();
    expect(reportStage.closest("li")).toHaveClass(
      "asset-route__stop--issue",
      "asset-route__stop--issue-error",
    );
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

    const resetButton = screen.getByRole("button", { name: "Start another run" });
    const resetIcon = resetButton.querySelector(".lucide-rotate-ccw");
    expect(resetIcon).toBeInTheDocument();
    expect(resetIcon).toHaveAttribute("width", "20");
    expect(resetIcon).toHaveAttribute("stroke", "currentColor");
    fireEvent.click(resetButton);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByLabelText("Input folder")).toHaveValue("/tickets");
    expect(screen.getByLabelText("Input folder")).toHaveFocus();
    expect(screen.getByRole("tab", { name: /Asset processing/ })).toBeEnabled();
    expect(screen.getByRole("tab", { name: /PowerPoint only/ })).toBeEnabled();
  });

  it("flushes pending events before showing an invocation failure", async () => {
    nativeMocks.startPipeline.mockImplementation(
      async (_request: unknown, onEvent: (event: PipelineEvent) => void) => {
        onEvent({ type: "pipelineStarted", totalTickets: 1 });
        onEvent({
          type: "ticketStarted",
          ticket: "P1 Launch",
          index: 1,
          totalTickets: 1,
        });
        onEvent({ type: "stageChanged", ticket: "P1 Launch", stage: "copy" });
        onEvent({
          type: "log",
          ticket: "P1 Launch",
          level: "warning",
          message: "One source could not be inspected",
          path: null,
          timestampMs: 1_750_000_000_000,
        });
        throw new Error("Native run unavailable");
      },
    );
    render(<App />);
    await configureValidRun();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start processing" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      screen.getByRole("heading", { name: "Transfer could not complete" }),
    ).toBeVisible();
    expect(screen.getByRole("tab", { name: /Warnings 1/ })).toBeVisible();
    expect(screen.getByText("One source could not be inspected")).toBeVisible();
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
      await Promise.resolve();
    });

    expect(screen.getByRole("heading", { name: "Transfer could not complete" })).toBeVisible();
    expect(screen.getByText("Discover sources: failed")).toBeInTheDocument();
    expect(screen.getByText("Copy assets: pending")).toBeInTheDocument();
    expect(screen.getByText("Write report: pending")).toBeInTheDocument();
  });

  it("supports arrow-key log tabs without an expanded activity view", () => {
    render(<App />);
    const activityTab = screen.getByRole("tab", { name: /Activity/ });
    fireEvent.keyDown(activityTab, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /Warnings/ })).toHaveFocus();
    expect(
      screen.queryByRole("button", { name: /activity log/i }),
    ).not.toBeInTheDocument();
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
