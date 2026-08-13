import { open as openDirectory } from "@tauri-apps/plugin-dialog";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { AppSettings, AppTheme } from "../lib/native";

export interface SettingsDialogProps {
  id?: string;
  open: boolean;
  settings: AppSettings;
  saving?: boolean;
  saveError?: string | null;
  outputDisabled?: boolean;
  onThemePreview: (theme: AppTheme) => void;
  onSave: (settings: AppSettings) => void | Promise<void>;
  onCancel: () => void;
}

export const SETTINGS_DIALOG_ID = "settings-dialog";

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

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M3.5 7.5v10.25A2.25 2.25 0 0 0 5.75 20h12.5a2.25 2.25 0 0 0 2.25-2.25V9.5a2 2 0 0 0-2-2h-6l-2-2h-5a2 2 0 0 0-2 2Z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

function SettingsDialogContent({
  id = SETTINGS_DIALOG_ID,
  settings,
  saving = false,
  saveError = null,
  outputDisabled = false,
  onThemePreview,
  onSave,
  onCancel,
}: Omit<SettingsDialogProps, "open">) {
  const [draft, setDraft] = useState<AppSettings>(() => ({ ...settings }));
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const outputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const outputId = useId();
  const outputHelpId = useId();
  const appearanceHelpId = useId();
  const pickerErrorId = useId();
  const busy = saving || submitting;
  const displayedSaveError = submissionError ?? saveError;
  const outputDescription = pickerError
    ? `${outputHelpId} ${pickerErrorId}`
    : outputHelpId;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;

    const returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    if (!dialog.open) {
      try {
        if (typeof dialog.showModal === "function") dialog.showModal();
        else dialog.setAttribute("open", "");
      } catch {
        dialog.setAttribute("open", "");
      }
    }
    if (!outputDisabled) outputRef.current?.focus();
    else closeRef.current?.focus();

    return () => {
      if (dialog.open) {
        try {
          if (typeof dialog.close === "function") dialog.close();
          else dialog.removeAttribute("open");
        } catch {
          dialog.removeAttribute("open");
        }
      }
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, []);

  function requestCancel() {
    if (busy) return;
    onThemePreview(settings.theme);
    onCancel();
  }

  async function chooseOutputFolder() {
    setPickerError(null);
    setSubmissionError(null);
    try {
      const selected = await openDirectory({
        directory: true,
        multiple: false,
        title: "Choose default output folder",
        defaultPath: draft.defaultOutputPath.trim() || undefined,
      });
      if (typeof selected === "string") {
        setDraft((current) => ({
          ...current,
          defaultOutputPath: selected,
        }));
      }
    } catch (error) {
      setPickerError(nativeErrorMessage(error));
    }
  }

  function changeTheme(theme: AppTheme) {
    setSubmissionError(null);
    setDraft((current) => ({ ...current, theme }));
    onThemePreview(theme);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const defaultOutputPath = draft.defaultOutputPath.trim();
    if (busy || defaultOutputPath === "") return;
    setSubmissionError(null);
    setSubmitting(true);
    void Promise.resolve(onSave({ ...draft, defaultOutputPath }))
      .catch((error: unknown) => {
        setSubmissionError(nativeErrorMessage(error));
      })
      .finally(() => {
        setSubmitting(false);
      });
  }

  return (
    <dialog
      ref={dialogRef}
      id={id}
      className="settings-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        requestCancel();
      }}
    >
      <div className="settings-dialog__header">
        <div className="settings-dialog__title">
          <p className="section-kicker">Application</p>
          <h2 id={titleId}>Settings</h2>
          <p id={descriptionId}>
            Choose where new transfers go and how the workbench looks.
          </p>
        </div>
        <button
          ref={closeRef}
          type="button"
          className="settings-dialog__close"
          aria-label="Close settings"
          disabled={busy}
          onClick={requestCancel}
        >
          <CloseIcon />
        </button>
      </div>

      <form onSubmit={handleSubmit} noValidate>
        <div className="settings-dialog__body">
          <div className="settings-group settings-group--destination">
            <div className="settings-group__heading">
              <h3>Default output folder</h3>
              <p>Used automatically for every new transfer.</p>
            </div>
            <label className="sr-only" htmlFor={outputId}>
              Default output folder
            </label>
            <div className="path-control">
              <FolderIcon />
              <input
                ref={outputRef}
                id={outputId}
                value={draft.defaultOutputPath}
                onChange={(event) => {
                  setPickerError(null);
                  setSubmissionError(null);
                  setDraft((current) => ({
                    ...current,
                    defaultOutputPath: event.target.value,
                  }));
                }}
                placeholder="Path for collected assets"
                disabled={busy || outputDisabled}
                aria-required="true"
                aria-describedby={outputDescription}
              />
              <button
                type="button"
                disabled={busy || outputDisabled}
                aria-label="Choose output folder"
                onClick={() => void chooseOutputFolder()}
              >
                Choose folder
              </button>
            </div>
            <p id={outputHelpId} className="field-message">
              {outputDisabled
                ? "The destination can be changed after the current run."
                : "Must not overlap the input folder."}
            </p>
            {pickerError === null ? null : (
              <p id={pickerErrorId} className="form-alert" role="alert">
                {pickerError}
              </p>
            )}
          </div>

          <fieldset
            className="settings-group settings-group--appearance"
            aria-describedby={appearanceHelpId}
          >
            <legend className="sr-only">Appearance</legend>
            <div className="settings-group__heading">
              <h3>Appearance</h3>
              <p id={appearanceHelpId}>
                Preview instantly. Save changes to keep it.
              </p>
            </div>
            <div className="appearance-options">
              {(["light", "dark"] as const).map((theme) => (
                <label
                  className="appearance-choice"
                  data-selected={draft.theme === theme ? "true" : undefined}
                  key={theme}
                >
                  <input
                    className="appearance-choice__control"
                    type="radio"
                    name="appearance"
                    value={theme}
                    checked={draft.theme === theme}
                    disabled={busy}
                    onChange={() => changeTheme(theme)}
                  />
                  <span className="appearance-choice__copy">
                    <strong>{theme === "light" ? "Light" : "Dark"}</strong>
                    <small>
                      {theme === "light"
                        ? "Bright, cool work surfaces"
                        : "Low-glare navy work surfaces"}
                    </small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {displayedSaveError ? (
            <p className="form-alert settings-dialog__error" role="alert">
              {displayedSaveError}
            </p>
          ) : null}
        </div>

        <div className="settings-dialog__footer">
          <button
            type="button"
            className="button button--quiet"
            disabled={busy}
            onClick={requestCancel}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="button button--primary"
            disabled={busy || draft.defaultOutputPath.trim() === ""}
          >
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function SettingsDialog({ open, ...contentProps }: SettingsDialogProps) {
  if (!open) return null;
  return <SettingsDialogContent {...contentProps} />;
}
