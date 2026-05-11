import path from "path";
import express from "express";
import {
  defineServer,
  defineRoom,
  monitor,
  playground,
  createRouter,
  createEndpoint,
  matchMaker,
} from "colyseus";
import { AccessToken } from "livekit-server-sdk";

import { TableRoom } from "./rooms/MyRoom.js";

type LiveKitRole = "host" | "guest" | "viewer";

function getLiveKitGrant(role: LiveKitRole, roomName: string) {
  const canPublish = role === "host" || role === "guest";

  return {
    room: roomName,
    roomJoin: true,
    canSubscribe: true,
    canPublish,
    canPublishData: true,
  };
}

const server = defineServer({
  rooms: {
    table: defineRoom(TableRoom),
  },

  routes: createRouter({
    api_hello: createEndpoint("/api/hello", { method: "GET" }, async () => {
      return { message: "Hello World" };
    }),
  }),

  express: (app) => {
    app.use(express.json());
    app.use(express.static(path.join(process.cwd(), "public")));

    app.get("/", (_req: express.Request, res: express.Response) => {
      res.sendFile(path.join(process.cwd(), "public", "lobby.html"));
    });

    app.get("/hi", (_req: express.Request, res: express.Response) => {
      res.send("8th District Domino server is running.");
    });

    app.get("/api/rooms", async (_req: express.Request, res: express.Response) => {
      try {
        const rooms = await matchMaker.query({ name: "table" });
        res.json(rooms);
      } catch (err) {
        console.error("Failed to fetch rooms:", err);
        res.status(500).json({ error: "Failed to fetch rooms" });
      }
    });

    app.post("/api/livekit-token", async (req: express.Request, res: express.Response) => {
      try {
        const livekitUrl = process.env.LIVEKIT_URL;
        const apiKey = process.env.LIVEKIT_API_KEY;
        const apiSecret = process.env.LIVEKIT_API_SECRET;

        if (!livekitUrl || !apiKey || !apiSecret) {
          return res.status(500).json({
            error: "LiveKit environment variables are missing on the server.",
          });
        }

        const {
          roomName,
          userId,
          username,
          role = "viewer",
        } = req.body || {};

        if (!roomName || !userId || !username) {
          return res.status(400).json({
            error: "Missing required fields: roomName, userId, username.",
          });
        }

        const safeRole: LiveKitRole =
          role === "host" || role === "guest" || role === "viewer"
            ? role
            : "viewer";

        const token = new AccessToken(apiKey, apiSecret, {
          identity: String(userId),
          name: String(username),
          ttl: "2h",
        });

        token.addGrant(getLiveKitGrant(safeRole, String(roomName)));

        const jwt = await token.toJwt();

        return res.json({
          token: jwt,
          url: livekitUrl,
          roomName,
          role: safeRole,
        });
      } catch (err) {
        console.error("Failed to create LiveKit token:", err);
        return res.status(500).json({
          error: "Failed to create LiveKit token.",
        });
      }
    });

    app.use("/monitor", monitor());

    if (process.env.NODE_ENV !== "production") {
      app.use("/playground", playground());
    }
  },
});

export default server;