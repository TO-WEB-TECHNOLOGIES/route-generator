# Logistics fixtures (test data)

Shapes from `../ondc-logistics-api` (read-only there). Added 2026-11-09 for Part 2.

| File | What it is |
|---|---|
| `on_track.contract.json` | Verbatim copy of `../ondc-logistics-api/.claude/skills/ondc-api-contract/examples/on_track.json` (ONDC `/on_track`, Bengaluru coordinates: **outside our NCR coverage**) |
| `order_tracking.ncr.json` | Hand-made `order_tracking` SSE event (`src/utils/streams/order-sse.ts` there), real on-road Cyber Hub points ~104 m apart, string sequences, no per-point time |
| `order_status.ncr.json` | Hand-made `order_status` event; `fulfillmentState` is our stage |
| `order_endpoints.ncr.json` | Store/home GPS (`start_gps`/`end_gps` on init-order rows). No logistics endpoint returns this yet (Q3); shape is our proposal |
