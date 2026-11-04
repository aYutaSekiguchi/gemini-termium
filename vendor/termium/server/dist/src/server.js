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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const grpc = __importStar(require("@grpc/grpc-js"));
const browser_session_1 = require("./browser-session");
const puppeteer = __importStar(require("puppeteer"));
const commander_1 = require("commander");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const debug_1 = __importDefault(require("debug"));
const capture_diagnostics_1 = require("./capture-diagnostics");
const bc_1 = require("../generated/bc");
const program = new commander_1.Command();
const logDebug = (0, debug_1.default)('server:debug');
// Puppeteer browser and page instances
let browser = null;
let page = null;
let browserLaunch = null;
let shuttingDown = false;
const browserAbort = new AbortController();
const controls = new browser_session_1.BrowserSession(async () => {
    await launchOrConnectToBrowser();
    return browser;
}, setupDialogHandler, () => options.homepage);
async function ensurePage() {
    page = await controls.ensurePage();
    return page;
}
// Chromium capture and viewport emulation both affect the compositor surface.
// Serialize requests, including an in-flight frame after cancellation.
let viewportWork = Promise.resolve();
function withViewport(action) {
    const work = viewportWork.then(action);
    viewportWork = work.catch(() => { });
    return work;
}
let dialogStream = null;
const pendingDialogs = new Map();
let dialogIdCounter = 0;
// CLI setup with Commander
program
    .option('--homepage <url>', 'Startup and new-tab page', 'https://termium.dev/welcome/')
    .option('-b, --browser <ip:port>', 'Connect to an existing browser instance (ip:port)', '')
    .option('-d, --debug [filename]', 'Enable debug mode (log to stdout or optional file)', '')
    .option('--daemon', 'Run server as a daemon')
    .option('--tcp <ip:port>', 'Use TCP socket instead of Unix domain socket', '')
    .option('--socket <path>', 'Private Unix socket path', '/tmp/termium.sock')
    .option('-h, --help', 'Display help information')
    .description('gRPC server for browser control using Puppeteer');
program.parse(process.argv);
const options = program.opts();
// Setup debugging
if (options.debug !== undefined) {
    debug_1.default.enable('server:debug');
    if (typeof options.debug === 'string' && options.debug) {
        // If a filename is provided, log to file
        const logStream = fs.createWriteStream(path.resolve(options.debug), { flags: 'a' });
        logDebug.log = (...args) => logStream.write(args.join(' ') + '\n');
    }
    else {
        // Log to stdout by default
        logDebug.log = console.log.bind(console);
    }
}
// Daemonize the process if --daemon is passed (only works on Linux/Mac)
if (options.daemon) {
    const daemonize = require('daemonize2').setup({
        main: path.join(__dirname, 'server.js'),
        name: 'grpc-browser-control',
        pidfile: 'grpc-browser-control.pid'
    });
    daemonize.start();
    process.exit(0);
}
// Helper function to set up dialog handler on a page
function setupDialogHandler(page, tabId) {
    page.on('dialog', async (dialog) => {
        const dialogType = dialog.type();
        const message = dialog.message();
        const defaultValue = dialog.defaultValue();
        logDebug(`Dialog detected - Type: ${dialogType}, Message: ${message}`);
        // If we have a connected client, send dialog to them
        if (dialogStream) {
            const dialogId = `dialog_${++dialogIdCounter}`;
            // Map Puppeteer dialog type to our proto enum
            let protoType = 0; // ALERT
            if (dialogType === 'confirm')
                protoType = 1;
            else if (dialogType === 'prompt')
                protoType = 2;
            else if (dialogType === 'beforeunload')
                protoType = 3;
            // Send dialog event to client
            try {
                const owner = dialogStream;
                await new Promise((resolve) => {
                    pendingDialogs.set(dialogId, { dialog, owner, resolver: resolve });
                    owner.write({
                        id: dialogId,
                        type: protoType,
                        message,
                        defaultValue: defaultValue || '', tabId
                    });
                });
            }
            catch (error) {
                pendingDialogs.delete(dialogId);
                logDebug(`Error sending dialog to client: ${error.message}`);
                // Fallback to auto-accept if client communication fails
                await dialog.accept(defaultValue || '');
            }
        }
        else {
            // No client connected, auto-accept to prevent blocking
            logDebug('No client connected, auto-accepting dialog');
            await dialog.accept(defaultValue || '');
        }
    });
    logDebug('Dialog handler installed on page');
}
// Function to launch or connect to the browser
async function launchOrConnectToBrowser() {
    if (shuttingDown)
        throw new Error('Server is shutting down');
    if (browser)
        return;
    // Concurrent RPCs must share one launch, including its cancellation.
    if (!browserLaunch) {
        browserLaunch = launchBrowser().finally(() => { browserLaunch = null; });
    }
    await browserLaunch;
}
async function launchBrowser() {
    if (options.browser) {
        // Connect to an existing browser instance using DevTools protocol
        logDebug('Connecting to existing browser instance at', options.browser);
        browser = await puppeteer.connect({ browserWSEndpoint: `ws://${options.browser}`, defaultViewport: null });
    }
    else {
        // Launch a new headless browser if no browser address is provided
        logDebug('Launching a new headless browser');
        browser = await puppeteer.launch({
            handleSIGINT: false,
            handleSIGTERM: false,
            signal: browserAbort.signal,
            headless: true,
            pipe: true,
            enableExtensions: true,
            // We apply desktop metrics to the active target directly. Puppeteer's
            // viewport helper also changes touch emulation and can hang after a
            // modal on macOS. It must not maintain competing emulation state.
            defaultViewport: null,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            ]
        });
    }
    (0, capture_diagnostics_1.startCaptureDiagnostics)(browser);
}
const maxScreenshotBytes = 32 * 1024 * 1024;
let pendingCaptures = 0;
async function captureScreenshot(format, cancelled) {
    if (format && format !== 'png' && format !== 'jpeg')
        throw Object.assign(new Error('Use png or jpeg'), { code: grpc.status.INVALID_ARGUMENT });
    if (pendingCaptures >= 2)
        throw Object.assign(new Error('Capture is busy'), { code: grpc.status.RESOURCE_EXHAUSTED });
    pendingCaptures++;
    const admission = (0, capture_diagnostics_1.beginCapturePhase)('server.viewport_queue');
    try {
        return await withViewport(async () => {
            (0, capture_diagnostics_1.endCapturePhase)(admission);
            if (cancelled())
                throw Object.assign(new Error('Capture cancelled'), { code: grpc.status.CANCELLED });
            const frame = await controls.capture(format === 'png' ? 'png' : 'jpeg');
            if (frame.data.length > maxScreenshotBytes)
                throw Object.assign(new Error('Screenshot exceeds 32 MiB'), { code: grpc.status.RESOURCE_EXHAUSTED });
            return frame;
        });
    }
    finally {
        pendingCaptures--;
    }
}
const browserControlHandlers = {
    openTab: async (_call, callback) => {
        try {
            await ensurePage();
            callback(null, { text: 'Tab ready' });
        }
        catch (error) {
            callback({ code: grpc.status.INTERNAL, message: error.message });
        }
    },
    getBrowserState: async (_call, callback) => {
        try {
            callback(null, await controls.state());
        }
        catch (error) {
            callback({ code: grpc.status.INTERNAL, message: error.message });
        }
    },
    browserCommand: async (call, callback) => {
        try {
            callback(null, await controls.command(call.request));
        }
        catch (error) {
            callback({ code: error.code ?? grpc.status.INTERNAL, message: error.message, metadata: error.metadata });
        }
    },
    sendInput: async (call, callback) => {
        try {
            const state = await controls.input(call.request);
            callback(null, { text: 'Input dispatched', state });
        }
        catch (error) {
            callback({ code: error.code ?? grpc.status.INTERNAL, message: error.message, metadata: error.metadata });
        }
    },
    setViewport: async (call, callback) => {
        try {
            await ensurePage();
            const { width, height } = call.request;
            await withViewport(() => controls.setViewport(width, height));
            logDebug(`Viewport set to ${width}x${height}`);
            callback(null, { text: 'Viewport set' });
        }
        catch (error) {
            logDebug('Error in setViewport:', error.message);
            callback({
                code: error.code ?? grpc.status.INTERNAL,
                message: `Failed to set viewport: ${error.message}`,
            });
        }
    },
    clickMouse: async (call, callback) => {
        try {
            const page = await ensurePage();
            const { x, y } = call.request;
            await page.mouse.click(x, y);
            callback(null, { text: 'Mouse clicked' });
        }
        catch (error) {
            logDebug('Error in clickMouse:', error.message);
            callback({
                code: grpc.status.INTERNAL,
                message: `Failed to click mouse: ${error.message}`,
            });
        }
    },
    sendKeyboardInput: async (call, callback) => {
        try {
            const page = await ensurePage();
            const content = call.request.content;
            // Check if this is a special key (format: __KEY__KeyName)
            if (content.startsWith('__KEY__')) {
                const key = content.substring(7); // Remove __KEY__ prefix
                logDebug(`Pressing special key: ${key}`);
                await page.keyboard.press(key);
            }
            else {
                // Regular text input
                logDebug(`Typing text: ${content}`);
                await page.keyboard.type(content);
            }
            callback(null, { text: 'Keyboard input sent' });
        }
        catch (error) {
            logDebug('Error in sendKeyboardInput:', error.message);
            callback({
                code: grpc.status.INTERNAL,
                message: `Failed to send keyboard input: ${error.message}`,
            });
        }
    },
    navigateToUrl: async (call, callback) => {
        try {
            const url = call.request.url;
            logDebug(`Attempting to navigate to URL: ${url}`);
            await ensurePage();
            // Start navigation
            logDebug(`Starting navigation to: ${url}`);
            await page.goto(url, {
                waitUntil: 'networkidle0',
                timeout: 8000
            });
            const newUrl = page.url();
            logDebug(`Successfully navigated to: ${url}, actual URL: ${newUrl}`);
            callback(null, { text: `Navigated to ${newUrl}` });
        }
        catch (error) {
            const errorMessage = error.message;
            const url = call.request.url;
            // Log more details about the error
            logDebug(`Navigation error for '${url}': ${errorMessage}`);
            // A responsive old page is not evidence that this navigation worked.
            // Preserve real failures, including browser launch and network errors.
            callback({
                code: error instanceof puppeteer.TimeoutError
                    ? grpc.status.DEADLINE_EXCEEDED : grpc.status.INTERNAL,
                message: `Navigation to '${url}' failed: ${errorMessage}`,
            });
        }
    },
    getCurrentUrl: async (_call, callback) => {
        try {
            const page = await ensurePage();
            const currentUrl = page.url();
            callback(null, { url: currentUrl });
        }
        catch (error) {
            logDebug('Error in getCurrentUrl:', error.message);
            callback({
                code: grpc.status.INTERNAL,
                message: `Failed to get current URL: ${error.message}`,
            });
        }
    },
    captureScreenshot: async (call, callback) => {
        await (0, capture_diagnostics_1.captureScope)(async () => {
            const handler = (0, capture_diagnostics_1.beginCapturePhase)('server.handler');
            try {
                const frame = await captureScreenshot(call.request.format, () => call.cancelled);
                const response = (0, capture_diagnostics_1.beginCapturePhase)('server.response_callback');
                try {
                    callback(null, frame);
                }
                finally {
                    (0, capture_diagnostics_1.endCapturePhase)(response);
                }
            }
            catch (error) {
                callback(error);
            }
            finally {
                (0, capture_diagnostics_1.endCapturePhase)(handler);
            }
        });
    },
    streamDialogs: (call) => {
        logDebug('Dialog stream connected');
        if (dialogStream) {
            call.emit('error', { code: grpc.status.RESOURCE_EXHAUSTED, message: 'A dialog stream is already connected' });
            return;
        }
        dialogStream = call;
        // A client can wait for headers before triggering a page dialog.
        call.sendMetadata(new grpc.Metadata());
        // Resolve once, and always consume Puppeteer's promise rejection.
        const finish = async (id, pending, response) => {
            pendingDialogs.delete(id);
            try {
                if (response.accepted) {
                    await pending.dialog.accept(pending.dialog.type() === 'prompt' ? response.inputText : undefined);
                }
                else {
                    await pending.dialog.dismiss();
                }
            }
            catch (error) {
                logDebug(`Failed to resolve dialog ${id}: ${error.message}`);
            }
            finally {
                pending.resolver();
            }
        };
        call.on('data', (response) => {
            const pending = pendingDialogs.get(response.id);
            if (pending && pending.owner === call) {
                void finish(response.id, pending, response);
            }
        });
        let disconnected = false;
        const disconnect = () => {
            if (disconnected)
                return;
            disconnected = true;
            if (dialogStream === call)
                dialogStream = null;
            for (const [id, pending] of pendingDialogs) {
                if (pending.owner === call) {
                    void finish(id, pending, { accepted: true, inputText: pending.dialog.defaultValue() });
                }
            }
            call.end();
        };
        call.on('end', disconnect);
        call.on('cancelled', disconnect);
        call.on('error', disconnect);
    },
};
// gRPC server setup
function main() {
    const server = new grpc.Server();
    const service = process.env.TERMIUM_CAPTURE_TRACE === '1' ? {
        ...bc_1.BrowserControlService,
        captureScreenshot: { ...bc_1.BrowserControlService.captureScreenshot, responseSerialize: (value) => {
                const phase = (0, capture_diagnostics_1.beginCapturePhase)('grpc.protobuf_encode');
                try {
                    return bc_1.BrowserControlService.captureScreenshot.responseSerialize(value);
                }
                finally {
                    (0, capture_diagnostics_1.endCapturePhase)(phase);
                }
            } },
    } : bc_1.BrowserControlService;
    server.addService(service, browserControlHandlers);
    // Determine binding address
    let bindAddress;
    if (options.tcp) {
        bindAddress = options.tcp;
        console.log(`Using TCP socket: ${bindAddress}`);
    }
    else {
        // Use Unix domain socket by default
        bindAddress = `unix://${options.socket}`;
        // Clean up any existing socket file
        const socketPath = options.socket;
        if (fs.existsSync(socketPath)) {
            fs.unlinkSync(socketPath);
        }
        console.log(`Using Unix domain socket: ${socketPath}`);
    }
    server.bindAsync(bindAddress, grpc.ServerCredentials.createInsecure(), (err, port) => {
        if (err) {
            console.error('Failed to bind server:', err);
            process.exitCode = 1;
            server.forceShutdown();
            return;
        }
        if (options.tcp) {
            // Report the actual port when the OS assigns one (--tcp 127.0.0.1:0).
            console.log(`Server running at ${bindAddress.replace(/:\d+$/, `:${port}`)}`);
        }
        else {
            fs.chmodSync(options.socket, 0o600);
            console.log(`Server running on Unix domain socket: ${options.socket}`);
        }
        // Readiness sentinel — client watches for this line to know server is accepting connections
        console.log('TERMIUM_READY');
    });
    // Termination must not wait for clients to close long-lived streams. Abort
    // any in-flight browser launch too; browser may not have been assigned yet.
    const shutdown = async (signal) => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        console.log(`Received ${signal}, shutting down...`);
        server.forceShutdown();
        const forcedExit = setTimeout(() => {
            console.error('Shutdown timed out');
            browserAbort.abort();
            process.exit(1);
        }, 2000);
        try {
            if (!browser)
                browserAbort.abort();
            await browserLaunch?.catch(() => { });
            if (browser)
                await browser.close();
            console.log('Server shutdown complete');
            clearTimeout(forcedExit);
            process.exit(0);
        }
        catch (error) {
            console.error('Error shutting down:', error);
            browserAbort.abort();
            clearTimeout(forcedExit);
            process.exit(1);
        }
    };
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => { void shutdown(signal); });
    }
    // Also handle uncaught exceptions and unhandled rejections
    process.on('uncaughtException', async (error) => {
        console.error('Uncaught exception:', error);
        if (browser) {
            try {
                await browser.close();
            }
            catch (closeError) {
                console.error('Error closing browser on uncaught exception:', closeError);
            }
        }
        process.exit(1);
    });
    process.on('unhandledRejection', async (reason, promise) => {
        console.error('Unhandled rejection at:', promise, 'reason:', reason);
        if (browser) {
            try {
                await browser.close();
            }
            catch (closeError) {
                console.error('Error closing browser on unhandled rejection:', closeError);
            }
        }
        process.exit(1);
    });
}
main();
