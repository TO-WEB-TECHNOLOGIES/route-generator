/**
 * Order stage -> routing destination (skill bff-road-routing, "Route ahead").
 * Stage strings are ONDC fulfillment state codes as the BFF receives them.
 */
export type Destination = "store" | "drop";

const TO_STORE = new Set(["Agent-assigned", "At-pickup"]);
const TO_DROP = new Set(["Order-picked-up", "Out-for-delivery"]);
/** Routing is finished for good: the route cache for the order can be dropped. */
const TERMINAL = new Set(["Order-delivered", "Delivered", "Cancelled"]);

/** null = no route ahead for this stage (At-delivery, terminal, unknown, or pre-assignment). */
export function destinationFor(stage: string): Destination | null {
  if (TO_STORE.has(stage)) return "store";
  if (TO_DROP.has(stage)) return "drop";
  return null;
}

export function isTerminalStage(stage: string): boolean {
  return TERMINAL.has(stage);
}
