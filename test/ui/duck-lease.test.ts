import { describe, it, expect } from "vitest";
import { createDuckLease, duckBody } from "../../ui/src/lib/duck-lease.js";

function harness(available = true) {
  const sent: boolean[] = [];
  let cb: (() => void) | null = null;
  let cleared = 0;
  const avail = { v: available };
  const lease = createDuckLease({
    send: (on) => {
      sent.push(on);
    },
    isAvailable: () => avail.v,
    setTimer: (fn) => {
      cb = fn;
      return 1;
    },
    clearTimer: () => {
      cleared++;
      cb = null;
    },
  });
  return { lease, sent, tick: () => cb?.(), cleared: () => cleared, avail };
}

describe("createDuckLease", () => {
  it("start envía on:true una sola vez y renueva en cada tick", () => {
    const h = harness();
    h.lease.start();
    h.lease.start();
    expect(h.sent).toEqual([true]);
    h.tick();
    h.tick();
    expect(h.sent).toEqual([true, true, true]);
  });
  it("stop envía on:false, cancela el temporizador y es idempotente", () => {
    const h = harness();
    h.lease.start();
    h.lease.stop();
    h.lease.stop();
    expect(h.sent).toEqual([true, false]);
    expect(h.cleared()).toBe(1);
    expect(h.lease.active()).toBe(false);
  });
  it("stop sin start no llama al servidor", () => {
    const h = harness();
    h.lease.stop();
    expect(h.sent).toEqual([]);
  });
  it("no hace nada si el ducking no está disponible", () => {
    const h = harness(false);
    h.lease.start();
    expect(h.sent).toEqual([]);
    expect(h.lease.active()).toBe(false);
  });
  it("no renueva si dejó de estar disponible, pero sí libera", () => {
    const h = harness();
    h.lease.start();
    h.avail.v = false;
    h.tick();
    expect(h.sent).toEqual([true]);
    h.lease.stop();
    expect(h.sent).toEqual([true, false]);
  });
  it("un send que lanza o rechaza no rompe nada", async () => {
    const lease = createDuckLease({
      send: () => Promise.reject(new Error("x")),
      setTimer: () => 1,
      clearTimer: () => {},
    });
    lease.start();
    lease.stop();
    await Promise.resolve();
    const lease2 = createDuckLease({
      send: () => {
        throw new Error("y");
      },
      setTimer: () => 1,
      clearTimer: () => {},
    });
    expect(() => {
      lease2.start();
      lease2.stop();
    }).not.toThrow();
  });
  it("duckBody serializa reason y on", () => {
    expect(JSON.parse(duckBody("mic", true))).toEqual({ reason: "mic", on: true });
  });
});
