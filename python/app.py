"""
app.py — X Traversal
Automated Asset Discovery & Collection
"""

import threading
import tkinter as tk
from tkinter import filedialog
from pathlib import Path
import time
import sys
import subprocess
import platform
import pipeline
from pipeline import LogEntry, LogType

print("sys.path =", sys.path)
print("frozen =", getattr(sys, "frozen", False))


def resource_path(relative: str) -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
    return base / relative


# ═════════════════════════════════════════════════════════════
#  Design Tokens
# ═════════════════════════════════════════════════════════════

BG = "#08101A"
SURFACE = "#0D1826"
SURFACE2 = "#0A1220"
SURFACE3 = "#111F30"
BORDER = "#182336"
BORDER2 = "#1E2D42"

FG = "#E8EFF7"
FG_DIM = "#4A6480"
FG_MID = "#8AABB0"

TEAL = "#00D4AA"
TEAL_DIM = "#00896D"
TEAL_DARK = "#002E25"
BLUE = "#4A9EFF"
BLUE_DARK = "#0A1E38"
AMBER = "#F5A623"
RED = "#EF4444"
PURPLE = "#8B5CF6"
PURPLE_DARK = "#1E0A3C"
GREEN = "#22C55E"
GREEN_DARK = "#052E16"

FONT_TITLE = ("SF Pro Display", 17, "bold")
FONT_SUB = ("SF Pro Display", 10)
FONT_H1 = ("SF Pro Display", 13, "bold")
FONT_UI_MED = ("SF Pro Display", 11, "bold")
FONT_MONO = ("Menlo", 10)
FONT_BADGE = ("SF Pro Display", 9, "bold")
FONT_SMALL = ("SF Pro Display", 9)

AVG_SECS_PER_TICKET = 71.67


# ═════════════════════════════════════════════════════════════
#  Helpers
# ═════════════════════════════════════════════════════════════


def rounded_rect(canvas, x1, y1, x2, y2, r=8, **kw):
    pts = [
        x1 + r, y1, x2 - r, y1,
        x2, y1, x2, y1 + r,
        x2, y2 - r, x2, y2,
        x2 - r, y2, x1 + r, y2,
        x1, y2, x1, y2 - r,
        x1, y1 + r, x1, y1,
        x1 + r, y1,
    ]
    return canvas.create_polygon(pts, smooth=True, **kw)


def card_frame(parent, padx=24, pady=(0, 10)):
    outer = tk.Frame(parent, bg=BORDER2)
    outer.pack(fill="x", padx=padx, pady=pady)
    inner = tk.Frame(outer, bg=SURFACE, padx=18, pady=14)
    inner.pack(fill="x", padx=1, pady=1)
    return inner


def open_folder(path: str):
    """Open a folder in the native file manager."""
    try:
        if platform.system() == "Windows":
            normalized = str(Path(path).resolve())
            subprocess.Popen(["explorer", normalized])
        elif platform.system() == "Darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
    except Exception:
        pass


# ═════════════════════════════════════════════════════════════
#  Main App
# ═════════════════════════════════════════════════════════════


class App(tk.Tk):
    def __init__(self):
        super().__init__()

        self.title("X Traversal")
        self.resizable(True, True)
        self.minsize(860, 720)
        self.configure(bg=BG)

        self.input_var = tk.StringVar()
        self.output_var = tk.StringVar()
        self.filter_var = tk.StringVar()
        self._all_logs: list[LogEntry] = []
        self._error_count = 0
        self._warn_count = 0
        self._running = False
        self._start_time: float | None = None
        self._total_tickets = 0
        self._elapsed_var = tk.StringVar(value="00:00:00")
        self._remain_var = tk.StringVar(value="--:--:--")
        self._active_tab = "activity"
        self._current_ticket: str | None = None
        self._last_error_ticket: str | None = None
        self._last_warn_ticket: str | None = None
        self._logo_img: tk.PhotoImage | None = None
        self._log_expanded = False
        self._run_btn_enabled = True
        self._completed = False

        self._build_ui()

    # ─────────────────────────────────────────────────────────
    #  UI scaffold
    # ─────────────────────────────────────────────────────────

    def _build_ui(self):
        self._main = tk.Frame(self, bg=BG)
        self._main.pack(fill="both", expand=True, padx=0, pady=0)

        self._hdr_frame = self._build_header()
        self._cfg_frame = self._build_config_section()
        self._run_frame = self._build_run_bar()
        self._activity_frame = self._build_activity_section()

    # ─────────────────────────────────────────────────────────
    #  Header
    # ─────────────────────────────────────────────────────────

    def _build_header(self):
        hdr = tk.Frame(self._main, bg=BG)
        hdr.pack(fill="x", padx=24, pady=(18, 12))

        left = tk.Frame(hdr, bg=BG)
        left.pack(side="left")

        logo_path = resource_path("logo.png")
        if logo_path.exists():
            try:
                raw = tk.PhotoImage(file=str(logo_path))
                w, h = raw.width(), raw.height()
                scale = max(1, h // 44)
                self._logo_img = raw.subsample(scale)
                tk.Label(left, image=self._logo_img, bg=BG).pack(
                    side="left", padx=(0, 12)
                )
            except Exception:
                self._draw_x_logo(left)
        else:
            self._draw_x_logo(left)

        txt = tk.Frame(left, bg=BG)
        txt.pack(side="left", anchor="w")
        tk.Label(txt, text="X Traversal", font=FONT_TITLE, fg=FG, bg=BG).pack(
            anchor="w"
        )
        tk.Label(
            txt,
            text="Automated Asset Discovery & Collection",
            font=FONT_SUB,
            fg=FG_DIM,
            bg=BG,
        ).pack(anchor="w")

        return hdr

    def _draw_x_logo(self, parent):
        c = tk.Canvas(parent, width=44, height=44, bg=BG, highlightthickness=0)
        c.pack(side="left", padx=(0, 12))
        rounded_rect(c, 2, 2, 42, 42, r=10, fill=TEAL_DARK, outline=TEAL_DIM, width=1)
        c.create_line(12, 12, 32, 32, fill=TEAL, width=3, capstyle="round")
        c.create_line(32, 12, 12, 32, fill=TEAL, width=3, capstyle="round")

    # ─────────────────────────────────────────────────────────
    #  Section 1 — Config
    # ─────────────────────────────────────────────────────────

    def _build_config_section(self):
        outer = tk.Frame(self._main, bg=BORDER2)
        outer.pack(fill="x", padx=24, pady=(0, 10))
        card = tk.Frame(outer, bg=SURFACE, padx=18, pady=14)
        card.pack(fill="x", padx=1, pady=1)

        hdr = tk.Frame(card, bg=SURFACE)
        hdr.pack(fill="x", pady=(0, 12))
        self._num_badge(hdr, "1", SURFACE)
        tk.Label(
            hdr, text="Pipeline Configuration", font=FONT_H1, fg=FG, bg=SURFACE
        ).pack(side="left", padx=(8, 12))
        tk.Label(
            hdr,
            text="Choose input and output directories.",
            font=FONT_SMALL,
            fg=FG_DIM,
            bg=SURFACE,
        ).pack(side="left")

        self._field_row(
            card,
            "📁",
            TEAL_DARK,
            "Input Folder",
            "Source directory to scan",
            self.input_var,
            browsable=True,
        )
        self._h_divider(card)
        self._field_row(
            card,
            "📂",
            BLUE_DARK,
            "Output Folder",
            "Directory to save results",
            self.output_var,
            browsable=True,
        )
        self._h_divider(card)
        self._filter_row(card)

        hint = tk.Frame(card, bg=SURFACE)
        hint.pack(fill="x", pady=(10, 2))
        tk.Label(hint, text="ⓘ", font=FONT_SMALL, fg=FG_DIM, bg=SURFACE).pack(
            side="left", padx=(0, 6)
        )
        tk.Label(
            hint,
            text='"P5"  ·  "P1, P3, P10"  ·  "P20–P40"  ·  "P1–P5, P10"  ·  Blank = all folders',
            font=FONT_SMALL,
            fg=FG_DIM,
            bg=SURFACE,
        ).pack(side="left")

        return outer

    def _num_badge(self, parent, num, bg):
        c = tk.Canvas(parent, width=24, height=24, bg=bg, highlightthickness=0)
        c.pack(side="left")
        rounded_rect(c, 1, 1, 23, 23, r=12, fill=TEAL_DARK, outline=TEAL_DIM, width=1)
        c.create_text(12, 12, text=num, fill=TEAL, font=FONT_BADGE)

    def _h_divider(self, parent):
        tk.Frame(parent, bg=BORDER2, height=1).pack(fill="x", pady=6)

    # ─────────────────────────────────────────────────────────
    #  FIX: _field_row and _filter_row — unified column sizing
    # ─────────────────────────────────────────────────────────

    # Shared column constants so both rows are pixel-identical
    _COL1_MINSIZE = 160   # label column
    _COL3_MINSIZE = 140   # action column (Browse btn / badge)

    def _field_row(self, parent, icon, icon_bg, label, sub, var, browsable=False):
        row = tk.Frame(parent, bg=SURFACE)
        row.pack(fill="x", pady=5)
        row.columnconfigure(1, minsize=self._COL1_MINSIZE)
        row.columnconfigure(2, weight=1)
        row.columnconfigure(3, minsize=self._COL3_MINSIZE)

        tile = tk.Canvas(row, width=40, height=40, bg=SURFACE, highlightthickness=0)
        tile.grid(row=0, column=0, rowspan=2, padx=(0, 14), sticky="w")
        rounded_rect(tile, 1, 1, 39, 39, r=9, fill=icon_bg, outline="")
        tile.create_text(20, 20, text=icon, font=("SF Pro Display", 16))

        tk.Label(row, text=label, font=FONT_UI_MED, fg=FG, bg=SURFACE).grid(
            row=0, column=1, sticky="sw", padx=(0, 16)
        )
        tk.Label(row, text=sub, font=FONT_SMALL, fg=FG_DIM, bg=SURFACE).grid(
            row=1, column=1, sticky="nw", padx=(0, 16)
        )

        ef_outer = tk.Frame(row, bg=BORDER2)
        ef_outer.grid(row=0, column=2, rowspan=2, sticky="ew")
        ef_inner = tk.Frame(ef_outer, bg=SURFACE2)
        ef_inner.pack(fill="x", padx=1, pady=1)

        path_entry = tk.Entry(
            ef_inner,
            textvariable=var,
            font=FONT_MONO,
            bg=SURFACE2,
            fg=FG,
            insertbackground=TEAL,
            relief="flat",
            highlightthickness=0,
            bd=0,
        )
        path_entry.pack(fill="x", ipady=8, padx=10)

        if browsable:
            btn = self._browse_btn(row, lambda v=var: self._browse(v))
            btn.grid(row=0, column=3, rowspan=2, sticky="e", padx=(10, 0))

    def _filter_row(self, parent):
        row = tk.Frame(parent, bg=SURFACE)
        row.pack(fill="x", pady=5)
        row.columnconfigure(1, minsize=self._COL1_MINSIZE)   # matches _field_row
        row.columnconfigure(2, weight=1)
        row.columnconfigure(3, minsize=self._COL3_MINSIZE)   # matches _field_row

        tile = tk.Canvas(row, width=40, height=40, bg=SURFACE, highlightthickness=0)
        tile.grid(row=0, column=0, rowspan=2, padx=(0, 14), sticky="w")
        rounded_rect(tile, 1, 1, 39, 39, r=9, fill=PURPLE_DARK, outline="")
        tile.create_text(20, 20, text="⌦", font=("SF Pro Display", 15), fill=PURPLE)

        tk.Label(row, text="Folder Filter", font=FONT_UI_MED, fg=FG, bg=SURFACE).grid(
            row=0, column=1, sticky="sw", padx=(0, 16)
        )
        tk.Label(
            row, text="Include specific folders", font=FONT_SMALL, fg=FG_DIM, bg=SURFACE
        ).grid(row=1, column=1, sticky="nw", padx=(0, 16))

        ef_outer = tk.Frame(row, bg=BORDER2)
        ef_outer.grid(row=0, column=2, rowspan=2, sticky="ew")
        ef_inner = tk.Frame(ef_outer, bg=SURFACE2)
        ef_inner.pack(fill="x", padx=1, pady=1)

        self._filter_entry = tk.Entry(
            ef_inner,
            textvariable=self.filter_var,
            font=FONT_MONO,
            bg=SURFACE2,
            fg=FG,
            insertbackground=TEAL,
            relief="flat",
            highlightthickness=0,
            bd=0,
        )
        self._filter_entry.pack(fill="x", ipady=8, padx=10)

        # Badge wrapped in same border-frame structure as _browse_btn so
        # col 3 height is identical across all three rows.
        badge_outer = tk.Frame(row, bg=SURFACE)
        badge_outer.grid(row=0, column=3, rowspan=2, sticky="e", padx=(10, 0))
        badge_inner = tk.Frame(badge_outer, bg=SURFACE)
        badge_inner.pack(padx=1, pady=1)

        # Fixed-size canvas — no dynamic width changes so the column never shifts
        self._match_canvas = tk.Canvas(
            badge_inner,
            width=120,
            height=28,
            bg=SURFACE,
            highlightthickness=0,
        )
        self._match_canvas.pack()

        self.filter_var.trace_add("write", lambda *_: self._update_filter_match())
        self.input_var.trace_add("write", lambda *_: self._update_filter_match())

    def _browse_btn(self, parent, cmd):
        btn = tk.Frame(parent, bg=BORDER2, cursor="hand2")
        inner = tk.Frame(btn, bg=SURFACE2)
        inner.pack(padx=1, pady=1)
        lbl = tk.Label(
            inner,
            text="🗂  Browse",
            font=("SF Pro Display", 10),
            fg=FG_MID,
            bg=SURFACE2,
            padx=12,
            pady=6,
            width=10
        )
        lbl.pack()

        def _enter(e):
            inner.config(bg=SURFACE3)
            lbl.config(bg=SURFACE3)

        def _leave(e):
            inner.config(bg=SURFACE2)
            lbl.config(bg=SURFACE2)

        for w in (btn, inner, lbl):
            w.bind("<Enter>", _enter)
            w.bind("<Leave>", _leave)
            w.bind("<Button-1>", lambda e: cmd())
        return btn

    # ─────────────────────────────────────────────────────────
    #  Run bar
    # ─────────────────────────────────────────────────────────

    def _build_run_bar(self):
        outer = tk.Frame(self._main, bg=BG)
        outer.pack(fill="x", padx=24, pady=(0, 10))

        # ── Idle state ────────────────────────────────────────
        self._run_idle = tk.Canvas(
            outer, height=54, bg=BG, highlightthickness=0, cursor="hand2"
        )
        self._run_idle.pack(fill="x")
        self._run_idle.bind("<Configure>", lambda e: self._draw_idle_btn())
        self._run_idle.bind("<Button-1>", lambda e: self._on_run())
        self._run_idle.bind("<Enter>", lambda e: self._draw_idle_btn(hover=True))
        self._run_idle.bind("<Leave>", lambda e: self._draw_idle_btn(hover=False))

        # ── Running state ─────────────────────────────────────
        self._run_running = tk.Frame(outer, bg=BORDER2)
        run_inner = tk.Frame(self._run_running, bg=SURFACE)
        run_inner.pack(fill="x", padx=1, pady=1)

        left_panel = tk.Frame(run_inner, bg=SURFACE)
        left_panel.pack(side="left", fill="y", padx=(16, 0), pady=12)

        run_icon = tk.Canvas(
            left_panel, width=36, height=36, bg=SURFACE, highlightthickness=0
        )
        run_icon.pack(side="left", padx=(0, 12))
        rounded_rect(
            run_icon, 1, 1, 35, 35, r=18, fill=TEAL_DARK, outline=TEAL_DIM, width=1
        )
        run_icon.create_text(
            18, 18, text="▶", fill=TEAL, font=("SF Pro Display", 12, "bold")
        )

        txt_blk = tk.Frame(left_panel, bg=SURFACE)
        txt_blk.pack(side="left")
        tk.Label(
            txt_blk,
            text="Pipeline Running...",
            font=("SF Pro Display", 12, "bold"),
            fg=FG,
            bg=SURFACE,
        ).pack(anchor="w")
        tk.Label(
            txt_blk,
            text="Please wait while we process your assets",
            font=FONT_SMALL,
            fg=FG_DIM,
            bg=SURFACE,
        ).pack(anchor="w")

        tk.Frame(run_inner, bg=BORDER2, width=1).pack(
            side="left", fill="y", padx=24, pady=10
        )

        right_panel = tk.Frame(run_inner, bg=SURFACE)
        right_panel.pack(side="left", fill="y", pady=12)

        elapsed_blk = tk.Frame(right_panel, bg=SURFACE)
        elapsed_blk.pack(side="left", padx=(0, 32))
        tk.Label(
            elapsed_blk, text="⏱  Elapsed Time", font=FONT_SMALL, fg=FG_DIM, bg=SURFACE
        ).pack(anchor="w")
        tk.Label(
            elapsed_blk,
            textvariable=self._elapsed_var,
            font=("Menlo", 20, "bold"),
            fg=FG,
            bg=SURFACE,
        ).pack(anchor="w")

        eta_blk = tk.Frame(right_panel, bg=SURFACE)
        eta_blk.pack(side="left")
        tk.Label(eta_blk, text="⏱  ETA", font=FONT_SMALL, fg=FG_DIM, bg=SURFACE).pack(
            anchor="w"
        )
        tk.Label(
            eta_blk,
            textvariable=self._remain_var,
            font=("Menlo", 20, "bold"),
            fg=FG_MID,
            bg=SURFACE,
        ).pack(anchor="w")

        # ── Completed state ───────────────────────────────────
        self._run_done = tk.Frame(outer, bg="#0A3020")
        done_border = tk.Frame(self._run_done, bg=GREEN)
        done_border.pack(fill="x", padx=0, pady=0)
        done_inner = tk.Frame(done_border, bg="#0A2818", padx=18, pady=14)
        done_inner.pack(fill="x", padx=1, pady=1)

        done_left = tk.Frame(done_inner, bg="#0A2818")
        done_left.pack(side="left", fill="y")

        done_icon = tk.Canvas(
            done_left, width=42, height=42, bg="#0A2818", highlightthickness=0
        )
        done_icon.pack(side="left", padx=(0, 14))
        rounded_rect(
            done_icon, 1, 1, 41, 41, r=21, fill=GREEN_DARK, outline=GREEN, width=2
        )
        done_icon.create_text(
            21, 21, text="✓", fill=GREEN, font=("SF Pro Display", 18, "bold")
        )

        done_txt = tk.Frame(done_left, bg="#0A2818")
        done_txt.pack(side="left")
        tk.Label(
            done_txt,
            text="Processing Complete",
            font=("SF Pro Display", 13, "bold"),
            fg=GREEN,
            bg="#0A2818",
        ).pack(anchor="w")
        self._done_subtitle = tk.Label(
            done_txt,
            text="All assets processed successfully.",
            font=FONT_SMALL,
            fg="#5BE8A0",
            bg="#0A2818",
        )
        self._done_subtitle.pack(anchor="w")

        tk.Frame(done_inner, bg="#1A4030", width=1).pack(
            side="left", fill="y", padx=24, pady=4
        )

        done_right = tk.Frame(done_inner, bg="#0A2818")
        done_right.pack(side="left", fill="y")

        elapsed_done = tk.Frame(done_right, bg="#0A2818")
        elapsed_done.pack(side="left", padx=(0, 28))
        tk.Label(
            elapsed_done,
            text="⏱  Total Time",
            font=FONT_SMALL,
            fg="#5BE8A0",
            bg="#0A2818",
        ).pack(anchor="w")
        self._done_time_lbl = tk.Label(
            elapsed_done,
            text="00:00:00",
            font=("Menlo", 20, "bold"),
            fg=GREEN,
            bg="#0A2818",
        )
        self._done_time_lbl.pack(anchor="w")

        self._open_folder_btn = tk.Frame(done_right, bg="#1A4A30", cursor="hand2")
        self._open_folder_btn.pack(side="left", padx=(0, 4))
        obtn_inner = tk.Frame(self._open_folder_btn, bg="#1A4A30")
        obtn_inner.pack(padx=1, pady=1)
        obtn_lbl = tk.Label(
            obtn_inner,
            text="📂  Open Output Folder",
            font=("SF Pro Display", 11, "bold"),
            fg=GREEN,
            bg="#1A4A30",
            padx=16,
            pady=10,
        )
        obtn_lbl.pack()

        def _obtn_enter(e):
            obtn_inner.config(bg="#256040")
            obtn_lbl.config(bg="#256040")

        def _obtn_leave(e):
            obtn_inner.config(bg="#1A4A30")
            obtn_lbl.config(bg="#1A4A30")

        def _obtn_click(e):
            open_folder(self.output_var.get().strip())

        for w in (self._open_folder_btn, obtn_inner, obtn_lbl):
            w.bind("<Enter>", _obtn_enter)
            w.bind("<Leave>", _obtn_leave)
            w.bind("<Button-1>", _obtn_click)

        self._new_run_btn = tk.Frame(done_right, bg=SURFACE3, cursor="hand2")
        self._new_run_btn.pack(side="left", padx=(10, 0))

        nr_inner = tk.Frame(self._new_run_btn, bg=SURFACE3)
        nr_inner.pack(padx=1, pady=1)

        nr_lbl = tk.Label(
            nr_inner,
            text="↻  New Run",
            font=("SF Pro Display", 11, "bold"),
            fg=FG,
            bg=SURFACE3,
            padx=16,
            pady=10,
        )
        nr_lbl.pack()

        def _nr_enter(e):
            nr_inner.config(bg="#233247")
            nr_lbl.config(bg="#233247")

        def _nr_leave(e):
            nr_inner.config(bg=SURFACE3)
            nr_lbl.config(bg=SURFACE3)

        def _nr_click(e):
            self._reset_for_new_run()

        for w in (self._new_run_btn, nr_inner, nr_lbl):
            w.bind("<Enter>", _nr_enter)
            w.bind("<Leave>", _nr_leave)
            w.bind("<Button-1>", _nr_click)

        return outer

    # ─────────────────────────────────────────────────────────
    #  Idle button draw
    # ─────────────────────────────────────────────────────────

    def _draw_idle_btn(self, hover=False):
        c = self._run_idle
        c.delete("all")
        w = c.winfo_width()
        h = c.winfo_height() or 54
        if w < 2:
            self.after(50, self._draw_idle_btn)
            return

        rounded_rect(
            c, 2, 2, w - 2, h - 2, r=8,
            fill=TEAL_DIM,
            outline="#00E6B8" if hover else "",
            width=1,
        )

        icon_txt = "▶"
        label_txt = "  Start Processing"
        icon_w = 14
        label_w = 140
        total_w = icon_w + label_w
        cx = w // 2
        cy = h // 2

        icon_x = cx - total_w // 2
        label_x = icon_x + icon_w + 8

        c.create_text(
            icon_x, cy, text=icon_txt, fill="white",
            font=("SF Pro Display", 13, "bold"), anchor="w",
        )
        c.create_text(
            label_x, cy, text=label_txt, fill="white",
            font=("SF Pro Display", 13, "bold"), anchor="w",
        )

    def _set_run_btn_state(self, state: str):
        """state: 'idle' | 'running' | 'done'"""
        self._run_idle.pack_forget()
        self._run_running.pack_forget()
        self._run_done.pack_forget()

        if state == "idle":
            self._run_btn_enabled = True
            self._run_idle.pack(fill="x")
            self.after(10, self._draw_idle_btn)
        elif state == "running":
            self._run_btn_enabled = False
            self._run_running.pack(fill="x")
        elif state == "done":
            self._run_btn_enabled = True
            elapsed = time.time() - (self._start_time or time.time())
            self._done_time_lbl.config(text=self._fmt_time(elapsed))
            e_word = "error" if self._error_count == 1 else "errors"
            w_word = "warning" if self._warn_count == 1 else "warnings"
            subtitle = f"Finished in {self._fmt_time(elapsed)}"
            if self._error_count or self._warn_count:
                subtitle += (
                    f"  ·  {self._error_count} {e_word}, {self._warn_count} {w_word}"
                )
            self._done_subtitle.config(text=subtitle)
            self._run_done.pack(fill="x")

    # ─────────────────────────────────────────────────────────
    #  Section 2 — Activity
    # ─────────────────────────────────────────────────────────

    def _build_activity_section(self):
        self._activity_outer = tk.Frame(self._main, bg=BG)
        self._activity_outer.pack(fill="both", expand=True, padx=24, pady=(0, 20))

        border = tk.Frame(self._activity_outer, bg=BORDER2)
        border.pack(fill="both", expand=True)
        card = tk.Frame(border, bg=SURFACE, padx=18, pady=14)
        card.pack(fill="both", expand=True, padx=1, pady=1)

        # ── Header row ────────────────────────────────────────
        hdr = tk.Frame(card, bg=SURFACE)
        hdr.pack(fill="x", pady=(0, 8))

        left = tk.Frame(hdr, bg=SURFACE)
        left.pack(side="left")
        self._num_badge(left, "2", SURFACE)
        tk.Label(left, text="Activity", font=FONT_H1, fg=FG, bg=SURFACE).pack(
            side="left", padx=(8, 10)
        )
        tk.Label(
            left,
            text="Real-time logs from the pipeline run.",
            font=FONT_SMALL,
            fg=FG_DIM,
            bg=SURFACE,
        ).pack(side="left")

        right = tk.Frame(hdr, bg=SURFACE)
        right.pack(side="right")

        self._tabs: dict[str, tk.Canvas] = {}
        tab_specs = [
            ("activity", "Activity", TEAL, 80),
            ("warnings", "Warnings", AMBER, 100),
            ("errors", "Errors", RED, 80),
        ]
        for tid, lbl, col, w in tab_specs:
            tc = tk.Canvas(
                right, height=28, width=w, bg=SURFACE,
                highlightthickness=0, cursor="hand2",
            )
            tc.pack(side="left", padx=2)
            tc.bind("<Button-1>", lambda e, t=tid: self._switch_tab(t))
            self._tabs[tid] = tc

        tk.Frame(right, bg=BORDER2, width=1, height=20).pack(
            side="left", fill="y", padx=10
        )

        self._expand_btn = tk.Canvas(
            right, width=28, height=28, bg=SURFACE, highlightthickness=0, cursor="hand2"
        )
        self._expand_btn.pack(side="left")
        self._expand_btn.bind("<Button-1>", lambda e: self._toggle_log_expand())
        self._expand_btn.bind("<Configure>", lambda e: self._draw_expand_btn())

        # ── Log area ──────────────────────────────────────────
        log_border = tk.Frame(card, bg=BORDER2)
        log_border.pack(fill="both", expand=True, pady=(6, 0))

        log_inner = tk.Frame(log_border, bg=SURFACE2)
        log_inner.pack(fill="both", expand=True, padx=1, pady=1)

        self._log_text = tk.Text(
            log_inner,
            font=FONT_MONO,
            bg=SURFACE2,
            fg=FG,
            relief="flat",
            wrap="none",
            state="disabled",
            padx=14,
            pady=10,
            height=16,
            spacing1=3,
            spacing3=3,
        )
        vsb = tk.Scrollbar(
            log_inner,
            orient="vertical",
            command=self._log_text.yview,
            bg=SURFACE2,
            troughcolor=SURFACE2,
            activebackground=TEAL_DIM,
            width=6,
        )
        self._log_text.configure(yscrollcommand=vsb.set)
        vsb.pack(side="right", fill="y")
        self._log_text.pack(side="left", fill="both", expand=True)

        # Tags
        self._log_text.tag_config("ts", foreground=FG_DIM, font=FONT_MONO)
        self._log_text.tag_config("dot_info", foreground=BLUE)
        self._log_text.tag_config("dot_success", foreground=GREEN)
        self._log_text.tag_config("dot_warn", foreground=AMBER)
        self._log_text.tag_config("dot_error", foreground=RED)
        self._log_text.tag_config("badge_info", foreground=BLUE, font=("Menlo", 9, "bold"))
        self._log_text.tag_config("badge_succ", foreground=GREEN, font=("Menlo", 9, "bold"))
        self._log_text.tag_config("badge_warn", foreground=AMBER, font=("Menlo", 9, "bold"))
        self._log_text.tag_config("badge_err", foreground=RED, font=("Menlo", 9, "bold"))
        self._log_text.tag_config("pipe", foreground=BORDER2)
        self._log_text.tag_config("msg", foreground=FG_MID, font=FONT_MONO)
        self._log_text.tag_config("ticket_hdr", foreground=FG_DIM, font=("SF Pro Display", 9, "bold"))
        self._log_text.tag_config("divider", foreground=BORDER2)

        self._log_done_banner = tk.Frame(card, bg=GREEN_DARK)

        self._update_tab_styles()
        return self._activity_outer

    # ─────────────────────────────────────────────────────────
    #  Completion banner
    # ─────────────────────────────────────────────────────────

    def _show_completion_banner(self):
        for w in self._log_done_banner.winfo_children():
            w.destroy()

        elapsed = time.time() - (self._start_time or time.time())
        e_word = "error" if self._error_count == 1 else "errors"
        w_word = "warning" if self._warn_count == 1 else "warnings"

        row = tk.Frame(self._log_done_banner, bg=GREEN_DARK)
        row.pack(fill="x", padx=14, pady=8)

        tk.Label(
            row,
            text="✓  Pipeline finished",
            font=("SF Pro Display", 11, "bold"),
            fg=GREEN,
            bg=GREEN_DARK,
        ).pack(side="left")

        detail = f"  ·  {self._fmt_time(elapsed)}"
        if self._error_count or self._warn_count:
            detail += f"  ·  {self._error_count} {e_word}, {self._warn_count} {w_word}"
        tk.Label(row, text=detail, font=FONT_SMALL, fg="#5BE8A0", bg=GREEN_DARK).pack(
            side="left"
        )

        self._log_done_banner.pack(fill="x", pady=(4, 0))

    # ── Tabs ──────────────────────────────────────────────────

    def _draw_tab(self, canvas: tk.Canvas, label: str, active: bool, color: str):
        canvas.delete("all")
        w = int(canvas.cget("width"))
        h = int(canvas.cget("height"))
        if active:
            rounded_rect(
                canvas, 1, 1, w - 1, h - 1, r=6, fill=SURFACE3, outline=color, width=1
            )
            canvas.create_text(
                w // 2, h // 2, text=label, fill=color,
                font=("SF Pro Display", 10, "bold"),
            )
        else:
            canvas.create_text(
                w // 2, h // 2, text=label, fill=FG_DIM, font=("SF Pro Display", 10)
            )

    def _switch_tab(self, tab_id: str):
        self._active_tab = tab_id
        self._update_tab_styles()
        self._redraw_log()

    def _update_tab_styles(self):
        w_cnt = self._warn_count
        e_cnt = self._error_count
        warn_lbl = f"⚠ Warnings ({w_cnt})" if w_cnt else "⚠ Warnings"
        err_lbl = f"⊗ Errors ({e_cnt})" if e_cnt else "⊗ Errors"

        if "warnings" in self._tabs:
            new_w = max(100, 8 * (len(warn_lbl) + 2))
            self._tabs["warnings"].config(width=new_w)
        if "errors" in self._tabs:
            new_w = max(80, 8 * (len(err_lbl) + 2))
            self._tabs["errors"].config(width=new_w)

        labels = {"activity": "Activity", "warnings": warn_lbl, "errors": err_lbl}
        colors = {"activity": TEAL, "warnings": AMBER, "errors": RED}
        for tid, c in self._tabs.items():
            self._draw_tab(c, labels[tid], self._active_tab == tid, colors[tid])

    # ── Expand / collapse ─────────────────────────────────────

    def _draw_expand_btn(self):
        c = self._expand_btn
        c.delete("all")
        w = c.winfo_width() or 28
        h = c.winfo_height() or 28
        rounded_rect(c, 0, 0, w, h, r=5, fill=SURFACE2, outline=BORDER2, width=1)
        sym = "⤡" if self._log_expanded else "⤢"
        c.create_text(w // 2, h // 2, text=sym, fill=FG_MID, font=("SF Pro Display", 12))

    def _toggle_log_expand(self):
        self._log_expanded = not self._log_expanded
        if self._log_expanded:
            self._hdr_frame.pack_forget()
            self._cfg_frame.pack_forget()
            self._run_frame.pack_forget()
            self._activity_outer.pack(fill="both", expand=True, padx=24, pady=(20, 20))
        else:
            self._activity_outer.pack_forget()
            self._hdr_frame.pack(fill="x", padx=24, pady=(18, 12))
            self._cfg_frame.pack(fill="x", padx=24, pady=(0, 10))
            self._run_frame.pack(fill="x", padx=24, pady=(0, 10))
            self._activity_outer.pack(fill="both", expand=True, padx=24, pady=(0, 20))
        self._draw_expand_btn()

    # ─────────────────────────────────────────────────────────
    #  FIX: Filter badge — fixed canvas, no dynamic width resize
    # ─────────────────────────────────────────────────────────

    def _update_filter_match(self):
        c = self._match_canvas
        c.delete("all")
        W = int(c.cget("width"))   # fixed 120 — never resized
        H = int(c.cget("height"))
        cx, cy = W // 2, H // 2

        input_dir = self.input_var.get().strip()
        raw = self.filter_var.get().strip()

        if not input_dir or not Path(input_dir).is_dir():
            return

        try:
            if not raw:
                total = len([p for p in Path(input_dir).iterdir() if p.is_dir()])
                text, col, bg = f"all", FG_DIM, SURFACE3
            else:
                self._parse_filter(raw)
                matched = self._resolve_folders(input_dir)
                n = len(matched)
                text = f"✓ {n} matched" if n else "0 matched"
                col = TEAL if n else AMBER
                bg = TEAL_DARK if n else SURFACE3
        except ValueError:
            text, col, bg = "invalid", RED, SURFACE3

        pad = 4
        rounded_rect(c, pad, cy - 11, W - pad, cy + 11, r=10, fill=bg, outline=col, width=1)
        c.create_text(cx, cy, text=text, fill=col, font=("SF Pro Display", 9, "bold"))

    # ─────────────────────────────────────────────────────────
    #  Browse
    # ─────────────────────────────────────────────────────────

    def _browse(self, var: tk.StringVar):
        folder = filedialog.askdirectory(title="Select folder")
        if folder:
            var.set(folder)

    # ─────────────────────────────────────────────────────────
    #  Filter helpers
    # ─────────────────────────────────────────────────────────

    @staticmethod
    def _parse_filter(text: str) -> list[tuple]:
        import re

        text = text.strip()
        if not text:
            return []
        rules = []
        for token in re.split(r"[,;]\s*", text):
            token = token.strip()
            if not token:
                continue
            m = re.fullmatch(r"([A-Za-z]*)(\d+)\s*-\s*[A-Za-z]*(\d+)", token)
            if m:
                prefix, lo, hi = m.group(1), int(m.group(2)), int(m.group(3))
                if lo > hi:
                    lo, hi = hi, lo
                rules.append((prefix.upper(), lo, hi))
                continue
            m = re.fullmatch(r"([A-Za-z]*)(\d+)", token)
            if m:
                prefix, n = m.group(1), int(m.group(2))
                rules.append((prefix.upper(), n, n))
                continue
            raise ValueError(f"Unrecognised token: '{token}'")
        return rules

    def _folder_matches(self, name: str, rules: list[tuple]) -> bool:
        import re

        if not rules:
            return True
        m = re.fullmatch(r"([A-Za-z]*)(\d+)(.*)", name)
        if not m:
            return False
        prefix, num = m.group(1).upper(), int(m.group(2))
        for rule_prefix, lo, hi in rules:
            if rule_prefix and rule_prefix != prefix:
                continue
            if lo <= num <= hi:
                return True
        return False

    def _resolve_folders(self, input_dir: str) -> list[Path]:
        all_dirs = sorted(
            [p for p in Path(input_dir).iterdir() if p.is_dir()], key=lambda p: p.name
        )
        raw = self.filter_var.get().strip()
        try:
            rules = self._parse_filter(raw)
        except ValueError:
            rules = []
        return [d for d in all_dirs if self._folder_matches(d.name, rules)]

    # ─────────────────────────────────────────────────────────
    #  Run pipeline
    # ─────────────────────────────────────────────────────────

    def _on_run(self):
        # to remove later
        # INPUT_DIR = "/Users/oumeir/company-workspace/horizon-asset-traversal/all-tickets"
        # OUTPUT_DIR = "/Users/oumeir/company-workspace/horizon-asset-traversal/output"

        INPUT_DIR = ""
        OUTPUT_DIR = ""
        
        if not self._run_btn_enabled:
            return
        input_dir = self.input_var.get().strip() or INPUT_DIR
        output_dir = self.output_var.get().strip() or OUTPUT_DIR
        if not input_dir or not Path(input_dir).is_dir():
            return
        if not output_dir:
            return
        folders = self._resolve_folders(input_dir)
        if not folders:
            return

        self._total_tickets = len(folders)
        self._all_logs.clear()
        self._error_count = 0
        self._warn_count = 0
        self._running = True
        self._completed = False
        self._start_time = time.time()
        self._last_error_ticket = None
        self._last_warn_ticket = None
        self._clear_log()
        self._log_done_banner.pack_forget()
        self._update_tab_styles()
        self._elapsed_var.set("00:00:00")
        self._remain_var.set("--:--:--")

        self._set_run_btn_state("running")
        pipeline.set_log_sink(self._on_log_entry)

        threading.Thread(
            target=self._run_pipeline,
            args=(input_dir, output_dir, [str(f) for f in folders]),
            daemon=True,
        ).start()
        self._tick_timer()

    def _run_pipeline(self, input_dir: str, output_dir: str, folders: list[str]):
        try:
            pipeline.process_all(root=input_dir, output_dir=output_dir, folders=folders)
            self.after(0, self._on_done, None)
        except Exception as exc:
            self.after(0, self._on_done, str(exc))

    def _on_done(self, error: str | None):
        self._running = False
        self._completed = True
        pipeline.set_log_sink(None)
        self._set_run_btn_state("done")
        self._show_completion_banner()

    def _reset_for_new_run(self):
        """Reset UI after completion while keeping folder selections."""
        self._running = False
        self._completed = False
        self._all_logs.clear()
        self._error_count = 0
        self._warn_count = 0
        self._current_ticket = None
        self._last_error_ticket = None
        self._last_warn_ticket = None
        self._start_time = None
        self._total_tickets = 0
        self._elapsed_var.set("00:00:00")
        self._remain_var.set("--:--:--")
        self._active_tab = "activity"
        self._clear_log()
        self._log_done_banner.pack_forget()
        self._update_tab_styles()
        self._set_run_btn_state("idle")

    # ─────────────────────────────────────────────────────────
    #  Timer
    # ─────────────────────────────────────────────────────────

    def _tick_timer(self):
        if not self._running:
            return
        elapsed = time.time() - (self._start_time or time.time())
        self._elapsed_var.set(self._fmt_time(elapsed))
        est = self._total_tickets * AVG_SECS_PER_TICKET
        remain = max(0.0, est - elapsed) if est > 0 else 0.0
        self._remain_var.set(self._fmt_time(remain))
        self.after(1000, self._tick_timer)

    @staticmethod
    def _fmt_time(s: float) -> str:
        s = int(s)
        h, rem = divmod(s, 3600)
        m, sec = divmod(rem, 60)
        return f"{h:02d}:{m:02d}:{sec:02d}"

    # ─────────────────────────────────────────────────────────
    #  Log handling
    # ─────────────────────────────────────────────────────────

    def _on_log_entry(self, entry: LogEntry):
        if "── TICKET:" in entry.message:
            try:
                self._current_ticket = (
                    entry.message.split("TICKET:")[1].split("──")[0].strip()
                )
            except Exception:
                pass
        self._all_logs.append(entry)
        if entry.level == LogType.ERROR:
            self._error_count += 1
            self.after(0, self._update_tab_styles)
        elif entry.level == LogType.WARNING:
            self._warn_count += 1
            self.after(0, self._update_tab_styles)
        self.after(0, self._append_entry_to_log, entry)

    def _append_entry_to_log(self, entry: LogEntry):
        if self._active_tab == "errors":
            if entry.level == LogType.ERROR:
                if (
                    self._current_ticket
                    and self._last_error_ticket != self._current_ticket
                ):
                    for e in reversed(self._all_logs):
                        if "── TICKET:" in e.message:
                            self._write_entry(e)
                            break
                    self._last_error_ticket = self._current_ticket
                self._write_entry(entry)
        elif self._active_tab == "warnings":
            if entry.level == LogType.WARNING:
                if (
                    self._current_ticket
                    and self._last_warn_ticket != self._current_ticket
                ):
                    for e in reversed(self._all_logs):
                        if "── TICKET:" in e.message:
                            self._write_entry(e)
                            break
                    self._last_warn_ticket = self._current_ticket
                self._write_entry(entry)
        else:
            self._write_entry(entry)

    def _write_entry(self, entry: LogEntry):
        self._log_text.config(state="normal")
        msg = entry.message

        if "── TICKET:" in msg:
            try:
                ticket_name = msg.split("TICKET:")[1].split("──")[0].strip()
            except Exception:
                ticket_name = msg
            self._log_text.insert("end", "\n", "divider")
            self._log_text.insert(
                "end",
                f"  ── {ticket_name} {'─'*max(0,52-len(ticket_name))}\n",
                "ticket_hdr",
            )
            self._log_text.insert("end", "\n", "divider")
            self._log_text.config(state="disabled")
            self._log_text.see("end")
            return

        ts = entry.timestamp.strftime("%H:%M:%S")
        lvl = entry.level.value

        dot_tag = {
            "INFO": "dot_info",
            "SUCCESS": "dot_success",
            "WARNING": "dot_warn",
            "ERROR": "dot_error",
        }.get(lvl, "dot_info")
        badge_tag = {
            "INFO": "badge_info",
            "SUCCESS": "badge_succ",
            "WARNING": "badge_warn",
            "ERROR": "badge_err",
        }.get(lvl, "badge_info")
        badge_txt = {
            "INFO": "INFO   ",
            "SUCCESS": "SUCCESS",
            "WARNING": "WARNING",
            "ERROR": "ERROR  ",
        }.get(lvl, lvl)

        self._log_text.insert("end", "  ● ", dot_tag)
        self._log_text.insert("end", f"{ts}  ", "ts")
        self._log_text.insert("end", f" {badge_txt} ", badge_tag)
        self._log_text.insert("end", "  |  ", "pipe")
        self._log_text.insert("end", f"{msg}\n", "msg")
        self._log_text.config(state="disabled")
        self._log_text.see("end")

    def _redraw_log(self):
        self._log_text.config(state="normal")
        self._log_text.delete("1.0", "end")
        self._log_text.config(state="disabled")

        if self._active_tab in ("errors", "warnings"):
            target = LogType.ERROR if self._active_tab == "errors" else LogType.WARNING
            sections: list[tuple] = []
            cur_ticket = None
            cur_entries: list[LogEntry] = []
            for e in self._all_logs:
                if "── TICKET:" in e.message:
                    if cur_ticket and cur_entries:
                        sections.append((cur_ticket, cur_entries))
                    cur_ticket = e
                    cur_entries = []
                elif e.level == target:
                    cur_entries.append(e)
            if cur_ticket and cur_entries:
                sections.append((cur_ticket, cur_entries))
            for te, entries in sections:
                self._write_entry(te)
                for e in entries:
                    self._write_entry(e)
        else:
            for e in self._all_logs:
                self._write_entry(e)

    def _clear_log(self):
        self._log_text.config(state="normal")
        self._log_text.delete("1.0", "end")
        self._log_text.config(state="disabled")


# ═════════════════════════════════════════════════════════════
#  Entry point
# ═════════════════════════════════════════════════════════════

if __name__ == "__main__":
    app = App()
    app.mainloop()