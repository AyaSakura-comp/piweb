// Loopback TCP forwarder for LAN model servers on macOS.
//
// macOS Local Network privacy blocks user processes that are not Apple-signed
// (Homebrew node, python, ...) from opening connections to LAN addresses, and
// a launchd agent or user-level daemon gets no prompt to allow it, only
// EHOSTUNREACH. Root launchd daemons are exempt. So this runs as a root
// LaunchDaemon, listens on loopback only, and pipes bytes to the LAN server;
// pi talks to http://127.0.0.1:<listen port>.
//
//   node lan-proxy.mjs <listenPort> <targetHost> <targetPort>
import net from 'node:net';

const [listenPort, targetHost, targetPort] = process.argv.slice(2);
if (!listenPort || !targetHost || !targetPort) {
  console.error('usage: lan-proxy.mjs <listenPort> <targetHost> <targetPort>');
  process.exit(2);
}

const server = net.createServer((client) => {
  const upstream = net.connect({ host: targetHost, port: Number(targetPort) });
  client.setKeepAlive(true, 30_000);
  upstream.setKeepAlive(true, 30_000);
  client.pipe(upstream);
  upstream.pipe(client);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on('error', close);
  upstream.on('error', (err) => {
    console.error(new Date().toISOString(), 'upstream error:', err.code || err.message);
    close();
  });
  client.on('close', close);
  upstream.on('close', close);
});

server.on('error', (err) => {
  console.error('listen error:', err);
  process.exit(1);
});
server.listen(Number(listenPort), '127.0.0.1', () => {
  console.error(`${new Date().toISOString()} 127.0.0.1:${listenPort} -> ${targetHost}:${targetPort}`);
});
