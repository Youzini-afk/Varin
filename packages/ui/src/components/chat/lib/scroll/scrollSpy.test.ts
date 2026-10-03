import { describe, expect, test, vi } from 'vitest';
import { createScrollSpy, pickOffsetTurnId } from './scrollSpy';

class Geometry {
    top = 200;
    scrollTop = 0;
    scrollHeight = 10_000;
    clientHeight = 400;
    getBoundingClientRect() { return { top: this.top }; }
}

class ResizeObserverFixture {
    static latest: ResizeObserverFixture;
    observed = new Set<Element>();
    constructor() { ResizeObserverFixture.latest = this; }
    observe(element: Element) { this.observed.add(element); }
    unobserve(element: Element) { this.observed.delete(element); }
    disconnect() { this.observed.clear(); }
}

const frameScheduler = () => {
    const pending: FrameRequestCallback[] = [];
    let id = 0;
    return {
        raf: vi.fn((callback: FrameRequestCallback) => { pending.push(callback); return ++id; }),
        caf: vi.fn(),
        flush() { while (pending.length) pending.shift()!(0); },
    };
};

describe('turn selection', () => {
    test('selects the last turn before the reading line, including empty and edge positions', () => {
        const turns = [{ id: 'a', top: 10 }, { id: 'b', top: 50 }, { id: 'c', top: 100 }];
        expect(pickOffsetTurnId([], 100)).toBeUndefined();
        expect(pickOffsetTurnId(turns, 5)).toBe('a');
        expect(pickOffsetTurnId(turns, 75)).toBe('b');
        expect(pickOffsetTurnId(turns, 100)).toBe('c');
        expect(pickOffsetTurnId(turns, 300)).toBe('c');
    });

    test('keeps a long turn active until scrolling crosses the next turn at a large scroll offset', () => {
        const frames = frameScheduler();
        const active: string[] = [];
        const spy = createScrollSpy({ ...frames, onActive: id => active.push(id) });
        const container = new Geometry();
        container.scrollTop = 5_000;
        const first = new Geometry(); first.top = 100;
        const next = new Geometry(); next.top = 500;
        try {
            spy.setContainer(container as unknown as HTMLDivElement);
            spy.register(first as unknown as HTMLElement, 'first');
            spy.register(next as unknown as HTMLElement, 'next');
            frames.flush();
            expect(active).toEqual(['first']);
            container.scrollTop += 100;
            first.top -= 100; next.top -= 100;
            spy.onScroll(); frames.flush();
            expect(active).toEqual(['first']);
            container.scrollTop += 300;
            first.top -= 300; next.top -= 300;
            spy.onScroll(); frames.flush();
            expect(active).toEqual(['first', 'next']);
        } finally { spy.destroy(); }
    });

    test('activates the final turn throughout the chat bottom spacer', () => {
        const frames = frameScheduler();
        const active: string[] = [];
        const spy = createScrollSpy({ ...frames, onActive: id => active.push(id) });
        const container = new Geometry();
        Object.assign(container, { top: 0, scrollHeight: 1_000, scrollTop: 870, clientHeight: 100 });
        const previous = new Geometry(); previous.top = -120;
        const final = new Geometry(); final.top = 120;
        try {
            spy.setContainer(container as unknown as HTMLDivElement);
            spy.register(previous as unknown as HTMLElement, 'previous');
            spy.register(final as unknown as HTMLElement, 'final');
            frames.flush();
            expect(active).toEqual(['final']);
        } finally { spy.destroy(); }
    });
});

describe('scroll observer lifecycle', () => {
    test('coalesces invalidations into one frame and admits a later frame', () => {
        const frames = frameScheduler();
        const spy = createScrollSpy({ ...frames, onActive: () => {} });
        try {
            spy.setContainer(new Geometry() as unknown as HTMLDivElement);
            frames.flush(); frames.raf.mockClear();
            spy.markDirty(); spy.markDirty(); spy.onScroll();
            expect(frames.raf).toHaveBeenCalledTimes(1);
            frames.flush();
            spy.markDirty();
            expect(frames.raf).toHaveBeenCalledTimes(2);
        } finally { spy.destroy(); }
    });

    test('clears turn observations and disconnects resources on destruction', () => {
        const frames = frameScheduler();
        const spy = createScrollSpy({ ...frames, onActive: () => {},
            ResizeObserver: ResizeObserverFixture as unknown as typeof ResizeObserver });
        const container = new Geometry() as unknown as HTMLDivElement;
        const turn = new Geometry() as unknown as HTMLElement;
        spy.setContainer(container);
        spy.register(turn, 'first'); frames.flush();
        const observer = ResizeObserverFixture.latest;
        expect(spy.getActiveId()).toBe('first');
        expect(observer.observed.has(turn)).toBe(true);
        spy.clear();
        expect(spy.getActiveId()).toBeUndefined();
        expect(observer.observed.has(turn)).toBe(false);
        spy.register(turn, 'replacement');
        spy.destroy();
        expect(observer.observed.size).toBe(0);
        expect(frames.caf).toHaveBeenCalledTimes(1);
    });

    // This browser option guards repeated whole-chat invalidation while tokens stream.
    test('does not subscribe the mutation observer to turn interiors', () => {
        let observed: MutationObserverInit | undefined;
        class MutationObserverFixture {
            observe(_node: Node, options: MutationObserverInit) { observed = options; }
            disconnect() {}
        }
        const spy = createScrollSpy({ ...frameScheduler(), onActive: () => {},
            ResizeObserver: ResizeObserverFixture as unknown as typeof ResizeObserver,
            MutationObserver: MutationObserverFixture as unknown as typeof MutationObserver });
        try {
            spy.setContainer(new Geometry() as unknown as HTMLDivElement);
            expect(observed?.childList).toBe(true);
            expect(observed?.subtree).not.toBe(true);
        } finally { spy.destroy(); }
    });
});
