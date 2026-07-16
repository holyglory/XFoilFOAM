import { EngineClient } from "@aerodb/engine-client";

import { env } from "./env";

/** One construction boundary keeps API health, cancellation and render calls
 * pinned to the same logical implementation as solver submission. */
export function makeEngineClient(): EngineClient {
  return new EngineClient(env.engineUrl, {
    expectedEngine: env.engineIdentity,
  });
}
