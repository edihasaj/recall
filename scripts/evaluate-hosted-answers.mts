/** CLI entry point for hosted answer evaluation. */
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import {
  evaluateHostedAnswers,
  parseHostedArgs,
} from "./hosted-answer-runtime.mts";

export {
  evaluateHostedAnswers,
  parseHostedArgs,
} from "./hosted-answer-runtime.mts";
export type {
  CloudContext,
  HostedCallFactory,
  HostedOptions,
  HostedRow,
} from "./hosted-answer-runtime.mts";
export { modelCallOptions } from "./hosted-answer-runtime.mts";

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  evaluateHostedAnswers(parseHostedArgs(process.argv.slice(2)))
    .then((report) => {
      if (!report.invocation.dry_run && report.status !== "complete")
        process.exitCode = 1;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
