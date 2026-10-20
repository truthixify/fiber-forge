/** Stable lifecycle failures used by machine-readable CLI output and internal orchestration. */
export type ForgeErrorCode =
  | "CONTAINER_NOT_FOUND"
  | "CONTAINER_START_FAILED"
  | "DOCKER_OPERATION_FAILED"
  | "DOCKER_UNAVAILABLE"
  | "IMAGE_PULL_FAILED"
  | "INVALID_NETWORK_NAME"
  | "INVALID_PORT"
  | "INVALID_TIMEOUT"
  | "NETWORK_EXISTS"
  | "NETWORK_NOT_FOUND"
  | "OPERATION_ABORTED"
  | "OPERATION_TIMEOUT"
  | "PORT_IN_USE"
  | "PROVISION_FAILED"
  | "ROLLBACK_FAILED"
  | "UNEXPECTED";

export interface ForgeErrorDetails {
  code: ForgeErrorCode;
  message: string;
  resource?: string;
  action?: string;
}

interface ForgeErrorOptions extends ErrorOptions {
  resource?: string;
  action?: string;
}

export class ForgeError extends Error {
  readonly code: ForgeErrorCode;
  readonly resource?: string;
  readonly action?: string;

  constructor(
    code: ForgeErrorCode,
    message: string,
    options: ForgeErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ForgeError";
    this.code = code;
    this.resource = options.resource;
    this.action = options.action;
  }

  toJSON(): ForgeErrorDetails {
    return {
      code: this.code,
      message: this.message,
      ...(this.resource ? { resource: this.resource } : {}),
      ...(this.action ? { action: this.action } : {}),
    };
  }
}

export function errorDetails(error: unknown): ForgeErrorDetails {
  if (error instanceof ForgeError) {
    return error.toJSON();
  }
  return {
    code: "UNEXPECTED",
    message: error instanceof Error ? error.message : String(error),
  };
}
