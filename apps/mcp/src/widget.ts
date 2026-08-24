import { App } from "@modelcontextprotocol/ext-apps";

type ViewData = Record<string, unknown> & { view?: string };

const root = document.querySelector<HTMLElement>("#app")!;
const app = new App({ name: "NavoCMS review", version: "0.1.0" }, {}, { autoResize: true, strict: true });

app.addEventListener("toolresult", (result) => {
  const data = (result.structuredContent ?? {}) as ViewData;
  render(data);
});

app.addEventListener("hostcontextchanged", (context) => {
  document.documentElement.dataset.theme = context.theme ?? "light";
});

void app.connect().catch(() => {
  root.innerHTML = `<div class="empty"><strong>Review unavailable</strong><span>The host did not complete the MCP Apps handshake.</span></div>`;
});

function render(data: ViewData): void {
  if (data.view === "markdown") return renderMarkdown(data);
  if (data.view === "diff") return renderDiff(data);
  if (data.view === "drafts") return renderDrafts(data);
  if (data.view === "workflow") return renderWorkflow(data);
  if (data.view === "media") return renderMedia(data);
  root.innerHTML = `<div class="empty"><strong>No review data</strong><span>Ask the agent to open a revision, diff, draft queue, or preview status.</span></div>`;
}

function renderMedia(data: ViewData): void {
  const provenance = object(data.provenance);
  const rights = object(data.rights);
  const references = Array.isArray(data.references) ? data.references : [];
  const rows = [
    ["State", value(data.state, "—")], ["SHA-256", value(data.sha256, "pending")], ["MIME", value(data.mediaType, "—")],
    ["Bytes", value(data.byteSize, "—")], ["Dimensions", data.width && data.height ? `${value(data.width, "?")} × ${value(data.height, "?")}` : "—"],
    ["Provenance", value(provenance.kind, "—")], ["Source", value(provenance.sourceUrl, "direct upload")],
    ["Received", value(provenance.receivedAt, "—")], ["Received by", value(provenance.receivedBy, "—")],
    ["Rights", value(rights.license, "—")], ["Rights holder", value(rights.holder, "—")],
    ["Rights expiry", value(rights.expiresAt, "—")], ["Restricted", value(rights.restricted, "—")],
    ["Rejected", value(data.rejectionReason, "—")]
  ].map(([label, detail]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(detail)}</dd>`).join("");
  const referenceRows = references.map((item) => {
    const reference = object(item);
    return `<li><strong>${escapeHtml(value(reference.ownerType, "reference"))}</strong> · ${escapeHtml(value(reference.purpose, "—"))}<br><code>${escapeHtml(value(reference.ownerId, "unknown owner"))}</code> · ${escapeHtml(value(reference.createdAt, "unknown date"))}</li>`;
  }).join("");
  root.innerHTML = shell(
    "Media review", value(data.state, "—"), shortHash(data.sha256),
    `<section class="proof"><h1>Asset integrity</h1><dl>${rows}</dl><h2>References</h2><ul>${referenceRows || "<li>None</li>"}</ul></section>`,
    "Read-only site-scoped media metadata"
  );
}

function renderMarkdown(data: ViewData): void {
  root.innerHTML = shell(
    "Revision",
    value(data.revisionNumber, "—"),
    value(data.sourceHash, "unknown"),
    `<article class="proof"><h1>${escapeHtml(value(data.title, "Untitled"))}</h1><pre>${escapeHtml(value(data.markdown, ""))}</pre></article>`,
    data.truncated === true ? "Bounded view · open the revision in chunks for the remainder" : "Complete Markdown source"
  );
}

function renderDiff(data: ViewData): void {
  const raw = Array.isArray(data.lines) ? data.lines : [];
  const lines = raw.map((item, index) => {
    const line = object(item);
    const kind = value(line.kind, "context");
    const marker = kind === "add" ? "+" : kind === "remove" ? "−" : " ";
    return `<div class="diff-line ${escapeHtml(kind)}"><span>${String(index + 1).padStart(3, "0")}</span><b>${marker}</b><code>${escapeHtml(value(line.line, ""))}</code></div>`;
  }).join("");
  root.innerHTML = shell(
    "Change set",
    `${raw.length} lines`,
    `${shortHash(data.fromHash)} → ${shortHash(data.toHash)}`,
    `<div class="diff">${lines || `<div class="empty">No textual changes.</div>`}</div>`,
    data.truncated === true ? "Diff is bounded; ask the agent for a narrower comparison" : "Exact structural patch result"
  );
}

function renderDrafts(data: ViewData): void {
  const drafts = Array.isArray(data.drafts) ? data.drafts : [];
  const cards = drafts.map((item) => {
    const draft = object(item);
    return `<article class="draft"><div><span class="type">${escapeHtml(value(draft.typeName, "content"))}</span><h2>${escapeHtml(value(draft.title, "Untitled"))}</h2><p>/${escapeHtml(value(draft.slug, ""))} · ${escapeHtml(value(draft.locale, ""))}</p></div><div class="revision">r${escapeHtml(value(draft.revisionNumber, "?"))}<small>${escapeHtml(shortHash(draft.sourceHash))}</small></div></article>`;
  }).join("");
  root.innerHTML = shell(
    "Draft queue",
    String(drafts.length),
    "site scoped",
    `<div class="drafts">${cards || `<div class="empty"><strong>No drafts</strong><span>Ask the agent to create one from Markdown.</span></div>`}</div>`,
    "Only drafts in the authorized site are shown"
  );
}

function renderWorkflow(data: ViewData): void {
  const ready = data.status === "ready-for-workflow";
  root.innerHTML = shell(
    "Preview handoff",
    ready ? "Ready" : "Blocked",
    shortHash(data.sourceHash),
    `<div class="handoff"><div class="pulse" aria-hidden="true"></div><div><h1>${ready ? "Revision is bound" : "Preview is blocked"}</h1><p>${escapeHtml(value(data.note, "No workflow detail was returned."))}</p><dl><dt>Workflow</dt><dd>${escapeHtml(value(data.workflow, "—"))}</dd><dt>Next step</dt><dd>${escapeHtml(value(data.nextStep, "—"))}</dd><dt>Public URL</dt><dd>Not created</dd></dl></div></div>`,
    "No public or indexable preview is created in this step"
  );
}

function shell(label: string, measure: string, hash: string, body: string, footer: string): string {
  return `<main class="sheet"><aside class="spine"><span>${escapeHtml(label)}</span><strong>${escapeHtml(measure)}</strong><code>${escapeHtml(hash)}</code></aside><section class="content">${body}<footer>${escapeHtml(footer)}</footer></section></main>`;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function value(value: unknown, fallback: string): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : fallback;
}

function shortHash(input: unknown): string {
  return value(input, "unknown").slice(0, 10);
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[character]!);
}
