import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppSettings,
  PipelineEvent,
  PipelineSummary,
  PowerPointEvent,
  PowerPointSummary,
  SelectionSummary,
} from "./lib/native";
import App from "./App";

const nativeMocks = vi.hoisted(() => ({
  validateSelection: vi.fn(),
  validatePowerPointSelection: vi.fn(),
  startPipeline: vi.fn(),
  startPowerPoint: vi.fn(),
  cancelPowerPoint: vi.fn(),
  openLastOutput: vi.fn(),
  openPowerPointOutput: vi.fn(),
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  openDialog: vi.fn(),
}));

vi.mock("./lib/native", () => ({
  validateSelection: nativeMocks.validateSelection,
  validatePowerPointSelection: nativeMocks.validatePowerPointSelection,
  startPipeline: nativeMocks.startPipeline,
  startPowerPoint: nativeMocks.startPowerPoint,
  cancelPowerPoint: nativeMocks.cancelPowerPoint,
  openLastOutput: nativeMocks.openLastOutput,
  openPowerPointOutput: nativeMocks.openPowerPointOutput,
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

const powerPointSummary: PowerPointSummary = {
  status: "success",
  totalTickets: 2,
  slidesCreated: 2,
  blankSlides: 0,
  warnings: 0,
  errors: 0,
  elapsedMs: 2_100,
  outputPath: "/powerpoint-exports/Horizon Traversal.pptx",
  reportPath: "/powerpoint-exports/Horizon Traversal.layout-report.json",
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

async function switchToPowerPoint() {
  const workflowTabs = screen.getByRole("tablist", { name: "Workflow mode" });
  const assetTab = screen.getByRole("tab", { name: /Asset processing/ });
  workflowTabs.focus();
  fireEvent.focus(workflowTabs);
  await act(async () => {
    fireEvent.keyDown(assetTab, { key: "ArrowRight" });
    await vi.advanceTimersByTimeAsync(1);
  });
}

describe("Horizon Traversal workbench", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    nativeMocks.validateSelection.mockReset();
    nativeMocks.validatePowerPointSelection.mockReset();
    nativeMocks.startPipeline.mockReset();
    nativeMocks.startPowerPoint.mockReset();
    nativeMocks.cancelPowerPoint.mockReset();
    nativeMocks.openLastOutput.mockReset();
    nativeMocks.openPowerPointOutput.mockReset();
    nativeMocks.loadSettings.mockReset();
    nativeMocks.saveSettings.mockReset();
    nativeMocks.openDialog.mockReset();
    nativeMocks.validateSelection.mockResolvedValue(validSelection);
    nativeMocks.validatePowerPointSelection.mockResolvedValue(validSelection);
    nativeMocks.cancelPowerPoint.mockResolvedValue(undefined);
    nativeMocks.openPowerPointOutput.mockResolvedValue(undefined);
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
    expect(
      screen.queryByRole("button", { name: "Start another run" }),
    ).not.toBeInTheDocument();
    const assetStartRow = screen
      .getByRole("button", { name: "Start processing" })
      .closest(".start-row");
    expect(
      within(assetStartRow as HTMLElement).getByText(
        "A valid input path is required before processing",
      ),
    ).toHaveClass("start-row__requirement");
    expect(screen.getByLabelText("Input folder")).toHaveAttribute(
      "aria-describedby",
      "input-help input-requirement",
    );
    expect(
      within(document.getElementById("input-help") as HTMLElement).queryByText(
        "A valid input path is required before processing",
      ),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Folders stay on this device.")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Ready. Existing ticket outputs will be replaced safely."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("A valid route is required before processing."),
    ).not.toBeInTheDocument();
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
    expect(screen.queryByRole("checkbox", { name: "Create PPTX" })).not.toBeInTheDocument();
    expect(screen.queryByText("PPTX is not available yet")).not.toBeInTheDocument();
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
    const assetStartRow = screen
      .getByRole("button", { name: "Start processing" })
      .closest(".start-row");
    expect(
      within(assetStartRow as HTMLElement).queryByText(
        "A valid input path is required before processing",
      ),
    ).not.toBeInTheDocument();

    const workflowTabs = screen.getByRole("tablist", { name: "Workflow mode" });
    expect(workflowTabs).toHaveAttribute("data-active-tab", "assets");
    workflowTabs.focus();
    fireEvent.focus(workflowTabs);
    expect(assetTab).toHaveFocus();
    await act(async () => {
      fireEvent.keyDown(assetTab, { key: "ArrowRight" });
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(powerpointTab).toHaveFocus();
    expect(powerpointTab).toHaveAttribute("aria-selected", "true");
    expect(workflowTabs).toHaveAttribute("data-active-tab", "powerpoint");
    expect(screen.getAllByText("Set up presentation")[0]).toBeVisible();
    const powerpointSetup = screen.getByRole("region", {
      name: "Choose the presentation source",
    });
    const powerpointStartRow = within(powerpointSetup)
      .getByRole("button", { name: "Create PowerPoint" })
      .closest(".start-row");
    expect(
      within(powerpointStartRow as HTMLElement).getByText(
        "A valid input path is required before creation",
      ),
    ).toHaveClass("start-row__requirement");
    expect(screen.getByLabelText("Root folder")).toHaveAttribute(
      "aria-describedby",
      "powerpoint-input-help powerpoint-input-requirement",
    );
    expect(
      within(
        document.getElementById("powerpoint-input-help") as HTMLElement,
      ).queryByText("A valid input path is required before creation"),
    ).not.toBeInTheDocument();
    expect(powerpointStartRow?.querySelector(".start-row__completion")).toBeNull();
    expect(screen.queryByText("Each immediate ticket folder will become one slide.")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Ticket filter Optional"),
    ).not.toBeInTheDocument();

    nativeMocks.openDialog.mockResolvedValueOnce("/powerpoint-tickets");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
      await Promise.resolve();
    });
    expect(
      within(powerpointStartRow as HTMLElement).queryByText(
        "A valid input path is required before creation",
      ),
    ).not.toBeInTheDocument();
    expect(nativeMocks.openDialog).toHaveBeenLastCalledWith({
      directory: true,
      multiple: false,
      title: "Choose PowerPoint ticket source",
      defaultPath: undefined,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(360);
    });

    expect(nativeMocks.validatePowerPointSelection).toHaveBeenLastCalledWith({
      inputPath: "/powerpoint-tickets",
      outputPath: "/powerpoint-exports",
    });
    expect(screen.queryByText("Slide plan")).not.toBeInTheDocument();
    expect(screen.queryByText(/planned slides?/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "P1 Launch" })).toBeVisible();
    expect(screen.getByText("Ticket 1 of 2")).toBeVisible();
    expect(
      screen.getByRole("list", { name: "PowerPoint creation stages" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "PowerPoint activity" }),
    ).toBeVisible();
    expect(
      screen.getByText(/Ticket and slide activity will appear here/),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Create PowerPoint" })).toBeEnabled();
    expect(
      within(powerpointStartRow as HTMLElement).queryByText(
        "A valid input path is required before creation",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Ready. The combined deck will be saved to the PowerPoint output folder."),
    ).not.toBeInTheDocument();
    expect(nativeMocks.startPipeline).not.toHaveBeenCalled();
    expect(nativeMocks.startPowerPoint).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(powerpointTab, { key: "ArrowLeft" });
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(assetTab).toHaveFocus();
    expect(assetTab).toHaveAttribute("aria-selected", "true");
    expect(workflowTabs).toHaveAttribute("data-active-tab", "assets");
    expect(screen.getByLabelText("Input folder")).toHaveValue("/asset-tickets");
  });

  it("keeps an invalid PowerPoint source from starting", async () => {
    nativeMocks.validatePowerPointSelection.mockResolvedValue({
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
    expect(screen.queryByText(/Ticket 1 of/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create PowerPoint" })).toBeDisabled();
    const powerpointStartRow = screen
      .getByRole("button", { name: "Create PowerPoint" })
      .closest(".start-row");
    expect(
      within(powerpointStartRow as HTMLElement).queryByText(
        "A valid input path is required before creation",
      ),
    ).not.toBeInTheDocument();
    expect(nativeMocks.startPipeline).not.toHaveBeenCalled();
    expect(nativeMocks.startPowerPoint).not.toHaveBeenCalled();
  });

  it("starts PowerPoint creation and renders live progress through completion", async () => {
    let resolveRun: (summary: PowerPointSummary) => void = () => undefined;
    let emit: (event: PowerPointEvent) => void = () => undefined;
    nativeMocks.startPowerPoint.mockImplementation(
      (_request: unknown, onEvent: (event: PowerPointEvent) => void) => {
        emit = onEvent;
        onEvent({
          type: "powerpointStarted",
          runId: "pptx-1",
          totalTickets: 2,
          totalUnits: 10,
        });
        onEvent({
          type: "powerpointProgress",
          runId: "pptx-1",
          step: "compose",
          ticket: "P2 Brand",
          index: 2,
          totalTickets: 2,
          stepCompleted: 1,
          stepTotal: 2,
          completedUnits: 6,
          totalUnits: 10,
          message: "Placing approved assets on the slide",
        });
        onEvent({
          type: "log",
          runId: "pptx-1",
          ticket: "P2 Brand",
          level: "info",
          message: "Selected six deliverables",
          path: null,
          timestampMs: 1_750_000_000_000,
        });
        return new Promise<PowerPointSummary>((resolve) => {
          resolveRun = resolve;
        });
      },
    );
    render(<App />);
    await settleSettings();

    await switchToPowerPoint();
    fireEvent.change(screen.getByLabelText("Root folder"), {
      target: { value: "/powerpoint-tickets" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(360);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create PowerPoint" }));
      await Promise.resolve();
    });
    expect(
      screen.queryByRole("button", { name: "Create another PowerPoint" }),
    ).not.toBeInTheDocument();

    expect(nativeMocks.startPowerPoint).toHaveBeenCalledWith(
      {
        inputPath: "/powerpoint-tickets",
        outputPath: "/powerpoint-exports",
      },
      expect.any(Function),
    );
    expect(
      screen.queryByText("Placing approved assets on the slide"),
    ).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(screen.getByRole("heading", { name: "P2 Brand", level: 2 })).toBeVisible();
    expect(screen.getByText("Ticket 2 of 2")).toBeVisible();
    expect(screen.getAllByText("Compose slide")[0]).toBeVisible();
    expect(screen.getByText("Placing approved assets on the slide")).toBeVisible();
    expect(
      screen.getByRole("progressbar", { name: "PowerPoint creation progress" }),
    ).toHaveAttribute("aria-valuenow", "60");
    expect(screen.getByText("Selected six deliverables")).toBeVisible();
    expect(screen.getByLabelText("Root folder")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel creation" })).toBeEnabled();
    expect(screen.getByRole("tab", { name: /Asset processing/ })).toBeDisabled();
    expect(screen.queryByText("Slide plan")).not.toBeInTheDocument();

    await act(async () => {
      emit({
        type: "powerpointCompleted",
        runId: "pptx-1",
        summary: powerPointSummary,
      });
      resolveRun(powerPointSummary);
      await Promise.resolve();
    });

    expect(screen.getByRole("heading", { name: "PowerPoint ready" })).toBeVisible();
    const powerpointSetup = screen.getByRole("region", {
      name: "Choose the presentation source",
    });
    const createAnotherPowerPoint = within(powerpointSetup).getByRole("button", {
      name: "Create another PowerPoint",
    });
    expect(createAnotherPowerPoint).toBeVisible();
    expect(createAnotherPowerPoint).toHaveClass("button--repeat");
    const powerpointCompletion = createAnotherPowerPoint.closest(".start-row__completion");
    expect(powerpointCompletion).not.toBeNull();
    expect(
      within(powerpointCompletion as HTMLElement).getByText(
        "Choose Create another PowerPoint to select a new source.",
      ),
    ).toBeVisible();
    expect(
      within(powerpointSetup).getByRole("button", { name: "Create PowerPoint" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Start another presentation" }),
    ).toBeVisible();
    const openPresentation = screen.getByRole("button", {
      name: "Open presentation",
    });
    await act(async () => {
      fireEvent.click(openPresentation);
      await Promise.resolve();
    });
    expect(nativeMocks.openPowerPointOutput).toHaveBeenCalledOnce();

    fireEvent.click(createAnotherPowerPoint);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(360);
    });
    expect(screen.queryByRole("heading", { name: "PowerPoint ready" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Root folder")).toHaveValue("/powerpoint-tickets");
    expect(screen.getByLabelText("Root folder")).toHaveFocus();
    expect(screen.getByRole("button", { name: "Create PowerPoint" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Create another PowerPoint" }),
    ).not.toBeInTheDocument();
    expect(nativeMocks.startPowerPoint).toHaveBeenCalledOnce();
  });

  it("shows and searches the full path for an asset omitted from a content slide", async () => {
    const failedAssetPath =
      "/powerpoint-tickets/P2 Brand/Deliverables/Campaign/Approved/oversized-key-visual.png";
    const warningMessage =
      'Content slide 2 for ticket "P2 Brand" is missing an image because prior asset processing failed during imageResize: image requires 1,900 MiB.';

    nativeMocks.startPowerPoint.mockImplementation(
      (_request: unknown, onEvent: (event: PowerPointEvent) => void) => {
        onEvent({
          type: "powerpointStarted",
          runId: "pptx-missing-asset",
          totalTickets: 2,
          totalUnits: 10,
        });
        onEvent({
          type: "log",
          runId: "pptx-missing-asset",
          ticket: "P2 Brand",
          level: "warning",
          message: warningMessage,
          path: failedAssetPath,
          timestampMs: 1_750_000_000_000,
        });
        return new Promise<PowerPointSummary>(() => undefined);
      },
    );

    render(<App />);
    await settleSettings();
    await switchToPowerPoint();
    fireEvent.change(screen.getByLabelText("Root folder"), {
      target: { value: "/powerpoint-tickets" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(360);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create PowerPoint" }));
      await vi.advanceTimersByTimeAsync(20);
    });

    fireEvent.click(screen.getByRole("tab", { name: /Warnings 1/ }));
    const slideGroup = screen
      .getByRole("heading", { name: "P2 Brand", level: 3 })
      .closest(".log-group");
    expect(slideGroup).not.toBeNull();
    expect(
      within(slideGroup as HTMLElement).getByText(warningMessage),
    ).toBeVisible();
    const renderedPath = within(slideGroup as HTMLElement).getByText(
      failedAssetPath,
    );
    expect(renderedPath.tagName).toBe("CODE");
    expect(renderedPath.closest(".log-entry__path")).toHaveTextContent(
      `Path${failedAssetPath}`,
    );

    const search = screen.getByRole("searchbox", { name: "Search run activity" });
    fireEvent.change(search, { target: { value: "oversized-key-visual.png" } });
    expect(screen.getByText(failedAssetPath)).toBeVisible();

    fireEvent.change(search, { target: { value: "content slide 2" } });
    expect(screen.getByText(warningMessage)).toBeVisible();
  });

  it("requests cooperative cancellation for the active PowerPoint run", async () => {
    let resolveRun: (summary: PowerPointSummary) => void = () => undefined;
    let emit: (event: PowerPointEvent) => void = () => undefined;
    nativeMocks.startPowerPoint.mockImplementation(
      (_request: unknown, onEvent: (event: PowerPointEvent) => void) => {
        emit = onEvent;
        onEvent({
          type: "powerpointStarted",
          runId: "pptx-cancel",
          totalTickets: 2,
          totalUnits: 10,
        });
        onEvent({
          type: "powerpointProgress",
          runId: "pptx-cancel",
          step: "layout",
          ticket: "P1 Launch",
          index: 1,
          totalTickets: 2,
          stepCompleted: 1,
          stepTotal: 2,
          completedUnits: 4,
          totalUnits: 10,
          message: "Planning the first slide",
        });
        return new Promise<PowerPointSummary>((resolve) => {
          resolveRun = resolve;
        });
      },
    );
    render(<App />);
    await settleSettings();

    await switchToPowerPoint();
    fireEvent.change(screen.getByLabelText("Root folder"), {
      target: { value: "/powerpoint-tickets" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(360);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create PowerPoint" }));
      await vi.advanceTimersByTimeAsync(20);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel creation" }));
      await Promise.resolve();
    });

    expect(nativeMocks.cancelPowerPoint).toHaveBeenCalledWith("pptx-cancel");
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();

    const cancelled: PowerPointSummary = {
      ...powerPointSummary,
      status: "cancelled",
      slidesCreated: 0,
      outputPath: null,
      reportPath: null,
    };
    await act(async () => {
      emit({
        type: "powerpointCompleted",
        runId: "pptx-cancel",
        summary: cancelled,
      });
      resolveRun(cancelled);
      await Promise.resolve();
    });
    expect(
      screen.getByRole("heading", { name: "PowerPoint creation cancelled" }),
    ).toBeVisible();
    expect(document.querySelector(".preview-badge")).toHaveTextContent(
      "Cancelled",
    );
    const stages = screen.getByRole("list", {
      name: "PowerPoint creation stages",
    });
    expect(within(stages).getByText("Plan layout").closest("li")).toHaveTextContent(
      "cancelled",
    );
    expect(
      screen.getByText(
        "Creation was cancelled before a presentation was published.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Create another PowerPoint" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open presentation" })).not.toBeInTheDocument();
  });

  it("keeps the reached checkpoint and useful failure copy when creation stops", async () => {
    nativeMocks.startPowerPoint.mockImplementation(
      async (_request: unknown, onEvent: (event: PowerPointEvent) => void) => {
        onEvent({
          type: "powerpointStarted",
          runId: "pptx-failed",
          totalTickets: 2,
          totalUnits: 10,
        });
        onEvent({
          type: "powerpointProgress",
          runId: "pptx-failed",
          step: "compose",
          ticket: "P2 Brand",
          index: 2,
          totalTickets: 2,
          stepCompleted: 1,
          stepTotal: 2,
          completedUnits: 6,
          totalUnits: 10,
          message: "Composing the second slide",
        });
        throw new Error("The PowerPoint sidecar stopped unexpectedly.");
      },
    );
    render(<App />);
    await settleSettings();

    await switchToPowerPoint();
    fireEvent.change(screen.getByLabelText("Root folder"), {
      target: { value: "/powerpoint-tickets" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(360);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create PowerPoint" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector(".preview-badge")).toHaveTextContent("Failed");
    expect(
      screen.getAllByText("The PowerPoint sidecar stopped unexpectedly."),
    ).toHaveLength(2);
    const stages = screen.getByRole("list", {
      name: "PowerPoint creation stages",
    });
    expect(within(stages).getByText("Compose slide").closest("li")).toHaveTextContent(
      "failed",
    );
    expect(
      screen.getByRole("heading", { name: "PowerPoint could not be created" }),
    ).toBeVisible();
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

  it("unlocks PowerPoint after asset completion and starts a focused new run", async () => {
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
    expect(
      screen.queryByRole("button", { name: "Start another run" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Keep this window open while assets move."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Keep this window open while the presentation is created."),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Resize video")).toBeVisible();
    expect(screen.getByLabelText("Input folder")).toBeDisabled();
    expect(screen.getByRole("tab", { name: /PowerPoint only/ })).toBeDisabled();

    await act(async () => {
      resolveRun(successSummary);
      await Promise.resolve();
    });
    expect(screen.getByRole("heading", { name: "Transfer complete" })).toBeVisible();

    const assetTab = screen.getByRole("tab", { name: /Asset processing/ });
    const powerpointTab = screen.getByRole("tab", { name: /PowerPoint only/ });
    expect(powerpointTab).toBeEnabled();
    await switchToPowerPoint();
    expect(powerpointTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Root folder")).toBeEnabled();

    fireEvent.change(screen.getByLabelText("Root folder"), {
      target: { value: "/powerpoint-tickets" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(360);
    });
    expect(nativeMocks.validatePowerPointSelection).toHaveBeenLastCalledWith({
      inputPath: "/powerpoint-tickets",
      outputPath: "/powerpoint-exports",
    });
    expect(screen.getByRole("button", { name: "Create PowerPoint" })).toBeEnabled();

    await act(async () => {
      fireEvent.keyDown(powerpointTab, { key: "ArrowLeft" });
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(assetTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Transfer complete" })).toBeVisible();
    expect(screen.getByText("2 tickets matched")).toBeVisible();

    const setup = screen.getByRole("region", { name: "Choose the transfer route" });
    const result = screen.getByRole("region", { name: "Transfer complete" });
    const resetButton = within(setup).getByRole("button", { name: "Start another run" });
    expect(resetButton).toHaveClass("button--repeat");
    const completion = resetButton.closest(".start-row__completion");
    expect(completion).not.toBeNull();
    expect(
      within(completion as HTMLElement).getByText(
        "Choose Start another run to prepare another transfer.",
      ),
    ).toBeVisible();
    expect(screen.getByLabelText("Input folder")).toBeDisabled();
    expect(within(result).getByRole("button", { name: "Start another run" })).toBeVisible();
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
    expect(assetTab).toBeEnabled();
    expect(powerpointTab).toBeEnabled();
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
