// Retain only public route paths and bounded state, without request headers or bodies.
export function observePolarBrowser(page, origin) {
  const requests = new Map();
  const failures = [];
  const started = Date.now();
  const shortPath = (value) => {
    const url = new URL(value);
    return url.origin === origin ? url.pathname : url.hostname;
  };

  page.on("request", (request) => {
    if (!["document", "script", "font", "fetch", "xhr"].includes(request.resourceType())) return;
    requests.set(request, {
      path: shortPath(request.url()),
      kind: request.resourceType(),
      startedMs: Date.now() - started,
    });
  });
  page.on("response", (response) => {
    const entry = requests.get(response.request());
    if (entry) entry.status = response.status();
  });
  page.on("requestfinished", (request) => {
    const entry = requests.get(request);
    if (entry) entry.finishedMs = Date.now() - started;
  });
  page.on("requestfailed", (request) => {
    failures.push({ path: shortPath(request.url()), error: request.failure()?.errorText });
  });
  page.on("pageerror", (error) => failures.push({ error: error.message.slice(0, 240) }));

  return async () => {
    const state = await page.evaluate(() => {
      const viewer = document.querySelector('[data-testid="progressive-polar-viewer"]');
      const points = [...document.querySelectorAll("details")].find(
        (item) => item.querySelector("summary")?.textContent.trim() === "CFD points",
      );
      return {
        route: location.pathname,
        readyState: document.readyState,
        fonts: document.fonts.status,
        width: window.innerWidth,
        hasViewer: !!viewer,
        busy: viewer?.getAttribute("aria-busy"),
        conditions: viewer?.querySelector("select")?.options.length,
        pointsOpen: points?.open,
        pointsInert: points?.inert,
        pointsState: points?.querySelector('[role="status"], [role="alert"], p')?.textContent?.trim().slice(0, 120),
        hasPointChart: !!points?.querySelector('[data-testid="polar-viewer"]'),
      };
    }).catch(() => ({ pageClosed: page.isClosed() }));
    const recent = [...requests.values()].slice(-35);
    console.error(JSON.stringify({ test: "public-polar-browser", elapsedMs: Date.now() - started, state, requests: recent, failures: failures.slice(-15) }));
  };
}
