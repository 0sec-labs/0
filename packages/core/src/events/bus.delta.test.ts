/** Event-bus fan-out preserves delta payloads for local subscribers. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eventBus, type DeltaPayload, type EventType } from "./bus.js";

describe("eventBus.emit('delta', …)", () => {
  beforeEach(() => {
    eventBus.clear();
  });

  afterEach(() => {
    eventBus.clear();
  });

  it("fans a delta event out to every subscribed sink with the payload intact", () => {
    const sink1: Array<{ type: EventType; payload: Record<string, unknown> }> = [];
    const sink2: Array<{ type: EventType; payload: Record<string, unknown> }> = [];
    eventBus.subscribe({
      emit: (type, payload) => {
        sink1.push({ type, payload });
      },
    });
    eventBus.subscribe({
      emit: (type, payload) => {
        sink2.push({ type, payload });
      },
    });

    const payload: DeltaPayload = {
      turn: 3,
      role: "attack",
      scope: "assistant_response",
      text: "hello world",
      seq: 0,
    };
    eventBus.emit("delta", payload);

    expect(sink1).toHaveLength(1);
    expect(sink2).toHaveLength(1);
    expect(sink1[0]!.type).toBe("delta");
    expect(sink1[0]!.payload).toEqual(payload);
    expect(sink2[0]!.payload).toEqual(payload);
  });

});
