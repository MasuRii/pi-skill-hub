import type { Component, Focusable } from "@earendil-works/pi-tui";

/**
 * Shared base for modal components implementing the {@link Focusable} contract.
 *
 * Centralizes the `focused` backing field and the trivial `focused`
 * getter/setter so each modal does not re-declare the same accessor pair.
 * Subclasses may override the setter when focus needs to propagate to an
 * embedded input (see `SkillBrowserModal`).
 */
export abstract class FocusableComponent implements Component, Focusable {
  protected focusedValue = false;

  public get focused(): boolean {
    return this.focusedValue;
  }

  public set focused(value: boolean) {
    this.focusedValue = value;
  }

  public abstract render(width: number): string[];
  public abstract invalidate(): void;
  public abstract handleInput(data: string): void;
}
