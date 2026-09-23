import { statSync } from "node:fs";

/** Retain operation ownership without recording arguments or environment values. */
export class ExecutionOperationError extends Error {
  constructor(
    readonly operation: string,
    readonly cwd: string,
    cause: unknown,
    readonly capabilityScope?: string,
  ) {
    super(
      `${operation} in ${cwd}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

export class MissingWorkingDirectoryError extends ExecutionOperationError {}

export function spawnFailure(
  command: string,
  cwd: string,
  error: Error,
): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    try {
      if (!statSync(cwd).isDirectory()) {
        return new MissingWorkingDirectoryError(
          `spawn ${command}: working directory is not a directory`,
          cwd,
          error,
        );
      }
    } catch (inspection) {
      const inspectionCode = (inspection as NodeJS.ErrnoException).code;
      if (inspectionCode === "ENOENT" || inspectionCode === "ENOTDIR") {
        return new MissingWorkingDirectoryError(
          `spawn ${command}: working directory is missing`,
          cwd,
          error,
        );
      }
      // A denied directory inspection is not evidence of a missing checkout.
      return new ExecutionOperationError(
        `inspect working directory for spawn ${command}`,
        cwd,
        new AggregateError([error, inspection]),
      );
    }
    return new ExecutionOperationError(
      `spawn ${command}: executable or interpreter unavailable`,
      cwd,
      error,
    );
  }
  return new ExecutionOperationError(`spawn ${command}`, cwd, error);
}
