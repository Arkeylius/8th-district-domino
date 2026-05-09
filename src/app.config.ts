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

import { TableRoom } from "./rooms/MyRoom.js";

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

    app.use("/monitor", monitor());

    if (process.env.NODE_ENV !== "production") {
      app.use("/playground", playground());
    }
  },
});

export default server;
