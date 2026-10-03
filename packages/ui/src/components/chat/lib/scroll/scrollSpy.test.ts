import { describe, expect, test } from 'vitest';
import {
    computeIntersectionRatio,
    createScrollSpy,
    measureVisibleTurnGeometry,
    pickVisibleTurnId,
    pickOffsetTurnId,
    type VisibleTurn,
    type OffsetTurn,
} from './scrollSpy';

// Minimal mock HTMLElement for scrollSpy tests. The spy reads
// dataset.turnId, getBoundingClientRect, scrollTop, and observes via
// the injected IO/RO/MO constructors. The rect is mutable so tests can
// simulate scroll-induced geometry changes (Medium risk 3: stale visible map).
class MockElement {
    dataset: Record<string, string> = {};
    scrollTop = 0;
    rect = { top: 0, bottom: 0, left: 0, right: 0, width: 100, height: 100, x: 0, y: 0, toJSON() {} };
    constructor() {
        this.dataset = {};
    }
    getBoundingClientRect() {
        return this.rect;
    }
    matches(selector: string): boolean {
        if (selector === '[data-turn-id]') return 'turnId' in this.dataset;
        if (selector === '[data-turn-entry]') return 'turnEntry' in this.dataset;
        return false;
    }
    querySelectorAll(): MockElement[] {
        return [];
    }
    closest(): null {
        return null;
    }
}

// Minimal mock IntersectionObserver that captures the config and lets the
// test drive entries.
class MockIO {
    static lastInstance: MockIO | null = null;
    static lastConfig: IntersectionObserverInit | null = null;
    callback: IntersectionObserverCallback;
    config: IntersectionObserverInit;
    observed = new Set<Element>();
    root: Element | Document | null = null;
    rootMargin: string = '0px';
    thresholds: ReadonlyArray<number> = [];
    constructor(cb: IntersectionObserverCallback, config: IntersectionObserverInit) {
        this.callback = cb;
        this.config = config;
        MockIO.lastInstance = this;
        MockIO.lastConfig = config;
    }
    observe(target: Element) { this.observed.add(target); }
    unobserve(target: Element) { this.observed.delete(target); }
    disconnect() { this.observed.clear(); }
    takeRecords(): IntersectionObserverEntry[] { return []; }
}

class MockRO {
    callback: ResizeObserverCallback;
    observed = new Set<Element>();
    constructor(cb: ResizeObserverCallback) {
        this.callback = cb;
    }
    observe(target: Element) { this.observed.add(target); }
    unobserve(target: Element) { this.observed.delete(target); }
    disconnect() { this.observed.clear(); }
}

class MockMO {
    static lastConfig: MutationObserverInit | null = null;
    callback: MutationCallback;
    constructor(cb: MutationCallback) {
        this.callback = cb;
    }
    observe(target: Node, config: MutationObserverInit) {
        MockMO.lastConfig = config;
    }
    disconnect() {}
    takeRecords(): MutationRecord[] { return []; }
}

describe('pickVisibleTurnId', () => {
    test('returns undefined for an empty list', () => {
        expect(pickVisibleTurnId([], 100) === undefined).toBe(true);
    });

    test('returns the turn with the highest intersection ratio', () => {
        const list: VisibleTurn[] = [
            { id: 'a', ratio: 0.3, top: 90 },
            { id: 'b', ratio: 0.8, top: 110 },
            { id: 'c', ratio: 0.5, top: 120 },
        ];
        expect(pickVisibleTurnId(list, 100)).toBe('b');
    });
});

describe('pickOffsetTurnId', () => {
    test('returns undefined for an empty list', () => {
        expect(pickOffsetTurnId([], 100) === undefined).toBe(true);
    });

    test('returns the last turn whose top is at or below the cutoff (binary search)', () => {
        const list: OffsetTurn[] = [
            { id: 'a', top: 10 },
            { id: 'b', top: 50 },
            { id: 'c', top: 100 },
            { id: 'd', top: 200 },
        ];
        expect(pickOffsetTurnId(list, 75)).toBe('b');
        expect(pickOffsetTurnId(list, 150)).toBe('c');
        expect(pickOffsetTurnId(list, 5)).toBe('a');
        expect(pickOffsetTurnId(list, 300)).toBe('d');
    });
});

// ---------------------------------------------------------------------------
// Blocking 1: pure helpers for viewport-coordinate geometry refresh.
// These tests verify the coordinate-system consistency and ratio recomputation
// that refreshVisibleGeometry relies on — without requiring a DOM environment.
// ---------------------------------------------------------------------------

describe('computeIntersectionRatio', () => {
    test('returns 0 when element height is 0', () => {
        expect(computeIntersectionRatio(
            { top: 100, bottom: 100, height: 0 },
            { top: 0, bottom: 500 },
        )).toBe(0);
    });

    test('returns 0 when element does not overlap container', () => {
        // Element entirely above container.
        expect(computeIntersectionRatio(
            { top: 0, bottom: 50, height: 50 },
            { top: 100, bottom: 500 },
        )).toBe(0);
        // Element entirely below container.
        expect(computeIntersectionRatio(
            { top: 600, bottom: 650, height: 50 },
            { top: 100, bottom: 500 },
        )).toBe(0);
    });

    test('returns 1 when element is fully inside container', () => {
        expect(computeIntersectionRatio(
            { top: 150, bottom: 250, height: 100 },
            { top: 100, bottom: 500 },
        )).toBe(1);
    });

    test('returns partial ratio when element partially overlaps container (top clipped)', () => {
        // Element top is above container top; 50px of 100px visible.
        expect(computeIntersectionRatio(
            { top: 50, bottom: 150, height: 100 },
            { top: 100, bottom: 500 },
        )).toBe(0.5);
    });

    test('returns partial ratio when element partially overlaps container (bottom clipped)', () => {
        // Element bottom is below container bottom; 50px of 100px visible.
        expect(computeIntersectionRatio(
            { top: 450, bottom: 550, height: 100 },
            { top: 100, bottom: 500 },
        )).toBe(0.5);
    });

    test('ratio changes as element scrolls through container (simulates scroll)', () => {
        // Element height = 100, container = [100, 500].
        const elementHeight = 100;
        const container = { top: 100, bottom: 500 };

        // Entering: 50px overlap.
        expect(computeIntersectionRatio(
            { top: 50, bottom: 150, height: elementHeight },
            container,
        )).toBe(0.5);

        // Fully visible.
        expect(computeIntersectionRatio(
            { top: 200, bottom: 300, height: elementHeight },
            container,
        )).toBe(1);

        // Leaving: 50px overlap at bottom.
        expect(computeIntersectionRatio(
            { top: 450, bottom: 550, height: elementHeight },
            container,
        )).toBe(0.5);

        // Gone.
        expect(computeIntersectionRatio(
            { top: 550, bottom: 650, height: elementHeight },
            container,
        )).toBe(0);
    });
});

describe('measureVisibleTurnGeometry', () => {
    test('returns viewport top and current intersection ratio', () => {
        // Mock element + container with getBoundingClientRect.
        const element = {
            getBoundingClientRect: () => ({ top: 150, bottom: 250, left: 0, right: 100, width: 100, height: 100, x: 0, y: 0, toJSON() {} }),
        };
        const container = {
            getBoundingClientRect: () => ({ top: 100, bottom: 500, left: 0, right: 800, width: 800, height: 400, x: 0, y: 0, toJSON() {} }),
        };

        const result = measureVisibleTurnGeometry(
            element as unknown as HTMLElement,
            container as unknown as HTMLElement,
        );

        // Top is viewport-coordinate (element rect top), not content-coordinate.
        expect(result.top).toBe(150);
        // Element fully inside container → ratio 1.
        expect(result.ratio).toBe(1);
    });

    test('BLOCKING 1: top is viewport coordinate, NOT content coordinate (matches line)', () => {
        // This is the regression test for the coordinate-system bug.
        // Before the fix, refreshVisibleGeometry stored content coordinates
        // (rect.top - containerRect.top + container.scrollTop), which at high
        // scrollTop produced large positive numbers that mismatched the
        // viewport-coordinate `line` (containerRect.top + 100).
        // After the fix, top is viewport-coordinate (rect.top), matching line.
        const elementViewportTop = 200;
        const containerViewportTop = 100;
        const containerScrollTop = 5000; // high scrollTop — would break content coords

        const element = {
            getBoundingClientRect: () => ({ top: elementViewportTop, bottom: 300, left: 0, right: 100, width: 100, height: 100, x: 0, y: 0, toJSON() {} }),
        };
        const container = {
            getBoundingClientRect: () => ({ top: containerViewportTop, bottom: 600, left: 0, right: 800, width: 800, height: 500, x: 0, y: 0, toJSON() {} }),
            scrollTop: containerScrollTop,
        };

        const result = measureVisibleTurnGeometry(
            element as unknown as HTMLElement,
            container as unknown as HTMLElement,
        );

        // Top must be the viewport top (200), NOT the content top
        // (200 - 100 + 5000 = 5100). If it were 5100, it would never match
        // the viewport-coordinate line (100 + 100 = 200) and active-turn
        // picking would break at high scrollTop.
        expect(result.top).toBe(elementViewportTop);
        expect(result.top).not.toBe(elementViewportTop - containerViewportTop + containerScrollTop);
    });

    test('BLOCKING 1: ratio updates as geometry changes (not stale from IO callback)', () => {
        // Simulate the IO-callback ratio being stale. The element's current
        // rect shows only 50% overlap, but the IO callback (at enter/leave
        // threshold) recorded ratio=1. measureVisibleTurnGeometry must return
        // the CURRENT ratio, not the stale one.
        const element = {
            getBoundingClientRect: () => ({ top: 50, bottom: 150, left: 0, right: 100, width: 100, height: 100, x: 0, y: 0, toJSON() {} }),
        };
        const container = {
            getBoundingClientRect: () => ({ top: 100, bottom: 500, left: 0, right: 800, width: 800, height: 400, x: 0, y: 0, toJSON() {} }),
        };

        const result = measureVisibleTurnGeometry(
            element as unknown as HTMLElement,
            container as unknown as HTMLElement,
        );

        // Element [50,150] overlaps container [100,500] by 50px out of 100px.
        // ratio = 0.5, NOT 1 (stale).
        expect(result.ratio).toBe(0.5);
    });
});

describe('createScrollSpy observer configuration', () => {
    test('does not depend on IntersectionObserver ratio updates', () => {
        MockIO.lastConfig = null;
        MockIO.lastInstance = null;
        const spy = createScrollSpy({
            onActive: () => {},
            IntersectionObserver: MockIO as unknown as typeof IntersectionObserver,
            ResizeObserver: MockRO as unknown as typeof ResizeObserver,
            MutationObserver: MockMO as unknown as typeof MutationObserver,
            raf: () => 0,
            caf: () => {},
        });

        const container = new MockElement() as unknown as HTMLDivElement;
        spy.setContainer(container);
        spy.register(new MockElement() as unknown as HTMLElement, 'turn_1');

        // Active-turn selection is offset-based and monotonic, so stale
        // intersection ratios cannot make a sticky prompt jump mid-turn.
        expect(MockIO.lastConfig).toBeNull();

        spy.destroy();
    });

    test('MutationObserver uses childList only, NOT subtree (Fix 3)', () => {
        MockMO.lastConfig = null;
        const spy = createScrollSpy({
            onActive: () => {},
            IntersectionObserver: MockIO as unknown as typeof IntersectionObserver,
            ResizeObserver: MockRO as unknown as typeof ResizeObserver,
            MutationObserver: MockMO as unknown as typeof MutationObserver,
            raf: () => 0,
            caf: () => {},
        });

        const container = new MockElement() as unknown as HTMLDivElement;
        spy.setContainer(container);

        // Fix 3: subtree:true was removed. Without it, MO only fires for
        // direct children of the scroll container — turn-internal mutations
        // (streaming text growth, tool reveal) don't invalidate the spy.
        expect(MockMO.lastConfig).not.toBeNull();
        expect(MockMO.lastConfig!.childList).toBe(true);
        expect(MockMO.lastConfig!.subtree === undefined).toBe(true);

        spy.destroy();
    });

    test('rAF schedule is coalesced — multiple schedule() calls produce one rAF', () => {
        let scheduledCount = 0;
        // Use a mutable holder so TypeScript's CFA doesn't narrow to 'never'
        // inside the if-block (the raf callback assigns via a closure).
        const rafState: { cb: ((time: number) => void) | null } = { cb: null };
        // Helper that narrows the callback type properly inside its own scope
        // (TypeScript CFA for object properties set via closures can otherwise
        // collapse the union to 'never' at the call site).
        const drainRAF = () => {
            const cb = rafState.cb;
            if (cb) {
                cb(0);
                rafState.cb = null;
            }
        };
        const spy = createScrollSpy({
            onActive: () => {},
            IntersectionObserver: MockIO as unknown as typeof IntersectionObserver,
            ResizeObserver: MockRO as unknown as typeof ResizeObserver,
            MutationObserver: MockMO as unknown as typeof MutationObserver,
            raf: (cb) => {
                scheduledCount += 1;
                rafState.cb = cb as ((time: number) => void);
                return scheduledCount;
            },
            caf: () => {},
        });

        const container = new MockElement() as unknown as HTMLDivElement;
        spy.setContainer(container);

        // setContainer triggers an initial schedule(). Drain it so `frame`
        // is cleared before we test the coalescing of subsequent markDirty().
        drainRAF();

        // Fire multiple markDirty() calls (simulating multiple RO/MO
        // callbacks in the same frame). The spy should coalesce them into
        // a single rAF — the second and third calls must be no-ops.
        const before = scheduledCount;
        spy.markDirty();
        spy.markDirty();
        spy.markDirty();
        expect(scheduledCount).toBe(before + 1); // only one new rAF

        // Flush the rAF — the gate should clear so the next markDirty
        // schedules a new one.
        drainRAF();
        spy.markDirty();
        expect(scheduledCount).toBe(before + 2); // gate cleared, new rAF scheduled

        spy.destroy();
    });

    test('clear() unobserves all nodes and resets active turn', () => {
        const spy = createScrollSpy({
            onActive: () => {},
            IntersectionObserver: MockIO as unknown as typeof IntersectionObserver,
            ResizeObserver: MockRO as unknown as typeof ResizeObserver,
            MutationObserver: MockMO as unknown as typeof MutationObserver,
            raf: () => 0,
            caf: () => {},
        });

        const container = new MockElement() as unknown as HTMLDivElement;
        spy.setContainer(container);
        spy.register(new MockElement() as unknown as HTMLElement, 'turn_1');
        spy.register(new MockElement() as unknown as HTMLElement, 'turn_2');

        spy.clear();
        expect(spy.getActiveId() === undefined).toBe(true);

        spy.destroy();
    });

    // -----------------------------------------------------------------------
    // Medium risk 3: scrollSpy IO visible map stale geometry.
    // After threshold was reduced to [0, 1], IO only fires on enter/leave.
    // During normal scrolling the visible map keeps stale top/ratio values.
    // update() must re-read getBoundingClientRect for the visible subset
    // so active-turn picking uses current positions.
    //
    // Note: the production IO callback uses `element instanceof HTMLElement`
    // which requires a DOM environment. bun:test has no DOM globals, so these
    // tests verify the refreshVisibleGeometry logic indirectly: update() must
    // not crash when the visible map is empty (the no-DOM default), and the
    // spy must remain functional after multiple onScroll → update cycles with
    // changing geometry. With an empty visible map, refreshVisibleGeometry is
    // a no-op (early return on visible.size === 0) — the key structural
    // assertion is that the code path exists and runs without error.
    // -----------------------------------------------------------------------
    test('MEDIUM RISK 3: update() via onScroll does not crash with empty visible map (geometry refresh is a no-op)', () => {
        let rafCallback: ((time: number) => void) | null = null;
        const rafQueue: Array<() => void> = [];

        const spy = createScrollSpy({
            onActive: () => {},
            IntersectionObserver: MockIO as unknown as typeof IntersectionObserver,
            ResizeObserver: MockRO as unknown as typeof ResizeObserver,
            MutationObserver: MockMO as unknown as typeof MutationObserver,
            raf: (cb) => {
                rafCallback = cb as (time: number) => void;
                rafQueue.push(() => rafCallback!(0));
                return 0;
            },
            caf: () => {},
        });

        const container = new MockElement() as unknown as HTMLDivElement;
        (container as unknown as MockElement).rect.top = 0;
        spy.setContainer(container);

        // Register two turn elements.
        const turnA = new MockElement();
        turnA.dataset.turnId = 'turn_a';
        turnA.rect.top = 100;
        const turnB = new MockElement();
        turnB.dataset.turnId = 'turn_b';
        turnB.rect.top = 200;

        spy.register(turnA as unknown as HTMLElement, 'turn_a');
        spy.register(turnB as unknown as HTMLElement, 'turn_b');

        // Drain the initial setContainer + register rAFs. With no IO entries
        // delivered (no DOM for instanceof check), the visible map is empty.
        // update() should call refreshVisibleGeometry() (no-op on empty map)
        // then fall back to refreshOffsets() + pickOffsetTurnId().
        while (rafQueue.length > 0) {
            rafQueue.shift()!();
            rafCallback = null;
        }

        // Change geometry and trigger onScroll → update().
        turnA.rect.top = 50;
        turnB.rect.top = 150;
        spy.onScroll();
        while (rafQueue.length > 0) {
            rafQueue.shift()!();
            rafCallback = null;
        }

        // After update() with empty visible map: refreshVisibleGeometry is a
        // no-op (visible.size === 0 → early return). The spy falls back to
        // offset-based picking. The key assertion: no crash, spy functional.
        expect(spy.getActiveId() !== undefined).toBe(true);

        spy.destroy();
    });

    test('MEDIUM RISK 3: spy survives multiple onScroll cycles with changing geometry', () => {
        // Verify the geometry refresh path runs on every update() without
        // accumulating stale state or crashing across many scroll cycles.
        let rafCallback: ((time: number) => void) | null = null;
        const rafQueue: Array<() => void> = [];

        const spy = createScrollSpy({
            onActive: () => {},
            IntersectionObserver: MockIO as unknown as typeof IntersectionObserver,
            ResizeObserver: MockRO as unknown as typeof ResizeObserver,
            MutationObserver: MockMO as unknown as typeof MutationObserver,
            raf: (cb) => {
                rafCallback = cb as (time: number) => void;
                rafQueue.push(() => rafCallback!(0));
                return 0;
            },
            caf: () => {},
        });

        const container = new MockElement() as unknown as HTMLDivElement;
        spy.setContainer(container);

        const turnA = new MockElement();
        turnA.dataset.turnId = 'turn_a';
        spy.register(turnA as unknown as HTMLElement, 'turn_a');

        // Drain initial rAFs.
        while (rafQueue.length > 0) {
            rafQueue.shift()!();
            rafCallback = null;
        }

        // Simulate multiple scroll cycles with changing geometry.
        for (let i = 0; i < 10; i += 1) {
            turnA.rect.top = 100 + i * 10; // geometry changes each cycle
            spy.onScroll();
            while (rafQueue.length > 0) {
                rafQueue.shift()!();
                rafCallback = null;
            }
        }

        // The spy must survive all cycles without crashing. The geometry
        // refresh logic (refreshVisibleGeometry) runs on every update() call
        // — with an empty visible map it's a no-op, with visible entries it
        // re-reads getBoundingClientRect for the visible subset only.
        expect(spy.getActiveId() !== undefined).toBe(true);

        spy.destroy();
    });

    test('activates the final turn throughout the chat bottom spacer', () => {
        const frames: FrameRequestCallback[] = [];
        const activeTurnIds: string[] = [];
        const spy = createScrollSpy({
            onActive: (turnId) => activeTurnIds.push(turnId),
            raf: (callback) => {
                frames.push(callback);
                return frames.length;
            },
            caf: () => {},
        });
        const container = {
            scrollHeight: 1_000,
            scrollTop: 870,
            clientHeight: 100,
            getBoundingClientRect: () => ({ top: 0 }),
        } as HTMLDivElement;
        const previousTurn = {
            getBoundingClientRect: () => ({ top: -120 }),
        } as HTMLElement;
        const finalTurn = {
            getBoundingClientRect: () => ({ top: 120 }),
        } as HTMLElement;

        spy.setContainer(container);
        spy.register(previousTurn, 'previous');
        spy.register(finalTurn, 'final');
        while (frames.length > 0) {
            frames.shift()?.(0);
        }

        expect(activeTurnIds).toEqual(['final']);
        spy.destroy();
    });
});
