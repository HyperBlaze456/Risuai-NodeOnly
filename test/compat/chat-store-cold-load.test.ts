/**
 * A chat body saved while the database cache is cold (right after a server
 * restart or a backup import) must survive the first request that loads the
 * cache. The body sits only in fullChatStore until the debounced persist, and
 * the cold load used to rebuild that store from disk — so the first
 * /api/patch after a restart dropped the chat the client had just saved.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { Packr } from 'msgpackr'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { normalizeBackup } from './helpers/normalize.js'

const utils = require('../../server/node/utils.cjs') as typeof import('../../server/node/utils.cjs')

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })
const encode = (data: unknown) => new Uint8Array(Buffer.concat([MAGIC_RAW, packr.encode(data)]))

const DB_KEY_HEX = Buffer.from('database/database.bin').toString('hex')
const CHA = 'test-char-0'
const CHAT = 'chat-0-0'
const URL_ = `/api/chat-content/${CHA}/0`

let srv: ServerHandle
let client: RisuClient

beforeAll(async () => {
  const preload = fileURLToPath(new URL('./helpers/slow-decode-preload.cjs', import.meta.url))
  srv = await spawnServer({ env: { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` } })
  client = await createClient(srv.port, srv.password)
})
afterAll(async () => { await srv?.cleanup() })

// An import leaves the server as a restart does: no database cache, chat
// store built from disk.
async function coldStart() {
  const result = await client.importBackup(createSeedBackup({ characterCount: 1 }))
  expect(result.ok).toBe(true)
}

async function getChat() {
  const res = await client.fetch(URL_, { headers: { 'x-chat-id': CHAT } })
  expect(res.status).toBe(200)
  return await utils.decodeRisuSave(Buffer.from(await res.arrayBuffer())) as any
}

async function saveChatWith(text: string) {
  const chat = await getChat()
  const res = await client.fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-chat-id': CHAT },
    body: encode({ ...chat, message: [...chat.message, { role: 'user', data: text }] }),
  })
  expect(res.status).toBe(200)
}

async function stalePatch() {
  return client.fetch('/api/patch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'file-path': DB_KEY_HEX },
    body: JSON.stringify({ patch: [], expectedHash: 'stale' }),
  })
}

async function lastMessageOnDisk() {
  // Export flushes the pending persist and reads database.bin from disk.
  const { raw } = normalizeBackup(await client.exportBackup()) as any
  const chat = raw.characters.find((c: any) => c.chaId === CHA).chats.find((c: any) => c.id === CHAT)
  return chat.message.at(-1).data
}

describe('chat body saved while the database cache is cold', () => {
  test('survives the cold load of the first /api/patch', async () => {
    await coldStart()
    await saveChatWith('saved before the first patch')

    // The client's patch after a restart carries its old hash: 409, but the
    // server cold-loads the cache first.
    const patch = await client.fetch('/api/patch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'file-path': DB_KEY_HEX },
      body: JSON.stringify({ patch: [{ op: 'replace', path: '/username', value: 'x' }], expectedHash: 'stale' }),
    })
    expect(patch.status).toBe(409)

    expect((await getChat()).message.at(-1).data).toBe('saved before the first patch')
    expect(await lastMessageOnDisk()).toBe('saved before the first patch')
  })

  test('survives any other request that cold-loads the cache', async () => {
    await coldStart()
    await saveChatWith('saved before a manifest update')

    // Loads the cache before it finds the owner missing.
    const update = await client.fetch('/api/asset-manifests/owner/character/missing-owner', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(update.ok).toBe(false)

    expect((await getChat()).message.at(-1).data).toBe('saved before a manifest update')
    expect(await lastMessageOnDisk()).toBe('saved before a manifest update')
  })

  test('a new chat saved before the first patch keeps its body once the client adds it to the database', async () => {
    await coldStart()
    // A chat created after the restart: the body goes up first, its entry in
    // the database only with the client's patch.
    const NEW = 'chat-new'
    const newUrl = `/api/chat-content/${CHA}/1`
    const saved = await client.fetch(newUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-chat-id': NEW },
      body: encode({ id: NEW, name: 'New', message: [{ role: 'user', data: 'first message of a new chat' }], note: '', localLore: [] }),
    })
    expect(saved.status).toBe(200)

    const stale = await client.fetch('/api/patch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'file-path': DB_KEY_HEX },
      body: JSON.stringify({ patch: [{ op: 'add', path: `/characters/0/chats/1`, value: { id: NEW, name: 'New', _stub: true } }], expectedHash: 'stale' }),
    })
    expect(stale.status).toBe(409)

    // The client re-reads and patches again with the current hash.
    const read = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
    const db = utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await read.arrayBuffer()))) as any
    const patched = await client.fetch('/api/patch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'file-path': DB_KEY_HEX },
      body: JSON.stringify({ patch: [{ op: 'add', path: `/characters/0/chats/1`, value: { id: NEW, name: 'New', _stub: true } }], expectedHash: utils.calculateHash(db).toString(16) }),
    })
    expect(patched.status).toBe(200)

    const res = await client.fetch(newUrl, { headers: { 'x-chat-id': NEW } })
    expect(res.status).toBe(200)
    const chat = await utils.decodeRisuSave(Buffer.from(await res.arrayBuffer())) as any
    expect(chat.message.at(-1).data).toBe('first message of a new chat')
    const { raw } = normalizeBackup(await client.exportBackup()) as any
    const onDisk = raw.characters.find((c: any) => c.chaId === CHA).chats.find((c: any) => c.id === NEW)
    expect(onDisk.message.at(-1).data).toBe('first message of a new chat')
  })

  test('a chat the disk lists comes from disk, not from an older copy in memory', async () => {
    await coldStart()
    // database.bin replaced without going through the chat store (bulk-write
    // stands in for any such write): the cold load must take disk's body.
    const { raw: seeded } = normalizeBackup(createSeedBackup({ characterCount: 1 })) as any
    const chat = seeded.characters[0].chats[0]
    chat.message = [...chat.message, { role: 'user', data: 'written outside the chat store' }]
    const written = await client.fetch('/api/assets/bulk-write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ key: 'database/database.bin', value: Buffer.from(utils.encodeRisuSaveLegacy(seeded)).toString('base64') }]),
    })
    expect(written.status).toBe(200)

    const patch = await client.fetch('/api/patch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'file-path': DB_KEY_HEX },
      body: JSON.stringify({ patch: [], expectedHash: 'stale' }),
    })
    expect(patch.status).toBe(409)

    expect((await getChat()).message.at(-1).data).toBe('written outside the chat store')
  })

  test('survives a cold load that starts while another request is still flushing', async () => {
    await coldStart()
    await saveChatWith('saved while a read flushes')

    // /api/read flushes outside the storage queue; with decoding slowed, the
    // patch's cold load starts while that flush has not written yet.
    const flag = path.join(srv.cwd, 'slow-decode')
    await writeFile(flag, '')
    try {
      const read = client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
      await new Promise((resolve) => setTimeout(resolve, 50))
      const [readRes, patchRes] = await Promise.all([read, stalePatch()])
      expect(readRes.status).toBe(200)
      expect(patchRes.status).toBe(409)
    } finally {
      await rm(flag, { force: true })
    }

    expect((await getChat()).message.at(-1).data).toBe('saved while a read flushes')
    expect(await lastMessageOnDisk()).toBe('saved while a read flushes')
  })
})
