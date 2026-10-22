import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../alert', () => ({
    alertInput: vi.fn(),
    waitAlert: vi.fn(),
    notifyError: vi.fn(),
}))

vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(),
    encodeRisuSaveLegacy: vi.fn(),
}))

vi.mock('./database.svelte', () => ({
    normalizeChat: (chat: any) => chat,
}))

const { NodeStorage } = await import('./nodeStorage')

const REQUEST_TIMEOUT_MS = 30_000

function setUpStorage(fetchMock: ReturnType<typeof vi.fn>) {
    ;(NodeStorage as any).sessionInitialized = true
    ;(NodeStorage as any).sessionPending = null
    const storage = new NodeStorage(fetchMock as any, { baseDelayMs: 0, delay: vi.fn(async () => {}), random: () => 1 })
    storage.authChecked = true
    vi.spyOn(storage, 'createAuth').mockResolvedValue('token')
    return storage
}

/** A response whose body the test writes. */
function streamResponse() {
    const encoder = new TextEncoder()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
    return {
        response: new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } }),
        push: (line: string) => controller.enqueue(encoder.encode(line + '\n')),
        end: () => controller.close(),
        fail: (error: Error) => controller.error(error),
    }
}

describe('NodeStorage RisuAI account import', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

    test('a refused write tells the app why', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'busy', code: 'ACCOUNT_IMPORT_ACTIVE' }), { status: 423 }))
            .mockResolvedValueOnce(new Response('locked', { status: 423 }))
        const storage = setUpStorage(fetchMock)
        const reasons: unknown[] = []
        const listener = (event: Event) => reasons.push((event as CustomEvent).detail?.code)
        window.addEventListener('risu-session-deactivated', listener)
        try {
            await expect(storage.applyRisuAccountImport()).rejects.toMatchObject({ status: 423, code: 'ACCOUNT_IMPORT_ACTIVE' })
            await expect(storage.applyRisuAccountImport()).rejects.toMatchObject({ status: 423 })
        } finally {
            window.removeEventListener('risu-session-deactivated', listener)
        }
        expect(reasons).toEqual(['ACCOUNT_IMPORT_ACTIVE', null])
    })

    test('a login prompt before the first request does not count against its time limit', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ state: 'idle', blocking: false }), { status: 200 }))
        const storage = setUpStorage(fetchMock)
        storage.authChecked = false
        let login: () => void = () => {}
        const loggedIn = new Promise<void>((resolve) => { login = resolve })
        vi.spyOn(storage as any, 'checkAuth').mockImplementationOnce(async () => {
            await loggedIn
            storage.authChecked = true
        })

        const settled = storage.getRisuAccountImportStatus().then((status) => status, (error) => error)
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 2)
        login()
        expect(await settled).toMatchObject({ state: 'idle', blocking: false })
    })

    test('a session check that hangs after the login counts against the time limit', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
        const storage = setUpStorage(fetchMock)
        vi.spyOn(storage as any, 'checkAuth').mockImplementation(() => new Promise(() => {}))

        const settled = storage.getRisuAccountImportStatus().then(() => 'resolved', (error) => error)
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1)
        expect((await settled as DOMException).name).toBe('AbortError')
    })

    test('a status read with no answer fails instead of hanging', async () => {
        const fetchMock = vi.fn(() => new Promise<Response>(() => {}))
        const storage = setUpStorage(fetchMock)

        const settled = storage.getRisuAccountImportStatus().then(() => 'resolved', (error) => error)
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1)

        expect((await settled as DOMException).name).toBe('AbortError')
        expect((fetchMock.mock.calls[0] as any[])[1].signal.aborted).toBe(true)
    })

    test('a status read whose body is cut off fails instead of reading as an empty status', async () => {
        const truncated = streamResponse()
        const broken = streamResponse()
        const fetchMock = vi.fn().mockResolvedValueOnce(truncated.response).mockResolvedValueOnce(broken.response)
        const storage = setUpStorage(fetchMock)

        truncated.push('{"state":')
        truncated.end()
        await expect(storage.getRisuAccountImportStatus()).rejects.toBeInstanceOf(SyntaxError)

        const pending = storage.getRisuAccountImportStatus()
        broken.push('{"state":')
        broken.fail(new TypeError('network error'))
        await expect(pending).rejects.toThrow()
    })

    test('a status read whose body stops after the headers fails instead of hanging', async () => {
        const stream = streamResponse()
        const fetchMock = vi.fn().mockResolvedValue(stream.response)
        const storage = setUpStorage(fetchMock)

        const settled = storage.getRisuAccountImportStatus().then(() => 'resolved', (error) => error)
        stream.push('{"state":')
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1)

        expect((await settled as DOMException).name).toBe('AbortError')
    })
})
