"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.traceInput = exports.inputTrace = exports.inputTraceEnabled = void 0;
const node_async_hooks_1 = require("node:async_hooks");
// Opt-in metadata only: never log typed text, paste contents, or page URLs.
exports.inputTraceEnabled = process.env.TERMIUM_INPUT_TRACE === '1';
const context = new node_async_hooks_1.AsyncLocalStorage();
let sequence = 0;
function inputTrace(stage, fields = {}) {
    if (exports.inputTraceEnabled)
        console.log(JSON.stringify({
            scope: 'termium.input', time: new Date().toISOString(), id: context.getStore(), stage, ...fields,
        }));
}
exports.inputTrace = inputTrace;
function traceInput(event, action) {
    if (!exports.inputTraceEnabled)
        return action();
    return context.run(++sequence, async () => {
        const started = performance.now();
        inputTrace('queued', { kind: event.kind, tab: event.tabId, generation: event.generation,
            textBytes: Buffer.byteLength(event.text), modifiers: event.modifiers });
        try {
            const result = await action();
            inputTrace('result', { ok: true, elapsedMs: performance.now() - started });
            return result;
        }
        catch (error) {
            inputTrace('result', { ok: false, elapsedMs: performance.now() - started, error: error.message });
            throw error;
        }
    });
}
exports.traceInput = traceInput;
