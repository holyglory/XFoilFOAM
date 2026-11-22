// One bounded invocation of the canonical backfill CLI, usable through stdin in
// an existing HZ sweeper. All database access and SQL stay in packages/db.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsx/package.json"))("esbuild");
const compiled = await build({
  absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
  entryPoints: ["packages/db/src/backfill-progressive-report-payloads.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  write: false,
  plugins: [
    {
      name: "installed-report-runtime",
      setup(builder) {
        // stdin runs with /app/packages/db/src as the container working directory.
        builder.onResolve(
          {
            filter:
              /^\.\/(client|progressive-report-reader|progressive-report-payloads|progressive-remote-report)$/,
          },
          (args) => ({ path: args.path + ".ts", external: true }),
        );
      },
    },
  ],
  banner: {
    js: 'if (!process.argv.slice(2).includes("--native-prefix")) throw new Error("Expected --native-prefix");',
  },
});
process.stdout.write(compiled.outputFiles[0].contents);
