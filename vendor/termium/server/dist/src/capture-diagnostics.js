"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startCaptureDiagnostics = exports.captureScope = exports.endCapturePhase = exports.beginCapturePhase = void 0;
// Investigation-only tracing. Never enabled by the normal launcher.
const async_hooks_1 = require("async_hooks");
const fs = __importStar(require("fs/promises"));
const inspector = __importStar(require("inspector"));
const perf_hooks_1 = require("perf_hooks");
const report = process.env.TERMIUM_PERF_REPORT;
const enabled = process.env.TERMIUM_CAPTURE_TRACE === '1' && !!report;
const scope = new async_hooks_1.AsyncLocalStorage();
const spans = [];
let sequence = 0;
let dropped = 0;
const now = () => (perf_hooks_1.performance.timeOrigin + perf_hooks_1.performance.now()) * 1000;
function beginCapturePhase(name) {
    return enabled ? { name, id: scope.getStore() ?? 0, start_us: now() } : undefined;
}
exports.beginCapturePhase = beginCapturePhase;
function endCapturePhase(start) {
    if (!start)
        return;
    if (spans.length >= 100000) {
        dropped++;
        return;
    }
    spans.push({ ...start, duration_us: now() - start.start_us });
}
exports.endCapturePhase = endCapturePhase;
function captureScope(action) {
    return enabled ? scope.run(++sequence, action) : action();
}
exports.captureScope = captureScope;
const delay = (ms) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
async function json(suffix, data) {
    const file = report + suffix;
    await fs.writeFile(file + '.tmp', JSON.stringify(data));
    await fs.rename(file + '.tmp', file);
}
function post(session, method) {
    return new Promise((resolve, reject) => session.post(method, {}, (error, value) => error ? reject(error) : resolve(value)));
}
function startCaptureDiagnostics(browser) {
    if (!enabled)
        return;
    void collect(browser).catch(async (error) => {
        await json('.server.done', { error: String(error) }).catch(() => { });
    });
}
exports.startCaptureDiagnostics = startCaptureDiagnostics;
async function collect(browser) {
    let control;
    for (;;) {
        try {
            control = JSON.parse(await fs.readFile(report + '.start', 'utf8'));
            break;
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            if (!browser.connected)
                throw Error('Browser closed before trace window');
            await delay(25);
        }
    }
    const start = Date.parse(control.start);
    const duration = control.duration_ns / 1e6;
    if (!Number.isFinite(start) || !(duration >= 1000 && duration <= 600000))
        throw Error('Invalid trace window');
    const cdp = await browser.target().createCDPSession();
    const v8 = new inspector.Session();
    v8.connect();
    let tracing = false;
    let profiling = false;
    try {
        const environment = {
            version: await cdp.send('Browser.getVersion'),
            system: await cdp.send('SystemInfo.getInfo'),
            commandLine: await cdp.send('Browser.getBrowserCommandLine'),
        };
        // No screenshot trace category: it embeds extra screenshots in the trace.
        const categories = ['devtools', 'renderer', 'renderer_host', 'cc', 'viz', 'gpu',
            'toplevel', 'toplevel.flow'];
        await cdp.send('Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: {
                recordMode: 'recordUntilFull', traceBufferSizeInKb: 131072, includedCategories: categories,
            } });
        tracing = true;
        const clock = [];
        const sync = async (id) => {
            const before_us = now();
            await cdp.send('Tracing.recordClockSyncMarker', { syncId: id });
            clock.push({ id, before_us, after_us: now() });
        };
        await sync('termium-start');
        await post(v8, 'Profiler.enable');
        await delay(start - Date.now());
        await post(v8, 'Profiler.start');
        profiling = true;
        const actualStart = now();
        await delay(start + duration - Date.now());
        const actualEnd = now();
        const { profile } = await post(v8, 'Profiler.stop');
        profiling = false;
        await sync('termium-end');
        const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
        await cdp.send('Tracing.end');
        tracing = false;
        const info = await complete;
        if (!info.stream || info.dataLossOccurred)
            throw Error('Chromium trace missing or lost events');
        const output = await fs.open(report + '.chromium.json', 'w');
        try {
            for (;;) {
                const chunk = await cdp.send('IO.read', { handle: info.stream, size: 1024 * 1024 });
                await output.writeFile(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : chunk.data);
                if (chunk.eof)
                    break;
            }
        }
        finally {
            await output.close();
            await cdp.send('IO.close', { handle: info.stream });
        }
        await json('.node.cpuprofile', profile);
        await json('.server.timeline.json', { clock, actualStart, actualEnd, control, environment, categories, dropped, spans });
        await json('.server.done', { complete: true });
    }
    finally {
        if (profiling)
            await post(v8, 'Profiler.stop').catch(() => { });
        if (tracing)
            await cdp.send('Tracing.end').catch(() => { });
        v8.disconnect();
        await cdp.detach().catch(() => { });
    }
}
