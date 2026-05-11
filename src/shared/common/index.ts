export interface OtlpPayloadPointer {
  project_id: string;
  payload_key: string;
  requested_at: string;
  attempt: number;
  version: number;
}

export const OTLP_PAYLOAD_POINTER_VERSION = 1;

export { sha256Hex } from "./crypto";
