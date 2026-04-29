import type { ObservabilityEvent, WorkerdSession, WorkerdSessionOptions } from "@agent-container/types";

import type { SessionCapabilityContext } from "../bridge/index.js";
import { LocalWorkerdSession, WorkerdRunError } from "./session.js";

type EmitEvent = (event: Omit<ObservabilityEvent, "timestamp">) => Promise<void>;

export { LocalWorkerdSession, WorkerdRunError };

export async function createWorkerdSession(
  options: WorkerdSessionOptions = {},
): Promise<WorkerdSession> {
  return LocalWorkerdSession.create(options, {});
}

export async function createManagedWorkerdSession(
  options: WorkerdSessionOptions = {},
  context: SessionCapabilityContext = {},
  emit?: EmitEvent,
): Promise<WorkerdSession> {
  return LocalWorkerdSession.create(options, context, emit);
}
