import fs from 'fs';
import path from 'path';

const logDirectory = path.join(process.cwd(), 'logs');
const logFile = path.join(logDirectory, 'votes.log');

// Ensure log directory exists
if (!fs.existsSync(logDirectory)) {
    fs.mkdirSync(logDirectory);
}

export const logVoteUpdate = (message: string) => {
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} - ${message}\n`;

    try {
        fs.appendFileSync(logFile, logMessage);
    } catch (error) {
        console.error('Failed to write to vote log:', error);
    }
}; 