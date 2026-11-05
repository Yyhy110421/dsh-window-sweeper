import { apply } from '../lib/index.js'
import { spawn } from 'node:child_process'
const regs = []
const ctx = { tools: { register: (d) => regs.push(d) }, systemPrompt: { section: () => {} }, effect: () => {}, on: () => () => {}, inject: () => {}, get: () => undefined }
apply(ctx, {})
const tool = regs[0]
const exec = { agent: { session: { id: 'manual-2' } } }
console.log('mark:', (await tool.execute({ action: 'mark' }, exec)).marked)
const child = spawn('C:/Windows/System32/charmap.exe', [], { detached: true, stdio: 'ignore' })
child.on('error', (e) => console.log('spawn error', e.message))
child.unref()
await new Promise(r => setTimeout(r, 3000))
const listed = await tool.execute({ action: 'list' }, exec)
console.log('cands:', listed.candidates.map(c => c.exe + '|' + c.title).join(' ; '))
const mini = await tool.execute({ action: 'minimize' }, exec)
console.log('minimized:', mini.applied.map(c => c.ok + '|' + c.title).join(' ; '))
const closed = await tool.execute({ action: 'close' }, exec)
console.log('closed:', closed.applied.map(c => c.ok + '|' + c.title).join(' ; '), 'remaining', closed.remaining.length)