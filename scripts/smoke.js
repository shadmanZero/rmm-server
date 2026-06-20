/**
 * End-to-end smoke test for the rackoona control plane.
 *
 * Drives the *entire* pipe the way a browser would, but headless:
 *   GET  /api/devices          → find an online, enrolled agent
 *   POST /sessions             → mint a session + viewer URL (signals the agent)
 *   WS   viewer_ws_url         → speak RFB through the relay to the agent:
 *        ProtocolVersion → Security(None) → ClientInit → ServerInit
 *        → FramebufferUpdateRequest → assert a real FramebufferUpdate comes back
 *
 * Receiving actual pixel bytes proves every hop: control-channel signaling, the
 * agent dialing the relay, relay pairing + buffering, and capture→encode→wire.
 *
 * Prereqs: a running server AND a connected agent, e.g.
 *   (terminal 1) npm start
 *   (terminal 2) cd ../RMM && cargo run -p agent -- connect --mock --server http://127.0.0.1:4000
 *   (terminal 3) node scripts/smoke.js
 *
 * Usage: node scripts/smoke.js [baseUrl]
 */

const WebSocket = require("ws");

const BASE = (process.argv[2] || "http://localhost:4000").replace(/\/$/, "");

function fail(msg) {
  console.error(`\n✘ FAIL: ${msg}`);
  process.exit(1);
}

async function main() {
  // 1. Find an online device.
  const devices = await (await fetch(`${BASE}/api/devices`)).json();
  const device = devices.find((d) => d.online);
  if (!device) {
    fail(
      "no ONLINE device. Start the agent:\n" +
        "    cd ../RMM && cargo run -p agent -- connect --mock --server " +
        BASE,
    );
  }
  console.log(`• device: ${device.device_name} (${device.device_id}) — ${device.os}/${device.arch}`);

  // 2. Start a session.
  const sres = await fetch(`${BASE}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: device.device_id, view_only: false }),
  });
  const sdata = await sres.json();
  if (!sres.ok) fail(`POST /sessions → ${sres.status} ${JSON.stringify(sdata)}`);
  console.log(`• session: ${sdata.session_id} (expires_in=${sdata.expires_in}s)`);
  console.log(`• viewer:  ${sdata.viewer_ws_url}`);

  // 3. Connect as the viewer and run the RFB client handshake.
  const ws = new WebSocket(sdata.viewer_ws_url);
  ws.binaryType = "nodebuffer";

  let buf = Buffer.alloc(0);
  const waiters = [];
  const pump = () => {
    while (waiters.length && buf.length >= waiters[0].n) {
      const w = waiters.shift();
      const out = buf.subarray(0, w.n);
      buf = buf.subarray(w.n);
      w.resolve(out);
    }
  };
  const readBytes = (n) =>
    new Promise((resolve) => {
      waiters.push({ n, resolve });
      pump();
    });
  const send = (b) => ws.send(b, { binary: true });

  ws.on("message", (data) => {
    buf = Buffer.concat([buf, data]);
    pump();
  });
  ws.on("error", (e) => fail(`viewer ws error: ${e.message}`));

  const timeout = setTimeout(() => fail("timed out waiting for RFB bytes through the relay"), 10000);

  await new Promise((resolve) => ws.on("open", resolve));

  // ProtocolVersion
  const version = (await readBytes(12)).toString("ascii");
  if (!version.startsWith("RFB 003.00")) fail(`bad ProtocolVersion: ${JSON.stringify(version)}`);
  console.log(`• handshake: server is ${version.trim()}`);
  send(Buffer.from("RFB 003.008\n", "ascii"));

  // Security: [count, ...types]; expect [1, 1(None)]
  const secList = await readBytes(2);
  if (secList[0] !== 1 || secList[1] !== 1) fail(`unexpected security list: ${[...secList]}`);
  send(Buffer.from([1])); // choose None

  // SecurityResult (u32 BE) == 0
  const secResult = await readBytes(4);
  if (secResult.readUInt32BE(0) !== 0) fail(`security result not OK: ${secResult.readUInt32BE(0)}`);

  // ClientInit (shared=1)
  send(Buffer.from([1]));

  // ServerInit: width(2) height(2) pixelformat(16) name-len(4) name(n)
  const initHead = await readBytes(24);
  const width = initHead.readUInt16BE(0);
  const height = initHead.readUInt16BE(2);
  const bpp = initHead.readUInt8(4);
  const nameLen = initHead.readUInt32BE(20);
  const name = (await readBytes(nameLen)).toString("utf8");
  console.log(`• ServerInit: ${width}x${height} ${bpp}bpp  desktop="${name}"`);
  if (width === 0 || height === 0) fail("ServerInit reported a zero-sized framebuffer");

  // Request a full (non-incremental) framebuffer update.
  const req = Buffer.alloc(10);
  req.writeUInt8(3, 0); // FramebufferUpdateRequest
  req.writeUInt8(0, 1); // non-incremental → forces a full send
  req.writeUInt16BE(0, 2);
  req.writeUInt16BE(0, 4);
  req.writeUInt16BE(width, 6);
  req.writeUInt16BE(height, 8);
  send(req);

  // FramebufferUpdate: type(1)=0, pad(1), num-rects(2)
  const fbHead = await readBytes(4);
  if (fbHead[0] !== 0) fail(`expected FramebufferUpdate (0), got message type ${fbHead[0]}`);
  const numRects = fbHead.readUInt16BE(2);
  if (numRects < 1) fail("FramebufferUpdate carried zero rectangles");

  // First rectangle: x(2) y(2) w(2) h(2) encoding(4 BE). Raw = 0 → w*h*4 bytes.
  const rect = await readBytes(12);
  const rw = rect.readUInt16BE(4);
  const rh = rect.readUInt16BE(6);
  const enc = rect.readInt32BE(8);
  if (enc !== 0) fail(`expected Raw encoding (0), got ${enc}`);
  const pixels = await readBytes(rw * rh * 4);

  clearTimeout(timeout);
  ws.close();

  console.log(
    `• framebuffer: ${numRects} rect(s), first ${rw}x${rh} Raw = ${pixels.length} pixel bytes received`,
  );
  console.log("\n✔ PASS — full RFB stream flowed agent → relay → viewer");
  process.exit(0);
}

main().catch((e) => fail(e.stack || String(e)));
