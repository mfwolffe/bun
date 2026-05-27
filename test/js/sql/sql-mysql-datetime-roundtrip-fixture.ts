// Mock MySQL server that echoes a bound DATETIME parameter back as a
// DATETIME result column, so the test can check that encode→decode is the
// identity regardless of the process timezone.
//
// COM_STMT_EXECUTE parameter bytes are the exact wire format that the
// result-set decoder consumes (length-prefixed year/month/day/h/m/s[/µs]),
// so the server can copy them straight into the binary result row.

import { SQL } from "bun";
import { once } from "events";
import net from "net";

function u16le(n: number): Buffer {
  return Buffer.from([n & 0xff, (n >> 8) & 0xff]);
}
function u24le(n: number): Buffer {
  return Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);
}
function u32le(n: number): Buffer {
  return Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
}
function packet(seq: number, payload: Buffer): Buffer {
  return Buffer.concat([u24le(payload.length), Buffer.from([seq]), payload]);
}
function lenenc(n: number): Buffer {
  if (n < 0xfb) return Buffer.from([n]);
  if (n < 0xffff) return Buffer.concat([Buffer.from([0xfc]), u16le(n)]);
  throw new Error("lenenc: not needed here");
}
function lenencStr(s: string): Buffer {
  const buf = Buffer.from(s, "utf-8");
  return Buffer.concat([lenenc(buf.length), buf]);
}

const CLIENT_PROTOCOL_41 = 1 << 9;
const CLIENT_SECURE_CONNECTION = 1 << 15;
const CLIENT_PLUGIN_AUTH = 1 << 19;
const CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA = 1 << 21;
const CLIENT_DEPRECATE_EOF = 1 << 24;
const SERVER_CAPS =
  CLIENT_PROTOCOL_41 |
  CLIENT_SECURE_CONNECTION |
  CLIENT_PLUGIN_AUTH |
  CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA |
  CLIENT_DEPRECATE_EOF;

const MYSQL_TYPE_DATETIME = 0x0c;

function handshakeV10(): Buffer {
  const authData1 = Buffer.alloc(8, 0x61);
  const authData2 = Buffer.alloc(13, 0x62);
  authData2[12] = 0;
  return packet(
    0,
    Buffer.concat([
      Buffer.from([10]),
      Buffer.from("mock-5.7.0\0"),
      u32le(1),
      authData1,
      Buffer.from([0]),
      u16le(SERVER_CAPS & 0xffff),
      Buffer.from([0x2d]),
      u16le(0x0002),
      u16le((SERVER_CAPS >>> 16) & 0xffff),
      Buffer.from([21]),
      Buffer.alloc(10, 0),
      authData2,
      Buffer.from("mysql_native_password\0"),
    ]),
  );
}

function okPacket(seq: number): Buffer {
  return packet(seq, Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]));
}

function columnDef(name: string, type: number, flags = 0): Buffer {
  return Buffer.concat([
    lenencStr("def"),
    lenencStr(""),
    lenencStr("t"),
    lenencStr("t"),
    lenencStr(name),
    lenencStr(name),
    Buffer.from([0x0c]),
    u16le(33),
    u32le(1024),
    Buffer.from([type]),
    u16le(flags),
    Buffer.from([0]),
    Buffer.from([0, 0]),
  ]);
}

const resultColumn = columnDef("d", MYSQL_TYPE_DATETIME);
const paramColumn = columnDef("?", MYSQL_TYPE_DATETIME);

function stmtPrepareOK(startSeq: number, stmtId: number): Buffer {
  const packets: Buffer[] = [];
  let seq = startSeq;
  packets.push(
    packet(
      seq++,
      Buffer.concat([
        Buffer.from([0x00]),
        u32le(stmtId),
        u16le(1), // num_columns
        u16le(1), // num_params
        Buffer.from([0x00]),
        u16le(0),
      ]),
    ),
  );
  // Under CLIENT_DEPRECATE_EOF: param defs, then column defs, no EOF separators.
  packets.push(packet(seq++, paramColumn));
  packets.push(packet(seq++, resultColumn));
  return Buffer.concat(packets);
}

function binaryResultSet(startSeq: number, datetimeBytes: Buffer): Buffer {
  const packets: Buffer[] = [];
  let seq = startSeq;
  packets.push(packet(seq++, Buffer.from([1]))); // column count
  packets.push(packet(seq++, resultColumn));
  // Binary row: 0x00 header, NULL bitmap ((1+7+2)/8 = 1 byte), then the
  // DATETIME value exactly as the client bound it.
  packets.push(
    packet(
      seq++,
      Buffer.concat([
        Buffer.from([0x00]), // row header
        Buffer.from([0x00]), // null bitmap
        datetimeBytes,
      ]),
    ),
  );
  packets.push(packet(seq++, Buffer.from([0xfe, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00])));
  return Buffer.concat(packets);
}

function extractBoundDatetime(execPayload: Buffer): Buffer {
  // COM_STMT_EXECUTE with 1 param:
  //   [0x17][stmt_id u32][flags u8][iter u32][null_bitmap 1][new_bind 1]
  //   if new_bind: [type u8][unsigned u8]
  //   then value: [len][year u16][month][day][hour][minute][second][µs u32?]
  let off = 1 + 4 + 1 + 4 + 1;
  const newBind = execPayload[off++];
  if (newBind === 1) off += 2;
  const len = execPayload[off];
  return execPayload.subarray(off, off + 1 + len);
}

function startMockServer() {
  const server = net.createServer(socket => {
    let buffered = Buffer.alloc(0);
    let authed = false;
    let stmtId = 0;
    socket.write(handshakeV10());
    socket.on("data", chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const len = buffered[0] | (buffered[1] << 8) | (buffered[2] << 16);
        if (buffered.length < 4 + len) break;
        const seq = buffered[3];
        const payload = buffered.subarray(4, 4 + len);
        buffered = buffered.subarray(4 + len);
        if (!authed) {
          authed = true;
          socket.write(okPacket(seq + 1));
          continue;
        }
        const cmd = payload[0];
        if (cmd === 0x16 /* COM_STMT_PREPARE */) {
          socket.write(stmtPrepareOK(seq + 1, ++stmtId));
        } else if (cmd === 0x17 /* COM_STMT_EXECUTE */) {
          const dt = extractBoundDatetime(payload);
          socket.write(binaryResultSet(seq + 1, dt));
        } else if (cmd === 0x03 /* COM_QUERY */) {
          socket.write(okPacket(seq + 1));
        } else if (cmd === 0x19 /* COM_STMT_CLOSE */) {
          // no response
        } else {
          socket.end();
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  return server;
}

const server = startMockServer();
await once(server, "listening");
const { port } = server.address() as net.AddressInfo;

try {
  await using sql = new SQL({ url: `mysql://root@127.0.0.1:${port}/db`, max: 1 });
  const inputs = [
    new Date("2024-06-15T12:00:00.000Z"),
    new Date("2024-01-15T00:30:00.000Z"),
    new Date("2024-12-31T23:45:00.000Z"),
  ];
  const out: Array<{ in: number; out: number; diffMin: number }> = [];
  for (const input of inputs) {
    const [row] = await sql`SELECT ${input} AS d`;
    const got: Date = row.d;
    out.push({
      in: input.getTime(),
      out: got.getTime(),
      diffMin: (got.getTime() - input.getTime()) / 60000,
    });
  }
  console.log(JSON.stringify({ tz: process.env.TZ ?? "", offsetMin: new Date().getTimezoneOffset(), results: out }));
} finally {
  await new Promise<void>(r => server.close(() => r()));
}
