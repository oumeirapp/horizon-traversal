import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, AppTheme } from "../lib/native";
import { SettingsDialog } from "./SettingsDialog";

const dialogMocks = vi.hoisted(() => ({
  openDirectory: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: dialogMocks.openDirectory,
}));

const settings: AppSettings = {
  defaultOutputPath: "/exports",
  theme: "dark",
};

describe("SettingsDialog", () => {
  beforeEach(() => {
    dialogMocks.openDirectory.mockReset();
  });

  it("previews appearance changes and reverts them through every cancel action", () => {
    const onThemePreview = vi.fn<(theme: AppTheme) => void>();
    const onCancel = vi.fn();
    const onSave = vi.fn();
    render(
      <SettingsDialog
        open
        settings={settings}
        onThemePreview={onThemePreview}
        onSave={onSave}
        onCancel={onCancel}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("group", { name: "Appearance" })).toBeVisible();
    expect(screen.getByRole("radio", { name: /Dark/ })).toBeChecked();

    fireEvent.click(screen.getByRole("radio", { name: /Light/ }));
    expect(onThemePreview).toHaveBeenLastCalledWith("light");

    const cancelEvent = new Event("cancel", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(dialog, cancelEvent);

    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(onThemePreview).toHaveBeenLastCalledWith("dark");
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("uses the native directory chooser and submits a trimmed complete draft", async () => {
    const onThemePreview = vi.fn<(theme: AppTheme) => void>();
    const onSave = vi.fn();
    dialogMocks.openDirectory.mockResolvedValue("/chosen/exports");
    render(
      <SettingsDialog
        open
        settings={settings}
        onThemePreview={onThemePreview}
        onSave={onSave}
        onCancel={() => undefined}
      />,
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Choose output folder" }),
      );
      await Promise.resolve();
    });

    expect(dialogMocks.openDirectory).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: "Choose default output folder",
      defaultPath: "/exports",
    });
    const output = screen.getByRole("textbox", {
      name: "Default output folder",
    });
    expect(output).toHaveValue("/chosen/exports");
    fireEvent.change(output, { target: { value: "  /final/exports  " } });
    fireEvent.click(screen.getByRole("radio", { name: /Light/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSave).toHaveBeenCalledWith({
      defaultOutputPath: "/final/exports",
      theme: "light",
    });
    expect(onThemePreview).toHaveBeenCalledWith("light");
    expect(onThemePreview).not.toHaveBeenCalledWith("dark");
  });

  it("keeps the dialog open and reports a rejected save", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Settings could not be saved"));
    render(
      <SettingsDialog
        open
        settings={settings}
        onThemePreview={() => undefined}
        onSave={onSave}
        onCancel={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Settings could not be saved",
    );
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("restores focus to the control that opened the dialog", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open settings
          </button>
          <SettingsDialog
            open={open}
            settings={settings}
            onThemePreview={() => undefined}
            onSave={() => undefined}
            onCancel={() => setOpen(false)}
          />
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open settings" });
    trigger.focus();
    fireEvent.click(trigger);

    expect(
      screen.getByRole("textbox", { name: "Default output folder" }),
    ).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(trigger).toHaveFocus();
  });
});
