#!/usr/bin/env node
import { KeymasterError } from "@keymaster-app-pack/core";
import { runCli } from "./index.js";

try {
  await runCli(process.argv.slice(2));
} catch (error) {
  if (error instanceof KeymasterError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
  } else {
    process.stderr.write("KEYMASTER_CLI_ERROR: operation failed\n");
  }
  process.exitCode = 1;
}
