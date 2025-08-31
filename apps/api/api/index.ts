import { Hono } from "hono";

const route = new Hono()

route.get('/', async (c) => {
    return c.json({ hello: 'world' })
});