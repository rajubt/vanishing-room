/**
 * Vanishing Room — ephemeral chat server.
 *
 * Rooms, messages and uploaded files live in memory only. Nothing is
 * written to disk, so a server restart wipes everything.
 *
 * - Messages self-destruct 10 minutes after they are sent.
 * - Messages may carry one attachment (photo or file), kept in memory.
 * - A message can be edited or deleted by the browser that sent it.
 * - Anyone in the room can add/remove emoji reactions to a message.
 * - A room can host an embedded group video call (via Daily.co).
 * - Empty rooms are removed after 15 minutes of inactivity.
 * - Clients poll GET /api/rooms/:id for new messages.
 *
 * Video calls require a Daily.co API key. Set it as an environment
 * variable before starting the server:
 *
 *   Windows (PowerShell):  $env:DAILY_API_KEY="your_key_here"; npm start
 *   Mac/Linux:             DAILY_API_KEY=your_key_here npm start
 *
 * Without the key the chat works fully; only the video button is disabled.
 */

const express = require("express");
const crypto = require("crypto");
const path = require("path");

const app = express();
// Allow large-ish JSON bodies because attachments arrive as base64.
// Body limit is set above MAX_FILE_BYTES (which includes base64 overhead)
// so our own size check returns a clean JSON error, not a raw HTML one.
app.use(express.json({ limit: "9mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── Config ───────────────────────────────────────────────────────
const MESSAGE_TTL = 10 * 60 * 1000; // 10 minutes
const ROOM_IDLE_TTL = 15 * 60 * 1000; // empty-room cleanup window
const MAX_BODY = 500; // chars per message
const MAX_NICK = 24;
const MAX_ROOM_NAME = 40;
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB cap per attachment / voice note
const CALL_TTL_MIN = 15; // video call room auto-expires after 15 minutes

// Daily.co video — the API key comes from the environment, never hardcoded.
const DAILY_API_KEY = process.env.DAILY_API_KEY || "";
const DAILY_ENABLED = Boolean(DAILY_API_KEY);

// ── In-memory store ──────────────────────────────────────────────
// rooms: Map<id, { id, name, isPrivate, code, createdAt, lastActivity, messages: [] }>
const rooms = new Map();

const newId = () => crypto.randomBytes(5).toString("hex");
const clean = (s, max) => String(s ?? "").trim().slice(0, max);

function publicView(room) {
  return {
    id: room.id,
    name: room.name,
    isPrivate: room.isPrivate,
    count: room.messages.filter((m) => m.expiresAt > Date.now()).length,
    createdAt: room.createdAt,
  };
}

// Returns the room's call if one is active and not yet expired, else null.
function activeCall(room) {
  if (room.call && room.call.expiresAt > Date.now()) return room.call;
  room.call = null;
  return null;
}

// Drop expired messages from a room; return the live ones.
function livemessages(room) {
  const now = Date.now();
  room.messages = room.messages.filter((m) => m.expiresAt > now);
  return room.messages;
}

// Validate and normalise an attachment object from the client.
// Expected shape: { name, type, dataUrl }  (dataUrl is a base64 data URI)
// Returns a cleaned attachment, null if absent, or throws a string on error.
function parseAttachment(att) {
  if (!att || typeof att !== "object") return null;
  const name = clean(att.name, 120) || "file";
  const type = clean(att.type, 100) || "application/octet-stream";
  const dataUrl = String(att.dataUrl || "");
  if (!dataUrl.startsWith("data:")) throw "Invalid attachment.";

  const b64 = dataUrl.split(",")[1] || "";
  const bytes = Math.floor((b64.length * 3) / 4);
  if (bytes > MAX_FILE_BYTES) throw "File too large (max 5 MB).";

  return {
    name, type, dataUrl, bytes,
    isImage: type.startsWith("image/"),
    isAudio: type.startsWith("audio/"),
  };
}

// Reactions are stored as { emoji: [senderId, senderId, ...] }.
// The client view turns that into { emoji, count, mine }.
function reactionView(reactions, senderId) {
  const out = [];
  for (const [emoji, ids] of Object.entries(reactions || {})) {
    if (ids.length === 0) continue;
    out.push({ emoji, count: ids.length, mine: ids.includes(senderId) });
  }
  return out;
}

// Build the client-facing view of a message.
function messageView(m, now, viewerId) {
  return {
    id: m.id,
    nick: m.nick,
    body: m.body,
    sentAt: m.sentAt,
    expiresAt: m.expiresAt,
    msLeft: m.expiresAt - now,
    edited: m.edited,
    senderId: m.senderId,
    attachment: m.attachment
      ? {
          name: m.attachment.name,
          type: m.attachment.type,
          dataUrl: m.attachment.dataUrl,
          isImage: m.attachment.isImage,
          isAudio: m.attachment.isAudio,
        }
      : null,
    reactions: reactionView(m.reactions, viewerId),
  };
}

// ── Routes ───────────────────────────────────────────────────────

// List all public rooms.
app.get("/api/rooms", (req, res) => {
  const list = [];
  for (const room of rooms.values()) {
    if (!room.isPrivate) list.push(publicView(room));
  }
  list.sort((a, b) => b.createdAt - a.createdAt);
  res.json({ rooms: list });
});

// Create a room.
app.post("/api/rooms", (req, res) => {
  const name = clean(req.body.name, MAX_ROOM_NAME) || "untitled room";
  const isPrivate = Boolean(req.body.isPrivate);
  const id = newId();
  const room = {
    id,
    name,
    isPrivate,
    code: isPrivate ? newId().slice(0, 6) : null,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    messages: [],
  };
  rooms.set(id, room);
  res.json({
    id: room.id,
    name: room.name,
    isPrivate: room.isPrivate,
    code: room.code, // only returned to the creator
  });
});

// Get a room's live messages. ?viewer= lets the server mark "mine" reactions.
app.get("/api/rooms/:id", (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: "Room not found." });

  if (room.isPrivate && clean(req.query.code, 12) !== room.code) {
    return res.status(403).json({ error: "This room is private." });
  }

  const now = Date.now();
  const viewerId = clean(req.query.viewer, 40);
  const messages = livemessages(room).map((m) => messageView(m, now, viewerId));
  const call = activeCall(room);
  res.json({
    id: room.id,
    name: room.name,
    messages,
    videoEnabled: DAILY_ENABLED,
    call: call ? { url: call.url, expiresAt: call.expiresAt } : null,
  });
});

// Post a message to a room (optionally with an attachment).
app.post("/api/rooms/:id/messages", (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: "Room not found." });

  if (room.isPrivate && clean(req.body.code, 12) !== room.code) {
    return res.status(403).json({ error: "This room is private." });
  }

  const nick = clean(req.body.nick, MAX_NICK);
  const body = clean(req.body.body, MAX_BODY);
  const senderId = clean(req.body.senderId, 40);
  if (!nick) return res.status(400).json({ error: "Nickname required." });
  if (!senderId) return res.status(400).json({ error: "Missing sender id." });

  let attachment = null;
  try {
    attachment = parseAttachment(req.body.attachment);
  } catch (err) {
    return res.status(400).json({ error: String(err) });
  }

  if (!body && !attachment) {
    return res.status(400).json({ error: "Message is empty." });
  }

  const msg = {
    id: newId(),
    nick,
    senderId,
    body,
    attachment,
    sentAt: Date.now(),
    expiresAt: Date.now() + MESSAGE_TTL,
    edited: false,
    reactions: {}, // { emoji: [senderId, ...] }
  };
  room.messages.push(msg);
  room.lastActivity = Date.now();
  res.json({ ok: true, message: messageView(msg, Date.now(), senderId) });
});

// Edit a message — only by the browser that sent it.
app.patch("/api/rooms/:id/messages/:msgId", (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: "Room not found." });

  if (room.isPrivate && clean(req.body.code, 12) !== room.code) {
    return res.status(403).json({ error: "This room is private." });
  }

  const msg = livemessages(room).find((m) => m.id === req.params.msgId);
  if (!msg) return res.status(404).json({ error: "Message not found or expired." });

  const senderId = clean(req.body.senderId, 40);
  if (senderId !== msg.senderId) {
    return res.status(403).json({ error: "You can only edit your own messages." });
  }

  const body = clean(req.body.body, MAX_BODY);
  if (!body && !msg.attachment) {
    return res.status(400).json({ error: "Message cannot be empty." });
  }

  // The 10-minute timer keeps running from the original send time.
  msg.body = body;
  msg.edited = true;
  room.lastActivity = Date.now();
  res.json({ ok: true, message: messageView(msg, Date.now(), senderId) });
});

// Delete a message — only by the browser that sent it.
app.delete("/api/rooms/:id/messages/:msgId", (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: "Room not found." });

  if (room.isPrivate && clean(req.body.code, 12) !== room.code) {
    return res.status(403).json({ error: "This room is private." });
  }

  const idx = room.messages.findIndex((m) => m.id === req.params.msgId);
  if (idx === -1) return res.status(404).json({ error: "Message not found." });

  const senderId = clean(req.body.senderId, 40);
  if (senderId !== room.messages[idx].senderId) {
    return res.status(403).json({ error: "You can only delete your own messages." });
  }

  room.messages.splice(idx, 1);
  room.lastActivity = Date.now();
  res.json({ ok: true });
});

// Toggle an emoji reaction on a message — anyone in the room may react.
// Sending the same emoji again removes that person's reaction.
app.post("/api/rooms/:id/messages/:msgId/react", (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: "Room not found." });

  if (room.isPrivate && clean(req.body.code, 12) !== room.code) {
    return res.status(403).json({ error: "This room is private." });
  }

  const msg = livemessages(room).find((m) => m.id === req.params.msgId);
  if (!msg) return res.status(404).json({ error: "Message not found or expired." });

  const senderId = clean(req.body.senderId, 40);
  const emoji = clean(req.body.emoji, 16);
  if (!senderId) return res.status(400).json({ error: "Missing sender id." });
  if (!emoji) return res.status(400).json({ error: "Missing emoji." });

  if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
  const ids = msg.reactions[emoji];
  const at = ids.indexOf(senderId);
  if (at === -1) ids.push(senderId); // add my reaction
  else ids.splice(at, 1); // toggle it off
  if (ids.length === 0) delete msg.reactions[emoji]; // tidy up empty entries

  room.lastActivity = Date.now();
  res.json({ ok: true, message: messageView(msg, Date.now(), senderId) });
});

// Start (or join) a video call for a room. Creates a Daily.co room the
// first time, then reuses it while it is still active.
app.post("/api/rooms/:id/call", async (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: "Room not found." });

  if (room.isPrivate && clean(req.body.code, 12) !== room.code) {
    return res.status(403).json({ error: "This room is private." });
  }

  if (!DAILY_ENABLED) {
    return res.status(503).json({
      error: "Video calling is not configured. Set DAILY_API_KEY on the server.",
    });
  }

  // If a call is already running, just hand back its URL.
  const existing = activeCall(room);
  if (existing) {
    return res.json({ url: existing.url, expiresAt: existing.expiresAt });
  }

  // Otherwise create a fresh Daily room that auto-expires.
  const expSeconds = Math.floor(Date.now() / 1000) + CALL_TTL_MIN * 60;
  try {
    const resp = await fetch("https://api.daily.co/v1/rooms", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + DAILY_API_KEY,
      },
      body: JSON.stringify({
        privacy: "public",
        properties: {
          exp: expSeconds, // Daily deletes the room at this time
          eject_at_room_exp: true,
          enable_chat: false, // we already have chat
        },
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      console.error("Daily API error:", resp.status, detail);
      return res
        .status(502)
        .json({ error: "Could not start the video call. Check the API key." });
    }

    const data = await resp.json();
    room.call = { url: data.url, expiresAt: expSeconds * 1000 };
    room.lastActivity = Date.now();
    res.json({ url: room.call.url, expiresAt: room.call.expiresAt });
  } catch (err) {
    console.error("Daily request failed:", err);
    res.status(502).json({ error: "Could not reach the video service." });
  }
});

// End the active call for a room (just forgets the URL; Daily expires it).
app.delete("/api/rooms/:id/call", (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: "Room not found." });
  if (room.isPrivate && clean(req.body.code, 12) !== room.code) {
    return res.status(403).json({ error: "This room is private." });
  }
  room.call = null;
  room.lastActivity = Date.now();
  res.json({ ok: true });
});

// SPA fallback — let the client handle /r/:id deep links.
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Janitor: prune expired messages and idle empty rooms ─────────
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    livemessages(room); // drops expired messages (and their attachments)
    const idle = now - room.lastActivity > ROOM_IDLE_TTL;
    if (idle && room.messages.length === 0) rooms.delete(id);
  }
}, 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Vanishing Room running on http://localhost:${PORT}`);
  console.log(
    DAILY_ENABLED
      ? "Video calls: ENABLED (Daily API key found)."
      : "Video calls: disabled — set DAILY_API_KEY to enable them."
  );
});
