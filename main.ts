import { fork, ChildProcess } from 'child_process';
import path from 'path';

const SERVER_FILE = path.resolve(import.meta.dir, 'server.ts');
let child: ChildProcess | null = null;
let intentionalExit = false;

function spawnServer(): void {
    if (child) {
        console.log('ℹ️ Server process already running.');
        return;
    }

    console.log(`🚀 Starting server from ${SERVER_FILE}...`);
    // Use 'bun' to run the .ts file directly
    child = fork(SERVER_FILE, [], {
        stdio: 'inherit', // Pipe stdin, stdout, stderr to the parent
        execPath: 'bun' // Specify 'bun' as the executable
    });

    child.on('message', (message) => {
        console.log('Message from child:', message);
    });

    child.on('error', (error) => {
        console.error('❌ Error in child process:', error);
        // The 'exit' event will still fire, so restart logic is handled there.
    });

    child.on('exit', (code, signal) => {
        console.log(`🚪 Server process exited with code ${code} and signal ${signal}`);
        child = null; // Clear the child process reference

        if (intentionalExit) {
            console.log('🛑 Intentional shutdown. Not restarting.');
            process.exit(0);
            return;
        }

        if (code !== 0 && signal !== 'SIGINT' && signal !== 'SIGTERM') {
            console.error(`❌ Server crashed with code ${code} and signal ${signal}. Restarting...`);
            setTimeout(spawnServer, 1000); // Wait 1 second before restarting
        } else {
            console.log('✅ Server process exited normally or was intentionally stopped. Not restarting.');
            process.exit(code === null ? 1 : code); // Exit parent if child exited normally or was stopped.
        }
    });
}

// Graceful shutdown handling
function gracefulShutdown(signal: string): void {
    console.log(`
🚦 Received ${signal}. Shutting down gracefully...`);
    intentionalExit = true;
    if (child) {
        console.log('🔪 Sending SIGINT to child process...');
        child.kill('SIGINT'); // Send SIGINT to the child, allowing it to clean up
        // Set a timeout to forcefully kill if it doesn't exit
        setTimeout(() => {
            if (child) {
                console.warn('⚠️ Child process did not exit gracefully. Forcing shutdown...');
                child.kill('SIGKILL');
            }
        }, 5000); // 5 seconds timeout
    } else {
        process.exit(0); // If no child, exit immediately
    }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
    console.error('🚨 Uncaught Exception in main process:', error);
    intentionalExit = false; // Assume crash
    if (child) {
        child.kill('SIGKILL'); // Kill child immediately on main process crash
    }
    process.exit(1);
});

// Start the server for the first time
spawnServer(); 