/**
 * Order stage -> routing destination (skill bff-road-routing, "Route ahead").
 * Stage strings are ONDC fulfillment state codes (`fulfillmentState` from ondc-logistics-api, see
 * ../ondc-logistics-api/docs/integration/post-order.md). Hyperlocal and intercity codes both appear.
 * Logistics states mapped 2026-11-09 per task/osrm-via-logistics-api-plan.md Phase 1.3.
 */
export type Destination = "store" | "drop";

const TO_STORE = new Set([
  "Agent-assigned",
  "At-pickup",
  "Out-for-pickup",
  // Return to origin: the rider takes the order back to the store.
  "RTO-Initiated",
]);
const TO_DROP = new Set([
  "Order-picked-up",
  "Out-for-delivery",
  "In-transit",
  "At-destination-hub",
  "Delivery-rescheduled",
]);
/** Routing is finished for good: the route cache for the order can be dropped. */
const TERMINAL = new Set(["Order-delivered", "Delivered", "Cancelled", "RTO-Delivered", "RTO-Disposed"]);

/**
 * null = no route ahead for this stage. That covers pre-assignment (Pending, Searching-for-Agent),
 * pickup problems (Pickup-failed, Pickup-rescheduled), At-delivery, Delivery-failed, terminal
 * stages, and anything unknown.
 */
export function destinationFor(stage: string): Destination | null {
  if (TO_STORE.has(stage)) return "store";
  if (TO_DROP.has(stage)) return "drop";
  return null;
}

export function isTerminalStage(stage: string): boolean {
  return TERMINAL.has(stage);
}
