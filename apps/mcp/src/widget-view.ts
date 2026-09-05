/**
 * Pure rendering helpers for the MCP Apps review widget. Kept free of DOM and
 * MCP Apps imports so the workflow handoff decision is unit-testable.
 */

export interface WorkflowViewData {
  readonly status?: unknown;
  readonly note?: unknown;
  readonly workflow?: unknown;
  readonly nextStep?: unknown;
  readonly previewUrl?: unknown;
  readonly expiresAt?: unknown;
  readonly sourceHash?: unknown;
}

/**
 * `preview_prepare` returns `previewed` for a valid bound preview. The older
 * `ready-for-workflow` value is accepted for backwards compatibility; anything
 * else renders as blocked.
 */
export function workflowReady(status: unknown): boolean {
  return status === "previewed" || status === "ready-for-workflow";
}

export function workflowHandoffMarkup(data: WorkflowViewData): string {
  const ready = workflowReady(data.status);
  const url = typeof data.previewUrl === "string" && data.previewUrl.length > 0 ? data.previewUrl : undefined;
  const detail = ready
    ? `<p>${escapeHtml(value(data.note, "The revision is bound to an exact release and artifact hash.") )}</p><dl><dt>Workflow</dt><dd>${escapeHtml(value(data.workflow, "—"))}</dd><dt>Next step</dt><dd>${escapeHtml(value(data.nextStep, "—"))}</dd><dt>Capability URL</dt><dd>${url ? `<a href="${escapeHtml(url)}" rel="noopener noreferrer nofollow">${escapeHtml(url)}</a>` : "Not created"}</dd><dt>Expires</dt><dd>${escapeHtml(value(data.expiresAt, "—"))}</dd></dl><p class="handoff-note">The capability URL renders a Markdown proof artifact, not the final site design preview; the rendered-design preview arrives in a later release.</p>`
    : `<p>${escapeHtml(value(data.note, "No workflow detail was returned."))}</p><dl><dt>Workflow</dt><dd>${escapeHtml(value(data.workflow, "—"))}</dd><dt>Next step</dt><dd>${escapeHtml(value(data.nextStep, "—"))}</dd><dt>Capability URL</dt><dd>Not created</dd></dl>`;
  return `<div class="handoff"><div class="pulse" aria-hidden="true"></div><div><h1>${ready ? "Revision is bound" : "Preview is blocked"}</h1>${detail}</div></div>`;
}

function value(value: unknown, fallback: string): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : fallback;
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[character]!);
}
