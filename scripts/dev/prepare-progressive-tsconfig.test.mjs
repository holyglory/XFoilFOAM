import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareProgressiveTsconfig } from "./prepare-progressive-tsconfig.mjs";

test("preview compiler writes cannot change canonical or prior-generation configuration", () => {
  const directory = mkdtempSync(join(tmpdir(), "preview-tsconfig-"));
  const source =
    '{"extends":"../../tsconfig.base.json","include":["**/*.tsx"]}\n';
  try {
    writeFileSync(join(directory, "tsconfig.json"), source);
    const first = prepareProgressiveTsconfig(directory, 12);
    writeFileSync(
      join(directory, first),
      '{"include":[".next-progressive-preview-12/types/**/*.ts"]}\n',
    );
    const second = prepareProgressiveTsconfig(directory, 13);
    assert.notEqual(first, second);
    assert.equal(readFileSync(join(directory, second), "utf8"), source);
    assert.equal(
      readFileSync(join(directory, "tsconfig.json"), "utf8"),
      source,
    );
    assert.match(readFileSync(join(directory, first), "utf8"), /preview-12/);
    for (const invalid of [0, -1, 1.5, "../tsconfig", "", undefined])
      assert.throws(() => prepareProgressiveTsconfig(directory, invalid));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
