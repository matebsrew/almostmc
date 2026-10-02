import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function source(path) {
  return readFile(resolve(root, path), "utf8");
}

test("flow builder exposes comment automation blocks", async () => {
  const [palette, actions] = await Promise.all([
    source("components/flow-builder/node-palette.tsx"),
    source("components/flow-builder/panels/ActionPanel.tsx"),
  ]);

  assert.equal(/nodeType:\s*"privateReply"/.test(palette), true);
  assert.equal(/nodeType:\s*"commentReply"/.test(palette), true);
  assert.equal(/case\s+"privateReply"/.test(actions), true);
  assert.equal(/case\s+"commentReply"/.test(actions), true);
});

test("flow builder has quick-add autosave and publish validation", async () => {
  const [canvas, validation, sidebar] = await Promise.all([
    source("components/flow-builder/flow-canvas.tsx"),
    source("components/flow-builder/flow-validation.ts"),
    source("components/flow-builder/panels/NodeConfigSidebar.tsx"),
  ]);

  assert.equal(/setTimeout\(\(\)\s*=>\s*\{\s*void saveFlow\(\);\s*\},\s*1200\)/s.test(canvas), true);
  assert.equal(/validateFlow\(nodes, edges\)/.test(canvas), true);
  assert.equal(/onAddNext/.test(sidebar), true);
  assert.equal(/onDuplicate/.test(sidebar), true);
  assert.equal(/privateReply/.test(validation), true);
  assert.equal(/not connected to the flow/.test(validation), true);
});

test("flow palette supports search and click-to-add", async () => {
  const palette = await source("components/flow-builder/node-palette.tsx");

  assert.equal(/Search steps/.test(palette), true);
  assert.equal(/onClick=\{\(\) => onAdd\?\.\(item\)\}/.test(palette), true);
  assert.equal(/Click to add or drag/.test(palette), true);
});


test("live flow execution reads published snapshots instead of autosaved draft nodes", async () => {
  const engine = await source("lib/flow-engine/engine.ts");

  assert.equal(/loadPublishedFlowGraph/.test(engine), true);
  assert.equal(/from\("flow_versions"\)/.test(engine), true);
  assert.equal(/eq\("version", flow\.version\)/.test(engine), true);
  assert.equal(/Draft edits saved by the builder/.test(engine), true);
});
