import type { InteractionMode } from "../model/types.ts";

const ACTION_OR_WORKSPACE_PATTERN =
  /^(?:please\s+)?(?:add|apply|build|change|check|commit|configure|create|debug|delete|edit|execute|find|fix|implement|inspect|install|list|modify|open|patch|pull|push|read|refactor|remove|rename|replace|review|run|search|set\s+up|setup|test|update|write)\b|\b(?:can|could|would)\s+you\s+(?:please\s+)?(?:add|apply|build|change|check|commit|configure|create|debug|delete|edit|execute|find|fix|implement|inspect|install|list|modify|open|patch|pull|push|read|refactor|remove|rename|replace|review|run|search|set\s+up|setup|test|update|write)\b|\bhow\s+(?:do|can)\s+i\b|\bwhat\s+should\s+i\b/i;
const WORKSPACE_REFERENCE_PATTERN =
  /(?:\.{0,2}\/|\b(?:package\.json|tsconfig(?:\.json)?)\b|\b(?:failing|current|these|the)\s+tests?\b|\b(?:my|this|the|current|local)\s+(?:code|file|files|project|repo(?:sitory)?|workspace|directory|folder)\b|\b(?:in|from|inside|under|within)\s+(?:the\s+)?(?:codebase|file|directory|folder|project|repo(?:sitory)?|workspace)\b)/i;
const INFORMATIONAL_PATTERN =
  /^(?:what|why|when|where|who|which|how\s+(?:does|is|are|can|would|do)|(?:can|could|would)\s+you\s+(?:explain|describe|tell)|(?:please\s+)?(?:explain|describe|define|compare|tell\s+me\s+about|summari[sz]e))\b/i;

/**
 * Selects whether a task should be answered directly or handled as a coding
 * task. This is intentionally conservative: workspace references and action
 * verbs keep the existing tool-enabled agent behavior.
 */
export function selectInteractionMode(task: string): InteractionMode {
  const normalized = task.trim();

  if (
    normalized.length === 0 ||
    ACTION_OR_WORKSPACE_PATTERN.test(normalized) ||
    WORKSPACE_REFERENCE_PATTERN.test(normalized)
  ) {
    return "agent";
  }

  return INFORMATIONAL_PATTERN.test(normalized) ? "direct" : "agent";
}
