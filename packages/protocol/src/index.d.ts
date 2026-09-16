export type ValidationError = "invalid_structure" | "invalid_json" | "too_large" | "upgrade_required";
export type Validation = { ok: true } | { ok: false; error: ValidationError };
export type Kind = "eventSummary" | "eventDetail" | "decisionIntent";
export type Answers = Record<string, string | string[]>;
export interface DecisionIntent {
  protocolVersion: 1;
  decisionId: string;
  bindingId: string;
  bindingRevision: number;
  mobileId: string;
  pcId: string;
  pcSessionEpoch: string;
  eventId: string;
  approvalId: string;
  expectedRevision: number;
  approvalContextDigest: string;
  optionId: string;
  issuedAt: string;
  expiresAt: string;
  answers?: Answers;
}
export interface EventSummary {
  protocolVersion: 1;
  eventId: string;
  pcId: string;
  pcSessionEpoch: string;
  streamSeq: number;
  eventRevision: number;
  kind: "approval" | "question" | "input" | "plan" | "completion";
  agentId: string;
  createdAt: string;
  expiresAt: string;
  state: "pending" | "resolved" | "expired" | "disconnected";
  actionable: boolean;
  pendingCount: number;
  summaryKey: "remote.approvalRequested" | "remote.questionRequested" | "remote.inputRequested" | "remote.planReady" | "remote.completed";
}
export interface EventDetail {
  protocolVersion: 1;
  summary: EventSummary;
  approvalId: string;
  approvalContextDigest: string;
  toolName: string;
  toolInputText: string;
  description: string;
  options: { id: string; label: string; labelKey: string; tone: "primary" | "danger" | "secondary" }[];
  questions: { id: string; header: string; question: string; questionKey: string; multiSelect: boolean; allowText: boolean;
    options: { id: string; label: string; description: string }[] }[];
  truncated: boolean;
  redacted: boolean;
  remoteActionable: boolean;
  pcTime: string;
}
export const LIMITS: Readonly<{ controlBytes: number; detailBytes: number; envelopeBytes: number; depth: number; nodes: number }>;
export function validate(kind: Kind, value: unknown): Validation;
export function parse(kind: "decisionIntent", text: string): { ok: true; value: DecisionIntent } | { ok: false; error: ValidationError };
export function parse(kind: "eventSummary", text: string): { ok: true; value: EventSummary } | { ok: false; error: ValidationError };
export function parse(kind: "eventDetail", text: string): { ok: true; value: EventDetail } | { ok: false; error: ValidationError };
export function safeTree(value: unknown): boolean;
export function isRecord(value: unknown): value is Record<string, unknown>;
