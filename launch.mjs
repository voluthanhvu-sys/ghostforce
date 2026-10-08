import { app } from './ghostforge-server.js';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
app.use(express.static(fileURLToPath(new URL('./dist/', import.meta.url))));
const requested = Number(process.env.PORT || 8080);
function listen(port) {
    const server = app.listen(port, '127.0.0.1', () => {
        const url = `http://127.0.0.1:${server.address().port}`;
        console.log(`GhostForge: ${url}\nKeep this terminal open while using the app.`);
        if (process.platform === 'win32' && process.env.GHOSTFORGE_NO_BROWSER !== '1') {
            const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, stdio: 'ignore' });
            child.on('error', () => console.log('Open the URL above in your browser.'));
        }
    });
    server.on('error', error => {
        if (port !== 0 && ['EACCES', 'EADDRINUSE'].includes(error.code)) { console.log(`Port ${port} unavailable; choosing a free port.`); listen(0); }
        else { console.error(error.message); process.exitCode = 1; }
    });
}
listen(requested);
