import { connect, createServer, type Socket } from 'node:net'

export type TcpProxy = {
  port: number
  origin: string
  cut(): void
  close(): Promise<void>
}

export const startTcpProxy = async (
  targetPort: number,
  targetHost = '127.0.0.1'
): Promise<TcpProxy> => {
  const sockets = new Set<Socket>()
  const server = createServer((client) => {
    const upstream = connect({ port: targetPort, host: targetHost })
    sockets.add(client)
    sockets.add(upstream)
    const drop = (socket: Socket) => {
      sockets.delete(socket)
      socket.destroy()
    }
    client.on('error', () => undefined)
    upstream.on('error', () => undefined)
    client.on('close', () => drop(upstream))
    upstream.on('close', () => drop(client))
    client.pipe(upstream)
    upstream.pipe(client)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    cut: () => {
      for (const socket of [...sockets]) {
        socket.destroy()
      }
      sockets.clear()
    },
    close: async () => {
      for (const socket of [...sockets]) {
        socket.destroy()
      }
      sockets.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
