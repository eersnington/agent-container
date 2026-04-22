import type { ObservabilityEvent, WorkerdSession, WorkerdSessionOptions } from "@agent-container/types";

import type { SessionCapabilityContext } from "../bridge.js";
import { LocalWorkerdSession } from "./session.js";

type EmitEvent = (event: Omit<ObservabilityEvent, "timestamp">) => Promise<void>;

export { LocalWorkerdSession };

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
