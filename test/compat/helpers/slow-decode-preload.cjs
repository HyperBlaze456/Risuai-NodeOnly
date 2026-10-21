// Test-only timing control, loaded into the server via NODE_OPTIONS=--require.
// While a `slow-decode` file exists in the server's cwd, every decodeRisuSave
// waits 300 ms first — long enough for a second request to start while a
// flush is still writing database.bin.
const path = require('node:path');
const fs = require('node:fs');
const utils = require('../../../server/node/utils.cjs');

const original = utils.decodeRisuSave;
utils.decodeRisuSave = async (...args) => {
    if (fs.existsSync(path.join(process.cwd(), 'slow-decode'))) {
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return original(...args);
};
