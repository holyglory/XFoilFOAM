import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import ts from "typescript";

const usage =
  "node scripts/deploy/verify-hz-attempt-history.mjs --attempt UUID --hub-account-file FILE [--hz-host ALIAS --hub-host ALIAS --hz-api CONTAINER --hub-sweeper CONTAINER]";
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const target = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const options = {
  help: { type: "boolean" },
  attempt: { type: "string" },
  "hub-account-file": { type: "string" },
  "hz-host": { type: "string", default: "hz-solver2" },
  "hub-host": { type: "string", default: "airfoils.pro" },
  "hz-api": { type: "string", default: "hz-solver2-node-api-1" },
  "hub-sweeper": { type: "string", default: "app-sweeper-1" },
};

// Load the pinned checkout's read-only projection for a pre-deployment probe.
// Only the import locations change when executed via stdin inside the image.
function readerForContainer() {
  const file = new URL(
    "../../apps/sweeper/src/hz-attempt-report-reader.ts",
    import.meta.url,
  );
  const source = readFileSync(file, "utf8");
  return ts
    .transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
      },
    })
    .outputText.replaceAll(
      /from "@aerodb\/db\/([a-z-]+)"/g,
      'from "/app/packages/db/src/$1.ts"',
    )
    .replace(
      'from "./worker-report-volume"',
      'from "/app/apps/sweeper/src/worker-report-volume.ts"',
    )
    .replace(
      'from "drizzle-orm"',
      'from "/app/packages/db/node_modules/drizzle-orm/index.js"',
    );
}

function remote(host, container, helper, input) {
  const code = ["member", helper]
    .map((name) =>
      readFileSync(
        new URL("./hz-attempt-history/" + name + ".mjs", import.meta.url),
        "utf8",
      ),
    )
    .join("\n");
  const request = Buffer.from(JSON.stringify(input)).toString("base64");
  const output = execFileSync(
    "ssh",
    [
      "-T",
      "-C",
      "-oBatchMode=yes",
      "-oStrictHostKeyChecking=yes",
      "-oForwardAgent=no",
      "-oClearAllForwardings=yes",
      "-oConnectTimeout=10",
      host,
      "docker exec -i " +
        container +
        " node --import tsx --input-type=module -",
    ],
    {
      input:
        "const request = JSON.parse(Buffer.from('" +
        request +
        "','base64'));\n" +
        readerForContainer() +
        "\n" +
        code,
      timeout: 90000,
      maxBuffer: 256 * 1024,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  return JSON.parse(output);
}

let operation = "arguments";
try {
  const { values } = parseArgs({ options });
  if (values.help) {
    console.log(usage);
  } else {
    if (
      !uuid.test(values.attempt ?? "") ||
      !values["hub-account-file"] ||
      !["hz-host", "hub-host", "hz-api", "hub-sweeper"].every((k) =>
        target.test(values[k]),
      )
    )
      throw Error();
    operation = "read_account_pin";
    const account = readFileSync(values["hub-account-file"], "utf8").trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(account)) throw Error();
    const pin = createHash("sha256").update(account).digest("hex");
    operation = "hz_product_read";
    const witness = remote(
      values["hz-host"],
      values["hz-api"],
      "worker-source",
      { attempt: values.attempt },
    );
    if (
      witness.attempt !== values.attempt.toLowerCase() ||
      !witness.exactReplay
    )
      throw Error();
    operation = "hub_generation_read";
    const result = remote(
      values["hub-host"],
      values["hub-sweeper"],
      "hub-source",
      { witness, pin },
    );
    if (
      !result.exactHubPayload ||
      !result.exactReportPayload ||
      result.attempt !== witness.attempt
    )
      throw Error();
    console.log(JSON.stringify({ ...result, sourceDatabaseWrites: false }));
  }
} catch (error) {
  const detail = error?.stderr?.toString().trim();
  // Remote helpers expose only a closed vocabulary. SSH/SQL/HTTP error bodies stay private.
  const category = /^(scope|source|archive|identity|generation|replay)$/.test(
    detail,
  )
    ? detail
    : "unavailable";
  console.error(JSON.stringify({ operation, category }));
  process.exitCode = 1;
}
