import assert from "node:assert/strict";
import { progressivePreviewOrigin } from "./progressive-preview-origin.mjs";

const origin = progressivePreviewOrigin();
const response = await fetch(new URL("/airfoils/ag24", origin), {
  signal: AbortSignal.timeout(15000),
});
assert.equal(
  response.status,
  200,
  "The real Detail route must be ready before browser checks",
);
assert(
  (await response.text()).includes('data-testid="progressive-polar-viewer"'),
  "The route must contain the actual polar viewer",
);
console.log(
  JSON.stringify({
    kind: "progressive-preview-ready",
    origin,
    route: "/airfoils/ag24",
    http: response.status,
  }),
);
