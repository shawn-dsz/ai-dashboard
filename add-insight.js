#!/usr/bin/env node
/**
 * add-insight.js — Append a weekly review entry to insights-log.json
 *
 * Usage:
 *   node add-insight.js --file my-review.json
 *   node add-insight.js --weekOf 2026-06-01 --sessions 200 --messages 5000 ...
 *
 * Never overwrites existing entries. Rejects duplicate weekOf values.
 * Validates shape before writing.
 *
 * Entry shape:
 * {
 *   "weekOf": "YYYY-MM-DD",          // required — Monday of the review week
 *   "generatedAt": "YYYY-MM-DD",     // optional — defaults to today
 *   "metrics": {
 *     "sessions": <number>,
 *     "messages": <number>,
 *     "tokens": <number>,
 *     "busiestHour": <0-23>,
 *     "busiestDay": "YYYY-MM-DD",
 *     "delegationRatio": <0-1>
 *   },
 *   "whatsWorking": ["...", "..."],
 *   "friction": ["...", "..."],
 *   "tips": ["...", "..."],
 *   "notes": "..."
 * }
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, 'insights-log.json');

// ---- Helpers ----------------------------------------------------------------

function today() {
    return new Date().toISOString().split('T')[0];
}

function readLog() {
    if (!fs.existsSync(LOG_PATH)) return [];
    const raw = fs.readFileSync(LOG_PATH, 'utf8').trim();
    if (!raw) return [];
    return JSON.parse(raw);
}

function writeLog(entries) {
    fs.writeFileSync(LOG_PATH, JSON.stringify(entries, null, 2) + '\n', 'utf8');
}

function isISODate(str) {
    return /^\d{4}-\d{2}-\d{2}$/.test(str);
}

function validate(entry) {
    const errs = [];

    if (!entry.weekOf || !isISODate(entry.weekOf)) {
        errs.push('weekOf must be YYYY-MM-DD');
    }
    if (entry.generatedAt && !isISODate(entry.generatedAt)) {
        errs.push('generatedAt must be YYYY-MM-DD');
    }

    const m = entry.metrics || {};
    if (typeof m.sessions !== 'number')        errs.push('metrics.sessions must be a number');
    if (typeof m.messages !== 'number')        errs.push('metrics.messages must be a number');
    if (typeof m.tokens   !== 'number')        errs.push('metrics.tokens must be a number');
    if (typeof m.busiestHour !== 'number' || m.busiestHour < 0 || m.busiestHour > 23) {
        errs.push('metrics.busiestHour must be 0-23');
    }
    if (m.busiestDay && !isISODate(m.busiestDay)) {
        errs.push('metrics.busiestDay must be YYYY-MM-DD');
    }
    if (typeof m.delegationRatio !== 'number' || m.delegationRatio < 0 || m.delegationRatio > 1) {
        errs.push('metrics.delegationRatio must be 0-1');
    }

    if (!Array.isArray(entry.whatsWorking)) errs.push('whatsWorking must be an array');
    if (!Array.isArray(entry.friction))     errs.push('friction must be an array');
    if (!Array.isArray(entry.tips))         errs.push('tips must be an array');

    return errs;
}

// ---- CLI --------------------------------------------------------------------

const args = process.argv.slice(2);

let entry;

if (args.includes('--file')) {
    const fileIdx = args.indexOf('--file');
    const filePath = args[fileIdx + 1];
    if (!filePath) {
        console.error('Error: --file requires a path argument');
        process.exit(1);
    }
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs)) {
        console.error(`Error: file not found: ${abs}`);
        process.exit(1);
    }
    entry = JSON.parse(fs.readFileSync(abs, 'utf8'));
} else {
    // Build from individual flags
    const get = (flag) => {
        const idx = args.indexOf(flag);
        return idx !== -1 ? args[idx + 1] : undefined;
    };
    const getArr = (flag) => {
        const idx = args.indexOf(flag);
        if (idx === -1) return [];
        const vals = [];
        for (let i = idx + 1; i < args.length && !args[i].startsWith('--'); i++) {
            vals.push(args[i]);
        }
        return vals;
    };

    const sessions       = get('--sessions');
    const messages       = get('--messages');
    const tokens         = get('--tokens');
    const busiestHour    = get('--busiestHour');
    const busiestDay     = get('--busiestDay');
    const delegationRatio = get('--delegationRatio');

    entry = {
        weekOf:      get('--weekOf') || '',
        generatedAt: get('--generatedAt') || today(),
        metrics: {
            sessions:        sessions       ? Number(sessions)       : undefined,
            messages:        messages       ? Number(messages)       : undefined,
            tokens:          tokens         ? Number(tokens)         : undefined,
            busiestHour:     busiestHour    ? Number(busiestHour)    : undefined,
            busiestDay:      busiestDay     || undefined,
            delegationRatio: delegationRatio ? Number(delegationRatio) : undefined,
        },
        whatsWorking: getArr('--whatsWorking'),
        friction:     getArr('--friction'),
        tips:         getArr('--tips'),
        notes:        get('--notes') || '',
    };
}

// Default generatedAt to today
if (!entry.generatedAt) entry.generatedAt = today();

// Validate
const errors = validate(entry);
if (errors.length > 0) {
    console.error('Validation errors:');
    errors.forEach(e => console.error(' -', e));
    process.exit(1);
}

// Load log and check for duplicate
const log = readLog();
const duplicate = log.find(e => e.weekOf === entry.weekOf);
if (duplicate) {
    console.error(`Error: an entry for weekOf "${entry.weekOf}" already exists (generatedAt: ${duplicate.generatedAt})`);
    console.error('To update, manually edit insights-log.json.');
    process.exit(1);
}

// Append (newest first — prepend to array)
log.unshift(entry);
writeLog(log);

console.log(`Added insight for week of ${entry.weekOf} (generated ${entry.generatedAt})`);
console.log(`insights-log.json now has ${log.length} entr${log.length === 1 ? 'y' : 'ies'}.`);
