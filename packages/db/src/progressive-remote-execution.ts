import {
  validateProgressiveExecutionScope,
  type ProgressiveExecutionScope,
} from "../../engine-client/src/progressive-execution";
import type { PolarRequest } from "../../engine-client/src/types";
import { analysisContentHash, canonicalAnalysisJson } from "./analysis-target";

export interface ProgressiveRemoteExecutionEnvelope {
  version: 1;
  solverId: string;
  promiseId: string;
  scope: ProgressiveExecutionScope;
  request: PolarRequest;
  contentSignature: string;
}

function requireUuid(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    throw new Error(
      "Remote execution requires an exact solver and promise identity",
    );
}

export function sealProgressiveRemoteExecution(input: {
  solverId: string;
  promiseId: string;
  scope: unknown;
  request: PolarRequest;
}): ProgressiveRemoteExecutionEnvelope {
  requireUuid(input.solverId);
  requireUuid(input.promiseId);
  const scope = validateProgressiveExecutionScope(input.request, input.scope);
  const request = JSON.parse(
    canonicalAnalysisJson(input.request),
  ) as PolarRequest;
  const payload = {
    version: 1 as const,
    solverId: input.solverId,
    promiseId: input.promiseId,
    scope,
    request,
  };
  return { ...payload, contentSignature: analysisContentHash(payload) };
}

export function verifyProgressiveRemoteExecution(
  envelope: unknown,
  expected: {
    solverId: string;
    promiseId: string;
    executionId: string;
    contentSignature: string;
  },
): ProgressiveRemoteExecutionEnvelope {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
    throw new Error("Remote execution envelope is missing");
  const value = envelope as Record<string, unknown>;
  const keys = [
    "version",
    "solverId",
    "promiseId",
    "scope",
    "request",
    "contentSignature",
  ];
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    value.version !== 1
  )
    throw new Error("Remote execution envelope version or shape differs");
  if (
    value.solverId !== expected.solverId ||
    value.promiseId !== expected.promiseId ||
    typeof expected.contentSignature !== "string" ||
    !/^[0-9a-f]{64}$/.test(expected.contentSignature) ||
    value.contentSignature !== expected.contentSignature
  )
    throw new Error("Remote execution does not match its stored assignment");
  if (
    !value.request ||
    typeof value.request !== "object" ||
    Array.isArray(value.request)
  )
    throw new Error("Remote execution request is missing");
  const sealed = sealProgressiveRemoteExecution({
    solverId: value.solverId as string,
    promiseId: value.promiseId as string,
    scope: value.scope,
    request: value.request as unknown as PolarRequest,
  });
  if (
    sealed.scope.executionId !== expected.executionId ||
    sealed.contentSignature !== expected.contentSignature
  )
    throw new Error(
      "Remote execution content differs from its immutable assignment",
    );
  return sealed;
}
