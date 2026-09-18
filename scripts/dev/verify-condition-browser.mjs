import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { progressivePreviewOrigin } from "./progressive-preview-origin.mjs";

const session = `airfoil-conditions-${process.pid}`;
let failure;
const invoke = (...arguments_) =>
  JSON.parse(
    execFileSync(
      "/home/holyglory/.local/bin/agent-browser",
      ["--session", session, "--json", ...arguments_],
      { encoding: "utf8", timeout: 45000, maxBuffer: 262144 },
    ),
  );
try {
  assert(invoke("open", progressivePreviewOrigin()).success);
  assert(
    invoke("wait", "[data-testid='browse-surface'][data-hydrated='true']")
      .success,
  );
  const result = invoke(
    "eval",
    "JSON.stringify({selector:!!document.querySelector('select[aria-label=\"Metrics for\"]'),rows:document.querySelectorAll('[data-testid^=\"airfoil-row-\"]').length,heading:document.querySelector('h1')?.textContent})",
  );
  assert(result.success);
  const state = JSON.parse(result.data.result);
  assert(
    state.selector && state.rows > 0 && state.heading === "Airfoil catalog",
  );
  assert(invoke("snapshot", "-i").success);
  assert(invoke("click", "summary[aria-label='Categories']").success);
  const menu = invoke(
    "eval",
    "!!document.querySelector('details[open] .browse-categories')",
  );
  assert(menu.success && menu.data.result === true);
  assert(invoke("press", "Escape").success);
  const closed = invoke(
    "eval",
    "!document.querySelector('details[open] .browse-categories')",
  );
  assert(closed.success && closed.data.result === true);
  const errors = invoke("errors");
  assert(errors.success);
  assert.deepEqual(errors.data.errors, []);
  console.log(
    JSON.stringify({
      kind: "agent-browser-condition-catalog",
      ...state,
      consoleErrors: 0,
    }),
  );
} catch (error) {
  failure = error;
  throw error;
} finally {
  try {
    invoke("close");
  } catch (error) {
    if (!failure) throw error;
    console.error("Browser cleanup also failed:", error.message);
  }
}
