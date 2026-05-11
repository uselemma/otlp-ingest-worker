export interface OtlpPayloadPointer {
  project_id: string;
  payload_key: string;
  requested_at: string;
  payload_format: string;
  attempt: number;
  version: number;
}

export const OTLP_PAYLOAD_POINTER_VERSION = 2;

export { sha256Hex } from "./crypto";
