'use strict';

const levels = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = levels[process.env.LOG_LEVEL] ?? levels.info;

const format = (level, message, meta = {}) => {
    const ts = new Date().toISOString();
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `[${ts}] [trade-service] [${level.toUpperCase()}] ${message}${metaStr}`;
};

const logger = {
    error: (msg, meta) => levels.error <= currentLevel && console.error(format('error', msg, meta)),
    warn:  (msg, meta) => levels.warn  <= currentLevel && console.warn(format('warn',  msg, meta)),
    info:  (msg, meta) => levels.info  <= currentLevel && console.log(format('info',   msg, meta)),
    debug: (msg, meta) => levels.debug <= currentLevel && console.log(format('debug',  msg, meta)),
};

module.exports = logger;
