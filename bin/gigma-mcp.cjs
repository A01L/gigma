#!/usr/bin/env node
// stdio <-> Gigma bridge for MCP clients that only speak stdio (e.g. Claude Desktop).
// Zero dependencies: reads newline-delimited JSON-RPC from stdin, forwards each message
// to the running Gigma app at http://127.0.0.1:<port>/mcp and writes replies to stdout.
// Runs with plain Node, or with the Gigma executable itself via ELECTRON_RUN_AS_NODE=1.
'use strict'
const http = require('node:http')
const readline = require('node:readline')

const PORT = Number(process.env.GIGMA_MCP_PORT || 7331)

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

// the client names itself once in "initialize"; pass the name with every call so Gigma can sign its cursor
let client = ''

function post(message) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(message))
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/mcp',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': data.length,
          ...(client && { 'x-gigma-client': client })
        }
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, type: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks).toString('utf8') }))
      }
    )
    req.on('error', reject)
    req.end(data)
  })
}

function parseReplies(r) {
  if (!r.body) return []
  if (r.type.includes('text/event-stream')) {
    return r.body
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => JSON.parse(l.slice(5)))
  }
  const parsed = JSON.parse(r.body)
  return Array.isArray(parsed) ? parsed : [parsed]
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg && msg.method === 'initialize' && msg.params && msg.params.clientInfo) client = String(msg.params.clientInfo.name || '').replace(/[^ -~]/g, '').slice(0, 64)
  try {
    const r = await post(msg)
    for (const reply of parseReplies(r)) write(reply)
  } catch (e) {
    if (msg && msg.id !== undefined) {
      write({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32000, message: 'Gigma is not running. Open the Gigma app and try again. (' + e.message + ')' }
      })
    }
  }
})
rl.on('close', () => process.exit(0))
