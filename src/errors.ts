/** Stable failures used by machine-readable CLI output and scenario expectations. */
export const FORGE_ERROR_CODES = [
  "BUNDLE_INCOMPATIBLE",
  "BUNDLE_INVALID",
  "BUNDLE_OUTPUT_EXISTS",
  "CHANNEL_NOT_FOUND",
  "CHANNEL_STATE_MISMATCH",
  "CONTAINER_NOT_FOUND",
  "CONTAINER_START_FAILED",
  "DOCKER_OPERATION_FAILED",
  "DOCKER_UNAVAILABLE",
  "FAULT_CONFLICT",
  "FAULT_PRECONDITION_FAILED",
  "FAULT_STATE_MISMATCH",
  "FAULT_UNSUPPORTED",
  "FORCE_CLOSE_CONFIRMATION_REQUIRED",
  "IMAGE_PULL_FAILED",
  "INVALID_NETWORK_NAME",
  "INVALID_PORT",
  "INVALID_TIMEOUT",
  "NETWORK_EXISTS",
  "NETWORK_NOT_FOUND",
  "MINING_PAUSED",
  "NODE_CONTAINER_MISSING",
  "NODE_IDENTITY_MISMATCH",
  "NODE_NOT_FOUND",
  "NODE_RPC_UNAVAILABLE",
  "NODE_STATE_MISMATCH",
  "OPERATION_ABORTED",
  "OPERATION_TIMEOUT",
  "PAYMENT_FAILED",
  "PORT_IN_USE",
  "PROVISION_FAILED",
  "ROLLBACK_FAILED",
  "UNEXPECTED",
] as const;

export type ForgeErrorCode = (typeof FORGE_ERROR_CODES)[number];

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
