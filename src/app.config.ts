import path from "path";
import express from "express";
import {
    defineServer,
    defineRoom,
    monitor,
    playground,
    createRouter,
    createEndpoint,
    matchMaker // <-- Added matchMaker here
} from "colyseus";

/**
 * Import your Room files
 */
import { TableRoom } from "./rooms/MyRoom.js";

const server = defineServer({
    /**
     * Define your room handlers:
     */
    rooms: {
        table: defineRoom(TableRoom)
    },

    /**
     * Experimental: Define API routes. Built-in integration with the "playground" and SDK.
     * * Usage from SDK: 
     * client.http.get("/api/hello").then((response) => {})
     * */
    routes: createRouter({
        api_hello: createEndpoint("/api/hello", { method: "GET", }, async (ctx) => {
            return { message: "Hello World" }
        })
    }),

    /**
     * Bind your custom express routes here:
     * Read more: https://expressjs.com/en/starter/basic-routing.html
     */
    express: (app) => {
        app.use(express.static(path.join(process.cwd(), "public")));
        app.get("/hi", (req, res) => {
            res.send("It's time to kick ass and chew bubblegum!");
        });

        // --- THE FIX: Added express.Request and express.Response for strict TypeScript ---
        app.get("/api/rooms", async (req: express.Request, res: express.Response) => {
            try {
                const rooms = await matchMaker.query({ name: "table" });
                res.json(rooms);
            } catch (err) {
                res.status(500).json({ error: "Failed to fetch rooms" });
            }
        });

        /**
         * Use @colyseus/monitor
         */
        app.use("/monitor", monitor());

        /**
         * Use @colyseus/playground
         */
        if (process.env.NODE_ENV !== "production") {
            app.use("/", playground());
        }
    }

});

export default server;