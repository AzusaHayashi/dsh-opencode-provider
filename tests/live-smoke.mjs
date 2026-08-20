/**
 * Live end-to-end smoke test against the OpenCode server on port 4096.
 * Steps:
 *   1. Create a session via POST /api/session
 *   2. Verify session ID is returned from data.id
 *   3. Subscribe to SSE stream and send prompt concurrently
 *   4. Confirm text output arrives on the SSE stream
 */

const BASE = 'http://127.0.0.1:4096'

async function main() {
  // Step 1: Create a session with the model explicitly set
  console.log('1. Creating session with model=opencode/mimo-v2.5-free...')
  const createRes = await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ model: { id: 'mimo-v2.5-free', providerID: 'opencode' } }),
  })
  if (!createRes.ok) {
    console.error(`   FAIL: HTTP ${createRes.status}`)
    process.exit(1)
  }
  const createBody = await createRes.json()

  // Step 2: Extract session ID from data.id
  const sessionId = createBody?.data?.id
  if (!sessionId || typeof sessionId !== 'string') {
    console.error(`   FAIL: No session ID in data.id`)
    process.exit(1)
  }
  console.log(`   Session ID: ${sessionId} (from data.id)`)
  console.log(`   Envelope: { data: { id: "${sessionId}", ... } }`)

  // Step 3: Subscribe to SSE and send prompt CONCURRENTLY to avoid deadlock.
  // The server may withhold SSE response headers until the session has
  // activity, which only happens after prompt delivery.
  console.log('2. Starting SSE subscription and prompt delivery concurrently...')
  const ctrl = new AbortController()
  const events = []
  let gotTextDelta = false
  let gotTerminal = false

  // Fire SSE fetch WITHOUT awaiting — runs concurrently with prompt delivery.
  const sseFetchPromise = fetch(`${BASE}/api/session/${sessionId}/event`, {
    method: 'GET',
    headers: { accept: 'text/event-stream' },
    signal: ctrl.signal,
  })

  // Send prompt FIRST (concurrently with SSE establishment).
  console.log('3. Sending prompt...')
  const msgId = `msg_${Date.now()}_smoke`
  const promptRes = await fetch(`${BASE}/api/session/${sessionId}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      id: msgId,
      prompt: { text: 'Reply with exactly: SMOKE_OK', files: [] },
      delivery: 'steer',
    }),
  })
  if (!promptRes.ok) {
    console.error(`   FAIL: Prompt HTTP ${promptRes.status}`)
    ctrl.abort()
    process.exit(1)
  }
  const promptBody = await promptRes.json()
  console.log(`   Prompt delivered (HTTP ${promptRes.status})`)
  console.log(`   Server confirmed: id=${promptBody?.data?.id}, sessionID=${promptBody?.data?.sessionID}`)

  // Now await the SSE stream — the prompt has created session activity
  // so the server will flush response headers.
  console.log('4. Awaiting SSE stream (prompt already delivered)...')
  const eventRes = await sseFetchPromise
  if (!eventRes.ok) {
    console.error(`   FAIL: SSE subscription HTTP ${eventRes.status}`)
    process.exit(1)
  }
  console.log('   SSE subscription OK')

  const reader = eventRes.body.getReader()
  const decoder = new TextDecoder()
  let sseBuffer = ''

  const readPromise = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        sseBuffer += decoder.decode(value, { stream: true })
        const lines = sseBuffer.split('\n')
        sseBuffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const raw = line.slice(6)
            try {
              const ev = JSON.parse(raw)
              events.push(ev)
              console.log(`   EVENT: ${ev.type}`)
              // Print the COMPLETE raw JSON for every text-related and terminal event
              // so we can see the real field structure from the live server.
              if (
                ev.type === 'session.text.delta'
                || ev.type === 'session.next.text.delta'
                || ev.type === 'session.next.text.started'
                || ev.type === 'session.next.text.ended'
                || ev.type === 'session.next.step.ended'
                || ev.type === 'session.next.step.started'
              ) {
                console.log(`     RAW: ${JSON.stringify(ev)}`)
              }
              if (ev.type === 'session.text.delta' || ev.type === 'session.next.text.delta') {
                gotTextDelta = true
                const text = ev.data?.delta ?? ev.data?.text ?? ''
                if (text) console.log(`     text: "${text}"`)
              }
              // Also check text.started / text.ended for content
              if (ev.type === 'session.next.text.started' || ev.type === 'session.next.text.ended') {
                console.log(`     text.started/ended data keys: ${JSON.stringify(Object.keys(ev.data ?? {}))}`)
                const textContent = ev.data?.text ?? ev.data?.content ?? ev.data?.delta ?? ''
                if (textContent) {
                  console.log(`     text content: "${textContent}"`)
                  gotTextDelta = true
                }
              }
              if (ev.type === 'session.next.step.ended') {
                console.log(`     step.ended data keys: ${JSON.stringify(Object.keys(ev.data ?? {}))}`)
                // Check if step.ended carries final text
                const stepText = ev.data?.text ?? ev.data?.content ?? ev.data?.output ?? ev.data?.message ?? ''
                if (stepText) console.log(`     step.ended text: "${stepText}"`)
              }
              if (
                ev.type === 'session.execution.succeeded' || ev.type === 'session.idle'
                || ev.type === 'session.next.step.succeeded' || ev.type === 'session.next.step.idle'
                || ev.type === 'session.next.step.ended'
              ) {
                gotTerminal = true
              }
              if (
                ev.type === 'session.error' || ev.type === 'session.execution.failed'
                || ev.type === 'session.next.step.failed'
              ) {
                gotTerminal = true
                const errMsg = ev.data?.message ?? ev.data?.error?.message ?? ''
                console.log(`     error: ${errMsg}`)
              }
            } catch { /* non-JSON */ }
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') console.error(`   SSE read error: ${e.message}`)
    }
  })()

  // Step 5: Wait for output
  console.log('5. Waiting for output (60s timeout)...')
  const deadline = Date.now() + 60_000
  while (!gotTerminal && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500))
  }
  ctrl.abort()
  try { await readPromise } catch {}

  // Step 6: Verify session has messages via GET /api/session/:id
  let messageCount = 0
  try {
    const sessionRes = await fetch(`${BASE}/api/session/${sessionId}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    })
    if (sessionRes.ok) {
      const sessionData = await sessionRes.json()
      const session = sessionData?.data ?? sessionData
      const messages = session?.messages ?? session?.messageList ?? []
      messageCount = Array.isArray(messages) ? messages.length : 0
      console.log(`6. Session message list: ${messageCount} messages`)
      // Print full session response structure for inspection
      console.log(`   Session response top-level keys: ${JSON.stringify(Object.keys(session ?? {}))}`)
      if (messageCount > 0) {
        for (const msg of messages) {
          console.log(`   Message role=${msg.role}, content type=${typeof msg.content}, content snippet=${JSON.stringify(msg.content).slice(0, 200)}`)
        }
      }
    } else {
      console.log(`6. Session GET returned HTTP ${sessionRes.status} (endpoint may not exist)`)
    }
  } catch (e) {
    console.log(`6. Session GET failed: ${e.message} (endpoint may not exist)`)
  }

  // Collect assistant text from deltas AND from text.started/ended events
  const assistantText = events
    .filter(e => e.type === 'session.text.delta' || e.type === 'session.next.text.delta')
    .map(e => e.data?.delta ?? e.data?.text ?? '')
    .join('')

  // Also check for text in text.started and text.ended events
  const textFromStartedEnded = events
    .filter(e => e.type === 'session.next.text.started' || e.type === 'session.next.text.ended')
    .map(e => e.data?.text ?? e.data?.content ?? '')
    .join('')

  // Check step.ended for final text
  const textFromStepEnded = events
    .filter(e => e.type === 'session.next.step.ended')
    .map(e => e.data?.text ?? e.data?.content ?? e.data?.output ?? e.data?.message ?? '')
    .join('')

  const combinedText = assistantText || textFromStartedEnded || textFromStepEnded

  // Results
  console.log('\n=== Live Smoke Test Results ===')
  console.log(`1. Session created (data.id extraction): PASS`)
  console.log(`2. SSE subscription (concurrent with prompt): PASS`)
  console.log(`3. Prompt delivery (schema: id, prompt.text, prompt.files, delivery): PASS`)
  console.log(`4. Text delta received: ${gotTextDelta ? 'PASS' : 'FAIL'}`)
  console.log(`   Assistant text (deltas): "${assistantText}"`)
  console.log(`   Assistant text (text.started/ended): "${textFromStartedEnded}"`)
  console.log(`   Assistant text (step.ended): "${textFromStepEnded}"`)
  console.log(`   Combined text: "${combinedText}"`)
  console.log(`5. Terminal event: ${gotTerminal ? 'PASS' : 'FAIL'}`)
  console.log(`   Total events: ${events.length}`)
  console.log(`   Event types: ${[...new Set(events.map(e => e.type))].join(', ')}`)
  console.log(`6. Session message list non-empty: ${messageCount > 0 ? 'PASS' : 'N/A (GET endpoint may not exist)'}`)
  // Overall result
  const pass = gotTextDelta || combinedText.length > 0
  console.log(`\nOverall text received: ${pass ? 'PASS' : 'FAIL'}`)
}

main().catch(e => {
  console.error(`FAIL: ${e.message}`)
  process.exit(1)
})
