import crypto from 'node:crypto';
import CONFIG from '../../config.js';
import { verifySessionToken } from './deviceSessionService.js';

export function encodeWsFrame(payloadString) {
  const data = Buffer.from(payloadString, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text frame
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

export class RealtimeHub {
  constructor() {
    this.sseClientsBySession = new Map(); // sessionId -> Set<res>
    this.sseClientsByStudent = new Map(); // studentId -> Set<{ sessionId, deviceType, res }>
    this.wsClientsBySession = new Map();  // sessionId -> Set<socket>
    this.wsClientsByStudent = new Map();  // studentId -> Set<{ sessionId, deviceType, socket }>
    this.intervals = new Set();
  }

  handleSseConnect(req, res, authContext) {
    const { student, session, slot } = authContext;
    const sessionId = session.session_id;
    const studentId = student.id;
    const deviceType = session.device_type;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*'
    });

    const connectedPayload = {
      type: 'CONNECTED',
      sessionId,
      studentId,
      deviceType,
      slotVersion: slot?.slot_version || 1,
      timestamp: new Date().toISOString()
    };
    res.write(`event: connected\ndata: ${JSON.stringify(connectedPayload)}\n\n`);

    if (!this.sseClientsBySession.has(sessionId)) {
      this.sseClientsBySession.set(sessionId, new Set());
    }
    this.sseClientsBySession.get(sessionId).add(res);

    const studentEntry = { sessionId, deviceType, res };
    if (!this.sseClientsByStudent.has(studentId)) {
      this.sseClientsByStudent.set(studentId, new Set());
    }
    this.sseClientsByStudent.get(studentId).add(studentEntry);

    const heartbeatTimer = setInterval(() => {
      if (!res.writableEnded) {
        try {
          res.write(`: heartbeat ${Date.now()}\n\n`);
        } catch {
          // Ignore write errors on closed stream
        }
      }
    }, 15000);
    heartbeatTimer.unref?.();
    this.intervals.add(heartbeatTimer);

    const cleanup = () => {
      clearInterval(heartbeatTimer);
      this.intervals.delete(heartbeatTimer);
      const sessSet = this.sseClientsBySession.get(sessionId);
      if (sessSet) {
        sessSet.delete(res);
        if (sessSet.size === 0) this.sseClientsBySession.delete(sessionId);
      }
      const stuSet = this.sseClientsByStudent.get(studentId);
      if (stuSet) {
        stuSet.delete(studentEntry);
        if (stuSet.size === 0) this.sseClientsByStudent.delete(studentId);
      }
    };

    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
  }

  attachWebSocketServer(server, db) {
    server.on('upgrade', (req, socket) => {
      try {
        const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
        if (parsedUrl.pathname !== '/ws' && parsedUrl.pathname !== '/api/auth/sessions/ws') {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
          socket.destroy();
          return;
        }

        const authHeader = req.headers.authorization || '';
        const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
        const token = parsedUrl.searchParams.get('token') || bearerToken;
        const payload = token ? verifySessionToken(token, CONFIG.jwtSecret) : null;

        if (!payload || !payload.sid || !payload.sub) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        const session = db.prepare('SELECT * FROM user_sessions WHERE session_id = ?').get(payload.sid);
        if (!session || session.status !== 'active') {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        const wsKey = req.headers['sec-websocket-key'];
        if (!wsKey) {
          socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
          socket.destroy();
          return;
        }

        const acceptKey = crypto
          .createHash('sha1')
          .update(wsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
          .digest('base64');

        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
        );

        const sessionId = session.session_id;
        const studentId = session.student_id;
        const deviceType = session.device_type;

        if (!this.wsClientsBySession.has(sessionId)) {
          this.wsClientsBySession.set(sessionId, new Set());
        }
        this.wsClientsBySession.get(sessionId).add(socket);

        const studentEntry = { sessionId, deviceType, socket };
        if (!this.wsClientsByStudent.has(studentId)) {
          this.wsClientsByStudent.set(studentId, new Set());
        }
        this.wsClientsByStudent.get(studentId).add(studentEntry);

        this.sendWsJson(socket, {
          type: 'CONNECTED',
          sessionId,
          studentId,
          deviceType,
          timestamp: new Date().toISOString()
        });

        socket.on('data', (buffer) => {
          try {
            if (buffer.length < 2) return;
            const opcode = buffer[0] & 0x0f;
            if (opcode === 0x08) {
              // Close frame
              socket.end();
            } else if (opcode === 0x09) {
              // Ping -> Pong
              const pong = Buffer.from([0x8a, 0x00]);
              socket.write(pong);
            } else if (opcode === 0x01) {
              // Text frame - respond to ping json
              this.sendWsJson(socket, { type: 'PONG', timestamp: new Date().toISOString() });
            }
          } catch {
            // Ignore malformed client frames
          }
        });

        const cleanup = () => {
          const sessSet = this.wsClientsBySession.get(sessionId);
          if (sessSet) {
            sessSet.delete(socket);
            if (sessSet.size === 0) this.wsClientsBySession.delete(sessionId);
          }
          const stuSet = this.wsClientsByStudent.get(studentId);
          if (stuSet) {
            stuSet.delete(studentEntry);
            if (stuSet.size === 0) this.wsClientsByStudent.delete(studentId);
          }
        };

        socket.on('close', cleanup);
        socket.on('error', cleanup);
        socket.on('end', cleanup);
      } catch {
        try {
          socket.destroy();
        } catch {
          // Ignore
        }
      }
    });
  }

  sendWsJson(socket, obj) {
    if (!socket || socket.destroyed || !socket.writable) return;
    try {
      const frame = encodeWsFrame(JSON.stringify(obj));
      socket.write(frame);
    } catch {
      // Ignore write errors
    }
  }

  notifySession(sessionId, eventName, payload) {
    if (!sessionId) return;
    const jsonStr = JSON.stringify(payload);
    const sseSet = this.sseClientsBySession.get(sessionId);
    if (sseSet) {
      for (const res of sseSet) {
        if (!res.writableEnded) {
          try {
            res.write(`event: ${eventName}\ndata: ${jsonStr}\n\n`);
            res.write(`event: message\ndata: ${jsonStr}\n\n`);
          } catch {
            // Ignore
          }
        }
      }
    }
    const wsSet = this.wsClientsBySession.get(sessionId);
    if (wsSet) {
      for (const socket of wsSet) {
        this.sendWsJson(socket, { event: eventName, ...payload });
      }
    }
  }

  notifyPreempted({
    studentId,
    revokedSessionId,
    slotType,
    newDeviceLabel = 'Verified Device',
    reason = 'FACIAL_AUTH_SLOT_TAKEOVER'
  }) {
    const payload = {
      type: 'SESSION_PREEMPTED',
      code: 'SESSION_PREEMPTED',
      slotType,
      revokedSessionId,
      newDeviceLabel,
      reason,
      timestamp: new Date().toISOString()
    };

    if (revokedSessionId) {
      this.notifySession(revokedSessionId, 'session_preempted', payload);
    }

    // Also notify other active sessions of this student that the slot map changed
    if (studentId) {
      const stuSse = this.sseClientsByStudent.get(studentId);
      if (stuSse) {
        for (const entry of stuSse) {
          if (entry.sessionId !== revokedSessionId && !entry.res.writableEnded) {
            try {
              const updateStr = JSON.stringify({
                type: 'SLOT_UPDATED',
                slotType,
                newDeviceLabel,
                timestamp: payload.timestamp
              });
              entry.res.write(`event: slot_updated\ndata: ${updateStr}\n\n`);
            } catch {
              // Ignore
            }
          }
        }
      }
    }
  }

  notifyAnomalyLocked({
    studentId,
    sessionId,
    slotType,
    challengeId,
    nonce,
    reason = 'SESSION_ANOMALY_REVERIFY'
  }) {
    const payload = {
      type: 'ANOMALY_LOCKED',
      code: 'BIOMETRIC_REAUTH_REQUIRED',
      requiresFacialAuth: true,
      studentId,
      sessionId,
      slotType,
      challengeId,
      nonce,
      reason,
      timestamp: new Date().toISOString()
    };
    this.notifySession(sessionId, 'anomaly_locked', payload);
  }

  closeAll() {
    for (const timer of this.intervals) {
      clearInterval(timer);
    }
    this.intervals.clear();

    for (const [, set] of this.sseClientsBySession) {
      for (const res of set) {
        try {
          res.end();
        } catch {
          // Ignore
        }
      }
    }
    this.sseClientsBySession.clear();
    this.sseClientsByStudent.clear();

    for (const [, set] of this.wsClientsBySession) {
      for (const socket of set) {
        try {
          socket.destroy();
        } catch {
          // Ignore
        }
      }
    }
    this.wsClientsBySession.clear();
    this.wsClientsByStudent.clear();
  }
}

export function createRealtimeHub() {
  return new RealtimeHub();
}

export default RealtimeHub;
