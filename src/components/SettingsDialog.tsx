import { open as openDirectory } from "@tauri-apps/plugin-dialog";
import { Folder, X } from "lucide-react";
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

type OutputPathSetting = "defaultOutputPath" | "powerpointOutputPath";

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
  const [pickerError, setPickerError] = useState<{
    field: OutputPathSetting;
    message: string;
  } | null>(null);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const assetOutputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const assetOutputId = useId();
  const assetOutputHelpId = useId();
  const assetOutputErrorId = useId();
  const powerpointOutputId = useId();
  const powerpointOutputHelpId = useId();
  const powerpointOutputErrorId = useId();
  const appearanceHelpId = useId();
  const busy = saving || submitting;
  const displayedSaveError = submissionError ?? saveError;
  const assetOutputDescription =
    pickerError?.field === "defaultOutputPath"
      ? `${assetOutputHelpId} ${assetOutputErrorId}`
      : assetOutputHelpId;
  const powerpointOutputDescription =
    pickerError?.field === "powerpointOutputPath"
      ? `${powerpointOutputHelpId} ${powerpointOutputErrorId}`
      : powerpointOutputHelpId;

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
    if (!outputDisabled) assetOutputRef.current?.focus();
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

  async function chooseOutputFolder(
    field: OutputPathSetting,
    title: string,
  ) {
    setPickerError(null);
    setSubmissionError(null);
    try {
      const selected = await openDirectory({
        directory: true,
        multiple: false,
        title,
        defaultPath: draft[field].trim() || undefined,
      });
      if (typeof selected === "string") {
        setDraft((current) => ({
          ...current,
          [field]: selected,
        }));
      }
    } catch (error) {
      setPickerError({ field, message: nativeErrorMessage(error) });
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
    const powerpointOutputPath = draft.powerpointOutputPath.trim();
    if (busy || defaultOutputPath === "" || powerpointOutputPath === "") {
      return;
    }
    setSubmissionError(null);
    setSubmitting(true);
    void Promise.resolve(
      onSave({ ...draft, defaultOutputPath, powerpointOutputPath }),
    )
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
            Choose where asset runs and future presentations go, and how the
            workbench looks.
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
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      <form onSubmit={handleSubmit} noValidate>
        <div className="settings-dialog__body">
          <div className="settings-group settings-group--destination">
            <div className="settings-group__heading">
              <h3>Output folders</h3>
              <p>Each workflow validates its input against its own destination.</p>
            </div>
            <div className="settings-destinations">
              <div className="settings-destination">
                <div className="settings-destination__heading">
                  <label htmlFor={assetOutputId}>Asset output folder</label>
                  <span>Collected assets and reports</span>
                </div>
                <div className="path-control">
                  <Folder size={18} aria-hidden="true" />
                  <input
                    ref={assetOutputRef}
                    id={assetOutputId}
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
                    aria-describedby={assetOutputDescription}
                  />
                  <button
                    type="button"
                    disabled={busy || outputDisabled}
                    aria-label="Choose asset output folder"
                    onClick={() =>
                      void chooseOutputFolder(
                        "defaultOutputPath",
                        "Choose asset output folder",
                      )
                    }
                  >
                    Choose folder
                  </button>
                </div>
                <p id={assetOutputHelpId} className="field-message">
                  {outputDisabled
                    ? "The destination can be changed after the current run."
                    : "Must not overlap the asset input folder."}
                </p>
                {pickerError?.field === "defaultOutputPath" ? (
                  <p id={assetOutputErrorId} className="form-alert" role="alert">
                    {pickerError.message}
                  </p>
                ) : null}
              </div>

              <div className="settings-destination">
                <div className="settings-destination__heading">
                  <label htmlFor={powerpointOutputId}>
                    PowerPoint output folder
                  </label>
                  <span>Future combined presentation</span>
                </div>
                <div className="path-control">
                  <Folder size={18} aria-hidden="true" />
                  <input
                    id={powerpointOutputId}
                    value={draft.powerpointOutputPath}
                    onChange={(event) => {
                      setPickerError(null);
                      setSubmissionError(null);
                      setDraft((current) => ({
                        ...current,
                        powerpointOutputPath: event.target.value,
                      }));
                    }}
                    placeholder="Path for future presentations"
                    disabled={busy || outputDisabled}
                    aria-required="true"
                    aria-describedby={powerpointOutputDescription}
                  />
                  <button
                    type="button"
                    disabled={busy || outputDisabled}
                    aria-label="Choose PowerPoint output folder"
                    onClick={() =>
                      void chooseOutputFolder(
                        "powerpointOutputPath",
                        "Choose PowerPoint output folder",
                      )
                    }
                  >
                    Choose folder
                  </button>
                </div>
                <p id={powerpointOutputHelpId} className="field-message">
                  {outputDisabled
                    ? "The destination can be changed after the current run."
                    : "Must not overlap the PowerPoint input folder."}
                </p>
                {pickerError?.field === "powerpointOutputPath" ? (
                  <p
                    id={powerpointOutputErrorId}
                    className="form-alert"
                    role="alert"
                  >
                    {pickerError.message}
                  </p>
                ) : null}
              </div>
            </div>
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
            disabled={
              busy ||
              draft.defaultOutputPath.trim() === "" ||
              draft.powerpointOutputPath.trim() === ""
            }
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
