// node:test isolates each file in its own process. Keep the entire runtime lifecycle
// offline, including detached auth work after an individual test restores fetch.
// Tests install their own response stubs and restore this closed fixture, never native fetch.
globalThis.fetch = async () => { throw new Error('Unexpected request outside an active fetch fixture'); };

export {};
