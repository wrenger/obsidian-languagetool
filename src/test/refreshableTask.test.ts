import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { RefreshableTask } from "../refreshableTask";

const tasks: RefreshableTask[] = [];
const setTimeout = mock((_callback: () => void, _delay: number) => 1);
const clearTimeout = mock((_id: number) => {});
let originalWindow: PropertyDescriptor | undefined;

function task(run: (isCurrent: () => boolean) => Promise<void>, retryable = true) {
    const current = new RefreshableTask(run, { shouldRetry: () => retryable });
    tasks.push(current);
    return current;
}

beforeEach(() => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { setTimeout, clearTimeout },
    });
    setTimeout.mockClear();
    clearTimeout.mockClear();
});

afterEach(() => {
    for (const current of tasks) current.dispose();
    tasks.length = 0;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
});

test("shares pending work and reruns invalidated work without accepting stale results", async () => {
    let finish!: () => void;
    const work = new Promise<void>(resolve => { finish = resolve; });
    let isCurrent = () => false;
    const run = mock(async (check: () => boolean) => {
        isCurrent = check;
        await work;
    });
    const current = task(run);
    const pending = current.ensure();
    expect(current.ensure()).toBe(pending);
    await Promise.resolve();
    expect(isCurrent()).toBeTrue();
    current.invalidate();
    expect(isCurrent()).toBeFalse();
    finish();
    await pending;
    expect(run).toHaveBeenCalledTimes(2);
    await current.ensure();
    expect(run).toHaveBeenCalledTimes(2);
});

test.each(["timer", "online"])("retries transient failures through %s", async trigger => {
    const run = mock(async () => {}).mockRejectedValueOnce(new Error("offline"));
    const current = task(run);
    await current.ensure();
    expect(setTimeout).toHaveBeenCalledTimes(1);
    await current.ensure();
    expect(run).toHaveBeenCalledTimes(1);
    if (trigger === "timer") setTimeout.mock.calls[0][0]();
    else current.retry();
    await current.ensure();
    expect(run).toHaveBeenCalledTimes(2);
});

test("permanent failures wait for invalidation rather than reconnect", async () => {
    const run = mock(async () => { throw new Error("unauthorized"); });
    const current = task(run, false);
    await current.ensure();
    current.retry();
    await current.ensure();
    expect(run).toHaveBeenCalledTimes(1);
    expect(setTimeout).not.toHaveBeenCalled();
    current.invalidate();
    await current.ensure();
    expect(run).toHaveBeenCalledTimes(2);
});

test("disposal cancels retries and makes existing work obsolete", async () => {
    let isCurrent = () => false;
    const run = mock(async (check: () => boolean) => {
        isCurrent = check;
        throw new Error("offline");
    });
    const current = task(run);
    await current.ensure();
    current.dispose();
    expect(isCurrent()).toBeFalse();
    expect(clearTimeout).toHaveBeenCalledWith(1);
    current.retry();
    await current.ensure();
    expect(run).toHaveBeenCalledTimes(1);
});
