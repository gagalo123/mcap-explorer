import type { ErrCode, ErrorDto } from "../shared/protocol";

export class McapExplorerError extends Error {
  constructor(
    readonly code: ErrCode,
    message: string,
  ) {
    super(message);
    this.name = "McapExplorerError";
  }
}

export function toErrorDto(err: unknown): ErrorDto {
  if (err instanceof McapExplorerError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    return { code: "IO_ERROR", message: err.message };
  }
  return { code: "IO_ERROR", message: String(err) };
}
