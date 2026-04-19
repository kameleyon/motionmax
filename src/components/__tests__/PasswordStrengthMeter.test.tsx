/// <reference types="vitest/globals" />
import React from "react";
import { render, screen } from "@testing-library/react";
import {
  getPasswordStrength,
  PasswordStrengthMeter,
} from "@/components/ui/password-strength";

// ── getPasswordStrength (pure function) ──────────────────────────────────────

describe("getPasswordStrength", () => {
  it("returns score 0 and empty label for empty password", () => {
    const result = getPasswordStrength("");
    expect(result.score).toBe(0);
    expect(result.label).toBe("");
  });

  it("scores Weak for a short lowercase-only password", () => {
    // length < 8 → +10, no uppercase → 0, no digit → 0, no special → 0
    const result = getPasswordStrength("abc");
    expect(result.score).toBeLessThanOrEqual(25);
    expect(result.label).toBe("Weak");
    expect(result.color).toBe("bg-destructive");
  });

  it("scores Fair for 8+ chars with mixed case only", () => {
    // length ≥8 → +25, mixed case → +25 = 50
    const result = getPasswordStrength("Abcdefgh");
    expect(result.score).toBe(50);
    expect(result.label).toBe("Fair");
    expect(result.color).toBe("bg-orange-500");
  });

  it("scores Good for 8+ chars with mixed case and a digit", () => {
    // length ≥8 → +25, mixed case → +25, digit → +25 = 75
    const result = getPasswordStrength("Abcdefg1");
    expect(result.score).toBe(75);
    expect(result.label).toBe("Good");
    expect(result.color).toBe("bg-yellow-500");
  });

  it("scores Strong for a fully complex password", () => {
    // length ≥8 → +25, mixed case → +25, digit → +25, special → +25 = 100
    const result = getPasswordStrength("Abcdefg1!");
    expect(result.score).toBe(100);
    expect(result.label).toBe("Strong");
    expect(result.color).toBe("bg-primary");
  });
});

// ── PasswordStrengthMeter (component) ────────────────────────────────────────

describe("PasswordStrengthMeter", () => {
  it("renders nothing when password is empty", () => {
    const { container } = render(<PasswordStrengthMeter password="" />);
    expect(container.firstChild).toBeNull();
  });

  it("shows Weak label for a weak password", () => {
    render(<PasswordStrengthMeter password="abc" />);
    expect(screen.getByText("Weak")).toBeDefined();
  });

  it("shows Strong label for a strong password", () => {
    render(<PasswordStrengthMeter password="Abcdefg1!" />);
    expect(screen.getByText("Strong")).toBeDefined();
  });

  it("renders requirement checklist by default", () => {
    render(<PasswordStrengthMeter password="abc" />);
    expect(screen.getByText(/At least 8 characters/)).toBeDefined();
    expect(screen.getByText(/Uppercase and lowercase/)).toBeDefined();
    expect(screen.getByText(/at least one number/i)).toBeDefined();
    expect(screen.getByText(/special character/i)).toBeDefined();
  });

  it("hides requirement checklist when showRequirements is false", () => {
    render(<PasswordStrengthMeter password="abc" showRequirements={false} />);
    expect(screen.queryByText(/At least 8 characters/)).toBeNull();
  });

  it("renders an accessible progress bar element", () => {
    render(<PasswordStrengthMeter password="Abcdefg1!" />);
    // Radix Progress.Root renders role="progressbar" — verifies the a11y landmark is present
    expect(screen.getByRole("progressbar")).toBeDefined();
  });
});
