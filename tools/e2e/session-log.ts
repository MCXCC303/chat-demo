import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionLogStore } from '../../server/src/session-log.ts'
import type { SessionEvent } from '../../src/services/session/types.ts'

const SESSION = 'session-log-check'

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

const check = async (): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), 'chat-demo-session-log-'))
  try {
    const store = new SessionLogStore({ home })

    const meta = await store.append(SESSION, 'session/meta', {
      sessionId: SESSION,
      title: '第一轮对话',
      pinned: true,
      createdAt: 1000,
      updatedAt: 2000,
    })
    assert.equal(meta, 1, '首个事件的 seq 必须是 1')

    const upsert = await store.append(SESSION, 'message/upsert', {
      message: { id: 'm1', role: 'user', content: '你好' },
    })
    assert.equal(upsert, 2, 'seq 必须单调递增')

    const delta = await store.append(SESSION, 'message/delta', {
      messageId: 'm1',
      index: 0,
      delta: { type: 'text_delta', text: '在' },
    })
    assert.equal(delta, 3, 'seq 必须单调递增')

    const all = await store.read(SESSION)
    assert.equal(all.length, 3, 'read 必须返回全部事件')
    assert.deepEqual(
      all.map((event) => event.seq),
      [1, 2, 3],
      'read 必须按 seq 升序'
    )
    assert.equal(all[0].type, 'session/meta', 'read 必须带回 type')
    assert.deepEqual(
      all[0].payload,
      { sessionId: SESSION, title: '第一轮对话', pinned: true, createdAt: 1000, updatedAt: 2000 },
      'read 必须原样带回 payload'
    )
    assert.deepEqual(
      all[2].payload,
      { messageId: 'm1', index: 0, delta: { type: 'text_delta', text: '在' } },
      'read 不得改写 payload'
    )

    const after = await store.readFrom(SESSION, 1)
    assert.deepEqual(
      after.map((event) => event.seq),
      [2, 3],
      'readFrom 只返回 seq 大于 after 的事件'
    )
    assert.deepEqual(await store.readFrom(SESSION, 3), [], 'readFrom 之后没有事件时应返回空数组')

    const seen: SessionEvent[] = []
    const seenSecond: SessionEvent[] = []
    const unsubscribe = store.subscribe(SESSION, (event) => {
      seen.push(event)
      const text = readFileSync(store.logPath(SESSION), 'utf8')
      assert.ok(text.includes('"seq":4'), '订阅者只能看到已落盘的事件')
    })
    const unsubscribeSecond = store.subscribe(SESSION, (event) => {
      seenSecond.push(event)
    })

    const live = await store.append(SESSION, 'turn/state', {
      turnId: 't1',
      status: 'running',
    })
    assert.equal(live, 4, '订阅之后的 append 继续沿用 seq')
    await settle()
    assert.deepEqual(
      seen.map((event) => event.seq),
      [4],
      '订阅者必须收到新事件'
    )
    assert.deepEqual(
      seenSecond.map((event) => event.seq),
      [4],
      '同一会话的多个订阅者都要收到事件'
    )

    unsubscribe()
    await store.append(SESSION, 'turn/state', { turnId: 't1', status: 'done' })
    await settle()
    assert.deepEqual(
      seen.map((event) => event.seq),
      [4],
      '取消订阅后不再收到事件'
    )
    assert.equal(seenSecond.length, 2, '其他订阅者不受影响')
    unsubscribeSecond()

    const parallel = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        store.append(SESSION, 'message/block', { messageId: 'm1', index })
      )
    )
    assert.equal(new Set(parallel).size, 50, '并发 append 的 seq 不得重复')
    assert.deepEqual(
      [...parallel].sort((left, right) => left - right),
      Array.from({ length: 50 }, (_, index) => index + 6),
      '并发 append 的 seq 必须连续且不重复'
    )
    const raw = await readFile(store.logPath(SESSION), 'utf8')
    const lines = raw
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as SessionEvent)
    assert.deepEqual(
      lines.map((event) => event.seq),
      Array.from({ length: 55 }, (_, index) => index + 1),
      '落盘顺序必须与 seq 顺序一致'
    )

    const listed = await store.listSessions()
    assert.equal(listed.length, 1, '索引必须列出会话')
    assert.equal(listed[0].id, SESSION, '索引项的 id 必须正确')
    assert.equal(listed[0].title, '第一轮对话', '索引项的 title 必须来自 session/meta')
    assert.equal(listed[0].pinned, true, '索引项的 pinned 必须来自 session/meta')
    assert.equal(listed[0].createdAt, 1000, '索引项的 createdAt 必须来自 session/meta')
    assert.equal(listed[0].updatedAt, 2000, '索引项的 updatedAt 必须来自 session/meta')

    await unlink(join(store.root, 'index.json'))
    const restarted = new SessionLogStore({ home })
    const reread = await restarted.read(SESSION)
    assert.deepEqual(
      reread.map((event) => event.seq),
      lines.map((event) => event.seq),
      '重启后必须能读回全部事件'
    )
    const relisted = await restarted.listSessions()
    assert.equal(relisted.length, 1, '重启后索引必须仍能列出')
    assert.equal(relisted[0].title, '第一轮对话', '重启后索引必须能从磁盘重建')
    const continued = await restarted.append(SESSION, 'branch/selected', {
      parentId: null,
      selectedChildId: 'm1',
    })
    assert.equal(continued, 56, '重启后 seq 必须继续且不得重复')

    const entries = await readdir(store.root, { withFileTypes: true })
    assert.ok(
      entries.some((entry) => entry.isDirectory() && entry.name === SESSION),
      '会话目录必须存在'
    )
    assert.ok(
      entries.some((entry) => entry.isFile() && entry.name === 'index.json'),
      '索引文件必须存在'
    )

    await restarted.deleteSession(SESSION)
    assert.deepEqual(await restarted.read(SESSION), [], '删除后不得读到事件')
    assert.deepEqual(await restarted.listSessions(), [], '删除后索引里不得残留条目')
    const afterDelete = await readdir(store.root, { withFileTypes: true })
    assert.ok(
      !afterDelete.some((entry) => entry.isDirectory() && entry.name === SESSION),
      '删除后日志目录必须被清掉'
    )

    process.stdout.write('session-log: 全部断言通过\n')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

check().catch((error: unknown) => {
  process.stderr.write(
    `session-log: 断言失败 ${error instanceof Error ? error.stack : String(error)}\n`
  )
  process.exitCode = 1
})
