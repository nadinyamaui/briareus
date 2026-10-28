#!/usr/bin/env node
// @ts-check
import { createApiClient, serveStdio } from './mcp-stdio.js';

const call = createApiClient('/api/agent/print', 'Print tools are not configured for this session');
const tools = [
  {
    name: 'print_printers',
    description:
      'List the printers on the Briareus server, each with its state (idle, holding: accepts jobs but holds them until released, printing, disabled) and which one is the default.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'print_file',
    description:
      'Print a file on a physical printer. Only print what the user explicitly asked to print, and ask which printer when more than one could be meant. The file must be a non-hidden regular file in this session workspace or an attachment delivered to this session, at most 25 MiB; PDF, plain text and common images print directly, so convert other formats (HTML, Office documents, Markdown) to PDF first. Never resubmit after an uncertain result: check print_jobs first, since a second call prints a second copy.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file to print' },
        printer: {
          type: 'string',
          description: 'Printer name from print_printers; default printer when omitted',
        },
        copies: { type: 'integer', minimum: 1, maximum: 20, default: 1 },
        pages: { type: 'string', description: 'Pages to print, such as 1-3,5; all when omitted' },
        sides: { type: 'string', enum: ['one-sided', 'two-sided-long-edge', 'two-sided-short-edge'] },
        color: { type: 'string', enum: ['color', 'monochrome'] },
        media: { type: 'string', description: 'Paper size, such as A4 or Letter' },
        landscape: {
          type: 'boolean',
          description: "Rotate to landscape; the printer's default when omitted",
        },
        fitToPage: {
          type: 'boolean',
          description: "Scale the content to fit the page; the printer's default when omitted",
        },
        title: { type: 'string', description: 'Job name shown in the queue; the file name when omitted' },
      },
      required: ['path'],
    },
  },
  {
    name: 'print_jobs',
    description:
      'List the print jobs this session sent and their state: pending (queued or printing), completed, canceled, aborted, ended (finished, but how could not be read; see stateError), or unknown once CUPS has forgotten it.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'print_cancel',
    description: 'Cancel a pending print job this session sent, when the user asks.',
    inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
  },
];

async function runTool(name, args = {}) {
  if (name === 'print_printers') return JSON.stringify(await call('GET', '/printers'));
  if (name === 'print_file') return JSON.stringify(await call('POST', '/jobs', args));
  if (name === 'print_jobs') return JSON.stringify(await call('GET', '/jobs'));
  if (name === 'print_cancel')
    return JSON.stringify(await call('DELETE', `/jobs/${encodeURIComponent(args.jobId || '')}`));
  throw new Error(`Unknown tool ${name}`);
}
serveStdio({ name: 'reviewer-print', tools, runTool });
