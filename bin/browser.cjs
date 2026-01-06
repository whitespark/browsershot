const fs = require('fs');
const URL = require('url').URL;
const URLParse = require('url').parse;
const net = require('net');

if (typeof global.ReadableStream === 'undefined') {
    const {ReadableStream} = require("stream/web");
    global.ReadableStream = ReadableStream;
}

const [, , ...args] = process.argv;

/**
 * There are two ways for Browsershot to communicate with puppeteer:
 * - By giving a options JSON dump as an argument
 * - Or by providing a temporary file with the options JSON dump,
 *   the path to this file is then given as an argument with the flag -f
 */
const request = args[0].startsWith('-f ')
    ? JSON.parse(fs.readFileSync(new URL(args[0].substring(3))))
    : JSON.parse(args[0]);

const requestsList = [];

const redirectHistory = [];

const consoleMessages = [];

const failedRequests = [];

const pageErrors = [];

function isPortOpen(host, port, timeout = 300) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(timeout);
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => resolve(false));
        socket.once("timeout", () => { socket.destroy(); resolve(false); });
        socket.connect(port, host);
    });
}

const getOutput = async (request, page = null) => {
    let output = {
        requestsList,
        consoleMessages,
        failedRequests,
        redirectHistory,
        pageErrors,
    };

    if (
        ![
            'requestsList',
            'consoleMessages',
            'failedRequests',
            'redirectHistory',
            'pageErrors',
        ].includes(request.action) &&
        page
    ) {
        if (request.action == 'evaluate') {
            output.result = await page.evaluate(request.options.pageFunction);
        } else {
            const result = await page[request.action](request.options);

            // Ignore output result when saving to a file
            output.result = request.options.path
                ? ''
                : (result instanceof Uint8Array ? Buffer.from(result) : result).toString('base64');
        }
    }

    if (page) {
        return JSON.stringify(output);
    }

    // this will allow adding additional error info (only reach this point when there's an exception)
    return output;
};

const callChrome = async pup => {
    let browser;
    let page;
    let remoteInstance;
    const puppet = (pup || require('puppeteer'));

    try {
        if ( request.options.remoteInstanceUrl || request.options.browserWSEndpoint && (await isPortOpen("127.0.0.1", request.options.debuggingPort, 300))) {
            // default options
            let options = {
                acceptInsecureCerts: request.options.acceptInsecureCerts,
                protocolTimeout: 10_000,
            };

            // choose only one method to connect to the browser instance
            if ( request.options.remoteInstanceUrl ) {
                options.browserURL = request.options.remoteInstanceUrl;
            } else if ( request.options.browserWSEndpoint ) {
                options.browserWSEndpoint = request.options.browserWSEndpoint;
            }

            try {
                browser = await puppet.connect( options );

                remoteInstance = true;
            } catch (exception) {

                if (request.options.throwOnRemoteConnectionError) {
                    console.error(exception.toString());
                    process.exit(4);
                }

                /** fallback to launching a chromium instance */
            }
        }

        if (!browser) {
            browser = await puppet.launch({
                headless: request.options.newHeadless ? true : 'shell',
                acceptInsecureCerts: request.options.acceptInsecureCerts,
                executablePath: request.options.executablePath,
                args: request.options.args || [],
                pipe: request.options.pipe || false,
                env: {
                    ...(request.options.env || {}),
                    ...process.env
                },
                protocolTimeout: request.options.protocolTimeout ?? 30000,
                debuggingPort: request.options.debuggingPort ?? undefined,
            });
        }

        page = await browser.newPage();

        if (request.options && request.options.viewport) {
            await page.setViewport(request.options.viewport);
        }

        const requestOptions = {};

        await page.goto(request.url, requestOptions);

        if (request.options.function) {
            let functionOptions = {
                polling: request.options.functionPolling,
                timeout: request.options.functionTimeout || request.options.timeout
            };
            await page.waitForFunction(request.options.function, functionOptions);
        }

        if (remoteInstance && page) {
            await page.close();
        }

        await (remoteInstance ? browser.disconnect() : browser.close());
    } catch (exception) {
        if (browser) {
            if (remoteInstance && page) {
                await page.close();
            }

            await (remoteInstance ? browser.disconnect() : browser.close());
        }

        const output = await getOutput(request);

        if (exception.type === 'UnsuccessfulResponse') {
            output.exception = exception.toString();
            console.error(exception.status);
            console.log(JSON.stringify(output));
            process.exit(3);
        }

        output.exception = exception.toString();

        console.error(exception);
        console.log(JSON.stringify(output));

        if (exception.type === 'ElementNotFound') {
            process.exit(2);
        }

        process.exit(1);
    }
};

if (require.main === module) {
    callChrome();
}

exports.callChrome = callChrome;
