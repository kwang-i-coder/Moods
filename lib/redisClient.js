import { createClient } from "redis";

const client = createClient();
client.on('error', (error) => { console.log('Redis error : ', error); });
client.on('connect', () => { console.log("Redis connected") });
client.connect();

export default client;