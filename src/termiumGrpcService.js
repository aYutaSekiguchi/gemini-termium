import grpc from '@grpc/grpc-js';
import * as puppeteer from 'puppeteer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import debugFactory from 'debug';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const bc = require(path.resolve(PROJECT_ROOT, 'vendor/termium/server/dist/generated/bc.js'));
const { BrowserSession } = require(path.resolve(PROJECT_ROOT, 'vendor/termium/server/dist/src/browser-session.js'));
const { beginCapturePhase, endCapturePhase, captureScope, startCaptureDiagnostics } = require(
  path.resolve(PROJECT_ROOT, 'vendor/termium/server/dist/src/capture-diagnostics.js')
);

const logDebug = debugFactory('gemini-termium:grpc');

export function createTermiumGrpcServer({ browserWsUrl, port, homepage = 'https://gemini.google.com' }) {
  let browser = null;
  let page = null;
  let browserLaunch = null;
  let shuttingDown = false;
  const browserAbort = new AbortController();

  let dialogStream = null;
  const pendingDialogs = new Map();
  let dialogIdCounter = 0;

  function setupDialogHandler(pageInstance, tabId) {
    pageInstance.on('dialog', async (dialog) => {
      const dialogType = dialog.type();
      const message = dialog.message();
      const defaultValue = dialog.defaultValue();

      logDebug(`Dialog detected - Type: ${dialogType}, Message: ${message}`);

      if (dialogStream) {
        const dialogId = `dialog_${++dialogIdCounter}`;
        let protoType = 0; // ALERT
        if (dialogType === 'confirm') protoType = 1;
        else if (dialogType === 'prompt') protoType = 2;
        else if (dialogType === 'beforeunload') protoType = 3;

        try {
          const owner = dialogStream;
          await new Promise((resolve) => {
            pendingDialogs.set(dialogId, { dialog, owner, resolver: resolve });
            owner.write({
              id: dialogId,
              type: protoType,
              message,
              defaultValue: defaultValue || '',
              tabId
            });
          });
        } catch (error) {
          pendingDialogs.delete(dialogId);
          logDebug(`Error sending dialog to client: ${error.message}`);
          await dialog.accept(defaultValue || '');
        }
      } else {
        await dialog.accept(defaultValue || '');
      }
    });
  }

  async function launchOrConnectToBrowser() {
    if (shuttingDown) throw new Error('Server is shutting down');
    if (browser) return;
    if (!browserLaunch) {
      browserLaunch = (async () => {
        logDebug('Connecting to browser instance at', browserWsUrl);
        browser = await puppeteer.connect({
          browserWSEndpoint: browserWsUrl.startsWith('ws://') ? browserWsUrl : `ws://${browserWsUrl}`,
          defaultViewport: null
        });
        startCaptureDiagnostics(browser);
      })().finally(() => {
        browserLaunch = null;
      });
    }
    await browserLaunch;
  }

  const controls = new BrowserSession(
    async () => {
      await launchOrConnectToBrowser();
      return browser;
    },
    setupDialogHandler,
    () => homepage
  );

  async function ensurePage() {
    page = await controls.ensurePage();
    return page;
  }

  let viewportWork = Promise.resolve();
  function withViewport(action) {
    const work = viewportWork.then(action);
    viewportWork = work.catch(() => {});
    return work;
  }

  const maxScreenshotBytes = 32 * 1024 * 1024;
  let pendingCaptures = 0;

  async function captureScreenshot(format, cancelled) {
    if (format && format !== 'png' && format !== 'jpeg') {
      throw Object.assign(new Error('Use png or jpeg'), { code: grpc.status.INVALID_ARGUMENT });
    }
    if (pendingCaptures >= 2) {
      throw Object.assign(new Error('Capture is busy'), { code: grpc.status.RESOURCE_EXHAUSTED });
    }
    pendingCaptures++;
    const admission = beginCapturePhase('server.viewport_queue');
    try {
      return await withViewport(async () => {
        endCapturePhase(admission);
        if (cancelled()) {
          throw Object.assign(new Error('Capture cancelled'), { code: grpc.status.CANCELLED });
        }
        const frame = await controls.capture(format === 'png' ? 'png' : 'jpeg');
        if (frame.data.length > maxScreenshotBytes) {
          throw Object.assign(new Error('Screenshot exceeds 32 MiB'), { code: grpc.status.RESOURCE_EXHAUSTED });
        }
        return frame;
      });
    } finally {
      pendingCaptures--;
    }
  }

  const browserControlHandlers = {
    openTab: async (_call, callback) => {
      try {
        await ensurePage();
        callback(null, { text: 'Tab ready' });
      } catch (error) {
        callback({ code: grpc.status.INTERNAL, message: error.message });
      }
    },
    getBrowserState: async (_call, callback) => {
      try {
        callback(null, await controls.state());
      } catch (error) {
        callback({ code: grpc.status.INTERNAL, message: error.message });
      }
    },
    browserCommand: async (call, callback) => {
      try {
        callback(null, await controls.command(call.request));
      } catch (error) {
        callback({
          code: error.code ?? grpc.status.INTERNAL,
          message: error.message,
          metadata: error.metadata
        });
      }
    },
    sendInput: async (call, callback) => {
      try {
        const state = await controls.input(call.request);
        callback(null, { text: 'Input dispatched', state });
      } catch (error) {
        callback({
          code: error.code ?? grpc.status.INTERNAL,
          message: error.message,
          metadata: error.metadata
        });
      }
    },
    setViewport: async (call, callback) => {
      try {
        await ensurePage();
        const { width, height } = call.request;
        await withViewport(() => controls.setViewport(width, height));
        logDebug(`Viewport set to ${width}x${height}`);
        callback(null, { text: 'Viewport set' });
      } catch (error) {
        logDebug('Error in setViewport:', error.message);
        callback({
          code: error.code ?? grpc.status.INTERNAL,
          message: `Failed to set viewport: ${error.message}`
        });
      }
    },
    clickMouse: async (call, callback) => {
      try {
        const p = await ensurePage();
        const { x, y } = call.request;
        await p.mouse.click(x, y);
        callback(null, { text: 'Mouse clicked' });
      } catch (error) {
        logDebug('Error in clickMouse:', error.message);
        callback({
          code: grpc.status.INTERNAL,
          message: `Failed to click mouse: ${error.message}`
        });
      }
    },
    sendKeyboardInput: async (call, callback) => {
      try {
        const p = await ensurePage();
        const content = call.request.content;
        if (content.startsWith('__KEY__')) {
          const key = content.substring(7);
          logDebug(`Pressing special key: ${key}`);
          await p.keyboard.press(key);
        } else {
          logDebug(`Typing text: ${content}`);
          await p.keyboard.type(content);
        }
        callback(null, { text: 'Keyboard input sent' });
      } catch (error) {
        logDebug('Error in sendKeyboardInput:', error.message);
        callback({
          code: grpc.status.INTERNAL,
          message: `Failed to send keyboard input: ${error.message}`
        });
      }
    },
    navigateToUrl: async (call, callback) => {
      try {
        const url = call.request.url;
        logDebug(`Attempting to navigate to URL: ${url}`);
        await ensurePage();
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 8000 });
        const newUrl = page.url();
        callback(null, { text: `Navigated to ${newUrl}` });
      } catch (error) {
        callback({
          code: error instanceof puppeteer.TimeoutError ? grpc.status.DEADLINE_EXCEEDED : grpc.status.INTERNAL,
          message: `Navigation failed: ${error.message}`
        });
      }
    },
    getCurrentUrl: async (_call, callback) => {
      try {
        const p = await ensurePage();
        callback(null, { url: p.url() });
      } catch (error) {
        callback({ code: grpc.status.INTERNAL, message: error.message });
      }
    },
    captureScreenshot: async (call, callback) => {
      await captureScope(async () => {
        const handler = beginCapturePhase('server.handler');
        try {
          const frame = await captureScreenshot(call.request.format, () => call.cancelled);
          const response = beginCapturePhase('server.response_callback');
          try {
            callback(null, frame);
          } finally {
            endCapturePhase(response);
          }
        } catch (error) {
          callback(error);
        } finally {
          endCapturePhase(handler);
        }
      });
    },
    streamDialogs: (call) => {
      logDebug('Dialog stream connected');
      if (dialogStream) {
        call.emit('error', {
          code: grpc.status.RESOURCE_EXHAUSTED,
          message: 'A dialog stream is already connected'
        });
        return;
      }
      dialogStream = call;
      call.sendMetadata(new grpc.Metadata());

      const finish = async (id, pending, response) => {
        pendingDialogs.delete(id);
        try {
          if (response.accepted) {
            await pending.dialog.accept(
              pending.dialog.type() === 'prompt' ? response.inputText : undefined
            );
          } else {
            await pending.dialog.dismiss();
          }
        } catch (error) {
          logDebug(`Failed to resolve dialog ${id}: ${error.message}`);
        } finally {
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
        if (disconnected) return;
        disconnected = true;
        if (dialogStream === call) dialogStream = null;
        for (const [id, pending] of pendingDialogs) {
          if (pending.owner === call) {
            void finish(id, pending, {
              accepted: true,
              inputText: pending.dialog.defaultValue()
            });
          }
        }
        call.end();
      };

      call.on('end', disconnect);
      call.on('cancelled', disconnect);
      call.on('error', disconnect);
    }
  };

  const server = new grpc.Server();
  server.addService(bc.BrowserControlService, browserControlHandlers);

  return {
    async listen(listenPort = port) {
      return new Promise((resolve, reject) => {
        server.bindAsync(`127.0.0.1:${listenPort}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
          if (err) return reject(err);
          logDebug(`Termium gRPC Server listening at 127.0.0.1:${boundPort}`);
          resolve(boundPort);
        });
      });
    },
    async close() {
      shuttingDown = true;
      browserAbort.abort();
      if (browser) {
        try {
          browser.disconnect();
        } catch {}
      }
      return new Promise((resolve) => {
        server.tryShutdown(() => resolve());
      });
    }
  };
}
