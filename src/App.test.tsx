import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
  it("identifies the Tauri migration workspace", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "X Traversal" })).toBeVisible();
    expect(screen.getByText(/Python application remains available/i)).toBeVisible();
  });
});
