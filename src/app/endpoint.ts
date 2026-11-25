/** Publishes the bound loopback listener while Runtime owns its state directory. */
import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface RuntimeEndpoint {
  version: 1
  instanceId: string
  pid: number
  host: '127.0.0.1'
  port: number
  startedAt: string
}

const pathOf = (stateDir: string) => join(stateDir, 'runtime-endpoint.json')
export async function publishEndpoint(stateDir: string, endpoint: RuntimeEndpoint): Promise<void> {
  const path = pathOf(stateDir)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(endpoint)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}

export async function removeEndpoint(stateDir: string, instanceId: string): Promise<void> {
  const path = pathOf(stateDir)
  try {
    const endpoint: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (endpoint && typeof endpoint === 'object' && 'instanceId' in endpoint && endpoint.instanceId === instanceId) await rm(path, { force: true })
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
