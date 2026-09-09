import assert from "node:assert/strict";
import test from "node:test";
import { readCommandOutput } from "../src/commands.ts";

test("command output waits for inherited stdout and stderr to close", async () => {
  // A launcher may exit while its worker still holds the output pipes.
  const worker = "setTimeout(() => process.stdout.write('worker output'), 100)";
  const launcher = `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], { stdio: 'inherit' });
    process.exit(0);
  `;
  assert.equal(await readCommandOutput(process.execPath, ["-e", launcher], process.env), "worker output");
});

test("command failures preserve stderr and process launch errors", async () => {
  await assert.rejects(
    readCommandOutput(process.execPath, ["-e", "process.stderr.write('diagnostic'); process.exitCode = 3"], process.env),
    /diagnostic/,
  );
  await assert.rejects(
    readCommandOutput("/vibecloud/nonexistent-command", [], process.env),
    { code: "ENOENT" },
  );
});
