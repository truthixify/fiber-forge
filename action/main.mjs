import { errorAnnotation } from "./github.mjs";
import { sanitizeText } from "./runtime.mjs";
import { runSetup } from "./setup.mjs";

try {
  await runSetup();
} catch (error) {
  errorAnnotation(
    sanitizeText(error instanceof Error ? error.message : String(error), [
      process.env.GITHUB_WORKSPACE,
      process.env.RUNNER_TEMP,
    ]),
  );
  process.exitCode = 1;
}
