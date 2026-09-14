import { render, screen } from "@testing-library/react";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders an honest state and optional recovery action", () => {
    render(<EmptyState eyebrow="LIBRARY / EMPTY" title="No library synchronized." body="Connect real music first." action={{ href: "/connect", label: "Connect music" }} />);
    expect(screen.getByRole("heading", { name: "No library synchronized." })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Connect music/ })).toHaveAttribute("href", "/connect");
  });
});

