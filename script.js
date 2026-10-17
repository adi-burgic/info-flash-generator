// =============================================================================
// Info Flash Generator — frontend logic
//
// 1. Manages the 1–6 department cards (add / remove / character counters)
// 2. Validates the form and sends it to /api/generate
// 3. Builds the report on the page SAFELY (createElement + textContent, never
//    innerHTML with AI text, so the AI can't inject HTML or scripts)
// 4. Copy as text, copy for email (HTML for Outlook) and download PDF (print)
// =============================================================================

const MAX_DEPARTMENTS = 6;
const MAX_NOTES_CHARS = 1500;
const REQUEST_TIMEOUT_MS = 45000;

// Fixed report headings in both languages. They come from here, not from the AI,
// so they always look exactly the same in every Info Flash.
const LABELS = {
  en: {
    kicker: "Bi-weekly summary for heads of departments",
    highlights: "Key highlights",
    actions: "Action items / decisions needed",
  },
  sl: {
    kicker: "Dvotedenski povzetek za vodje oddelkov",
    highlights: "Ključni poudarki",
    actions: "Naloge / potrebne odločitve",
  },
};

// Made-up example: a fictional car factory. No real company data.
const EXAMPLE_YEAR = new Date().getFullYear();
const EXAMPLE = {
  startDate: `${EXAMPLE_YEAR}-11-01`,
  endDate: `${EXAMPLE_YEAR}-11-14`,
  departments: [
    {
      name: "Production",
      notes: `- line 2 output 4,860 cars vs plan 5,000 (-2.8%) -> mainly robot cell 14 stoppage on 6 Nov, approx 5h down
- new door assembly fixture on line 1 installed, cycle time 62s -> 58s
- absenteeism 4.1% (last period 5.3%)
- saturday shift 22 Nov?? need decision from management by 18 Nov otherwise we cant plan staff
- 12 new operators finished onboarding, start on line 2 monday`,
    },
    {
      name: "Quality",
      notes: `fwd from Marko: "Hi all, first pass yield line 1 was 93.4% this period, target is 94%. Main defect still orange peel on the roof paint, around 40% of all defects."

- fleet customer audit 12 Nov PASSED, 2 minor findings, corrective actions due 30 Nov
- new torque check station on line 2 running since 4 Nov, no escapes since then
- need approval for 2nd paint inspection camera, offer is 38,500 EUR`,
    },
    {
      name: "Logistics",
      notes: `seat frame supplier late 3x this period (worst one 9h on 10 Nov) - no line stop thanks to safety stock
- BUT safety stock seat frames now only 1.5 days, we want back to 3 days -> talking to purchasing
- new AGV route to line 1 live since 3 Nov, freed up 2 forklifts
- inbound trucks 412 (prev period 398)
- inventory count 28–29 Nov!! all departments pls no material movements booked after 14:00 on 28 Nov`,
    },
  ],
};

// ---- Elements ----
const form = document.getElementById("flashForm");
const startInput = document.getElementById("startDate");
const endInput = document.getElementById("endDate");
const deptsBox = document.getElementById("depts");
const deptTemplate = document.getElementById("deptTemplate");
const deptCount = document.getElementById("deptCount");
const addDeptBtn = document.getElementById("addDeptBtn");
const exampleBtn = document.getElementById("exampleBtn");
const generateBtn = document.getElementById("generateBtn");
const errorMsg = document.getElementById("errorMsg");
const resultSection = document.getElementById("result");
const reportEl = document.getElementById("report");

// The last report the server sent back. The copy/PDF buttons use it.
let currentReport = null;

// =============================================================================
// 1. DEPARTMENT CARDS
// =============================================================================

function addDepartment(name = "", notes = "") {
  if (deptsBox.children.length >= MAX_DEPARTMENTS) return;

  const card = deptTemplate.content.firstElementChild.cloneNode(true);
  const nameInput = card.querySelector(".dept__name");
  const notesInput = card.querySelector(".dept__notes");
  const chars = card.querySelector(".dept__chars");

  nameInput.value = name;
  notesInput.value = notes;

  // Live character counter (turns orange near the limit)
  const updateCounter = () => {
    chars.textContent = notesInput.value.length;
    chars.parentElement.classList.toggle("is-near-limit", notesInput.value.length > MAX_NOTES_CHARS * 0.9);
  };
  notesInput.addEventListener("input", updateCounter);
  updateCounter();

  // Typing in a field clears its red "invalid" outline
  for (const input of [nameInput, notesInput]) {
    input.addEventListener("input", () => input.removeAttribute("aria-invalid"));
  }

  card.querySelector(".dept__remove").addEventListener("click", () => {
    card.remove();
    updateDeptControls();
  });

  deptsBox.appendChild(card);
  updateDeptControls();
  return card;
}

// Keeps the counter, labels and buttons in sync with the number of cards.
function updateDeptControls() {
  const cards = [...deptsBox.children];
  deptCount.textContent = `${cards.length} / ${MAX_DEPARTMENTS}`;
  addDeptBtn.disabled = cards.length >= MAX_DEPARTMENTS;

  cards.forEach((card, i) => {
    // Accessible names for screen readers ("Department 2 name", ...)
    card.querySelector(".dept__name").setAttribute("aria-label", `Department ${i + 1} name`);
    card.querySelector(".dept__notes").setAttribute("aria-label", `Department ${i + 1} notes`);
    const removeBtn = card.querySelector(".dept__remove");
    removeBtn.setAttribute("aria-label", `Remove department ${i + 1}`);
    removeBtn.disabled = cards.length === 1; // always keep at least one
  });
}

addDeptBtn.addEventListener("click", () => {
  const card = addDepartment();
  card?.querySelector(".dept__name").focus();
});

// "2026-10-18" in local time (toISOString would use UTC and can be a day off)
function toDateValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Default period: the last two weeks, ending today
const today = new Date();
endInput.value = toDateValue(today);
startInput.value = toDateValue(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 13));

for (const input of [startInput, endInput]) {
  input.addEventListener("input", () => {
    startInput.removeAttribute("aria-invalid");
    endInput.removeAttribute("aria-invalid");
  });
}

exampleBtn.addEventListener("click", () => {
  startInput.value = EXAMPLE.startDate;
  endInput.value = EXAMPLE.endDate;
  startInput.removeAttribute("aria-invalid");
  endInput.removeAttribute("aria-invalid");
  deptsBox.replaceChildren();
  EXAMPLE.departments.forEach((d) => addDepartment(d.name, d.notes));
  hideError();
});

// Start with two empty departments
addDepartment();
addDepartment();

// =============================================================================
// 2. VALIDATE + SEND
// =============================================================================

// Reads the form. Returns { data } or { error, field } for the first problem found.
function readForm() {
  const startDate = startInput.value; // "2026-10-01", or "" if empty/invalid
  const endDate = endInput.value;
  const language = form.querySelector('input[name="language"]:checked').value;
  if (!startDate) return { error: "Please choose the start date of the period.", field: startInput };
  if (!endDate) return { error: "Please choose the end date of the period.", field: endInput };
  // Same format on both sides, so comparing the strings compares the dates
  if (endDate < startDate) return { error: "The end date can't be before the start date.", field: endInput };

  const departments = [];
  for (const [i, card] of [...deptsBox.children].entries()) {
    const nameInput = card.querySelector(".dept__name");
    const notesInput = card.querySelector(".dept__notes");
    const name = nameInput.value.trim();
    const notes = notesInput.value.trim();

    if (!name) return { error: `Department ${i + 1} needs a name.`, field: nameInput };
    if (!notes) return { error: `Please add notes for ${name}.`, field: notesInput };
    if (notes.length > MAX_NOTES_CHARS) {
      return { error: `Notes for ${name} are too long (max ${MAX_NOTES_CHARS} characters).`, field: notesInput };
    }
    departments.push({ name, notes });
  }
  if (departments.length === 0) return { error: "Please add at least one department.", field: addDeptBtn };

  return { data: { startDate, endDate, language, departments } };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideError();

  const { data, error, field } = readForm();
  if (error) {
    showError(error);
    field.setAttribute("aria-invalid", "true");
    field.focus();
    return;
  }

  setLoading(true);
  // Give up after 45 s so the button never spins forever
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    // Only fetch() itself gets the "can't reach the server" message: it fails only
    // when no answer arrives at all (server down, offline, or our 45 s timeout).
    let response;
    try {
      response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(
        err.name === "AbortError"
          ? "The request took too long. Please try again."
          : "Could not reach the server. Make sure it is running, then try again."
      );
    }

    // The server always answers with JSON, but a crashed function might not
    const body = await response.json().catch(() => ({}));

    if (response.status === 429) throw new Error("Too many requests, try again in a minute.");
    if (!response.ok) throw new Error(body.error || "Something went wrong. Please try again.");

    currentReport = body;
    renderReport(body);
    resultSection.hidden = false;
    resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    console.error(err); // full details in the browser console (F12) for debugging
    showError(err.message);
  } finally {
    clearTimeout(timer);
    setLoading(false);
  }
});

function setLoading(isLoading) {
  generateBtn.disabled = isLoading;
  generateBtn.replaceChildren();
  if (isLoading) {
    generateBtn.append(el("span", "spinner"), "Generating…");
  } else {
    generateBtn.textContent = "Generate Info Flash";
  }
}

function showError(message) {
  errorMsg.textContent = message;
  errorMsg.hidden = false;
}

function hideError() {
  errorMsg.hidden = true;
}

// =============================================================================
// 3. RENDER THE REPORT (safe: textContent only)
// =============================================================================

// Small helper: el("li", "class", "text") -> <li class="class">text</li>
// Text is set with textContent, so any "<script>" from the AI stays plain text.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The report as a list of { title, bullets, variant } sections, where every
// bullet is { label, text }. Only key highlights have a label (the department).
// Used by the page, the plain-text copy and the email copy, so all three match.
function reportSections(report) {
  const labels = LABELS[report.language];
  const plain = (list) => list.map((text) => ({ label: "", text }));
  const highlights = report.highlights.map((h) => ({ label: h.department, text: h.text }));

  const sections = [{ title: labels.highlights, bullets: highlights, variant: "highlights" }];
  for (const dept of report.departments) {
    sections.push({ title: dept.name, bullets: plain(dept.bullets), variant: "dept" });
  }
  // Only shown if the notes contained action items
  if (report.actionItems.length > 0) {
    sections.push({ title: labels.actions, bullets: plain(report.actionItems), variant: "actions" });
  }
  return sections;
}

function renderReport(report) {
  const labels = LABELS[report.language];
  reportEl.lang = report.language; // correct hyphenation / screen reader voice

  const head = el("header", "report__head");
  head.append(
    el("p", "report__kicker", labels.kicker),
    el("h2", "report__title", "Info Flash"),
    el("p", "report__period", report.period)
  );

  const sections = reportSections(report).map(({ title, bullets, variant }) => {
    const section = el("section", `report__section report__section--${variant}`);
    const list = el("ul");
    bullets.forEach(({ label, text }) => {
      const item = el("li");
      if (label) item.append(el("span", "report__dept", `${label}: `));
      item.append(text); // append() with a string adds plain text, never HTML
      list.append(item);
    });
    section.append(el("h3", "", title), list);
    return section;
  });

  reportEl.replaceChildren(head, ...sections);
}

// =============================================================================
// 4. COPY + PDF
// =============================================================================

function reportToText(report) {
  const lines = ["INFO FLASH", report.period];
  for (const { title, bullets } of reportSections(report)) {
    lines.push("", title.toLocaleUpperCase(report.language));
    bullets.forEach(({ label, text }) => lines.push(`• ${label ? `${label}: ` : ""}${text}`));
  }
  return lines.join("\n");
}

// Escapes text before it goes into the email HTML string.
// This string is only put on the clipboard, never into our page.
function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// HTML with INLINE styles: Outlook ignores <style> blocks and CSS classes
// when you paste, but keeps inline styles.
function reportToEmailHtml(report) {
  const labels = LABELS[report.language];
  const font = "font-family:Calibri,Arial,Helvetica,sans-serif;";
  const sections = reportSections(report)
    .map(({ title, bullets }) => {
      const items = bullets
        .map(({ label, text }) => {
          const prefix = label ? `<b>${escapeHtml(label)}:</b> ` : "";
          return `<li style="margin:0 0 4px 0;">${prefix}${escapeHtml(text)}</li>`;
        })
        .join("");
      return (
        `<h2 style="${font}font-size:13pt;color:#0b1526;margin:18px 0 6px 0;padding-bottom:3px;border-bottom:2px solid #f2a33c;">${escapeHtml(title)}</h2>` +
        `<ul style="${font}font-size:11pt;color:#1f2a3d;margin:0 0 0 22px;padding:0;">${items}</ul>`
      );
    })
    .join("");

  return (
    `<div style="${font}font-size:11pt;color:#1f2a3d;">` +
    `<p style="${font}font-size:9pt;color:#6b7a90;text-transform:uppercase;letter-spacing:1px;margin:0;">${escapeHtml(labels.kicker)}</p>` +
    `<h1 style="${font}font-size:22pt;color:#0b1526;margin:2px 0 0 0;">Info Flash</h1>` +
    `<p style="${font}font-size:12pt;color:#c47a17;font-weight:bold;margin:0 0 8px 0;">${escapeHtml(report.period)}</p>` +
    sections +
    `</div>`
  );
}

// Puts text/plain (and optionally text/html) on the clipboard.
async function copyToClipboard(text, html) {
  // Modern way: works in all current browsers on https / localhost
  if (navigator.clipboard && window.ClipboardItem) {
    const items = { "text/plain": new Blob([text], { type: "text/plain" }) };
    if (html) items["text/html"] = new Blob([html], { type: "text/html" });
    return navigator.clipboard.write([new ClipboardItem(items)]);
  }
  // Fallback for older browsers: fill the clipboard during a "copy" event
  const onCopy = (event) => {
    event.clipboardData.setData("text/plain", text);
    if (html) event.clipboardData.setData("text/html", html);
    event.preventDefault();
  };
  document.addEventListener("copy", onCopy, { once: true });
  const ok = document.execCommand("copy");
  document.removeEventListener("copy", onCopy);
  if (!ok) throw new Error("Copy failed");
}

// Shows "Copied ✓" on the button for 2 seconds.
async function handleCopy(button, getText, getHtml) {
  if (!currentReport) return;
  const original = button.textContent;
  try {
    await copyToClipboard(getText(currentReport), getHtml?.(currentReport));
    button.textContent = "Copied ✓";
  } catch {
    button.textContent = "Copy failed";
  }
  setTimeout(() => (button.textContent = original), 2000);
}

const copyTextBtn = document.getElementById("copyTextBtn");
const copyEmailBtn = document.getElementById("copyEmailBtn");

copyTextBtn.addEventListener("click", () => handleCopy(copyTextBtn, reportToText));
copyEmailBtn.addEventListener("click", () => handleCopy(copyEmailBtn, reportToText, reportToEmailHtml));

// "Download PDF" = the browser's print dialog (choose "Save as PDF").
// The print stylesheet in style.css hides everything except the report.
// The page title becomes the suggested PDF file name.
document.getElementById("pdfBtn").addEventListener("click", () => {
  if (!currentReport) return;
  const originalTitle = document.title;
  document.title = `Info Flash ${currentReport.period}`;
  window.addEventListener("afterprint", () => (document.title = originalTitle), { once: true });
  window.print();
});
