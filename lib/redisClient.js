import { createClient } from "redis";

const client = createClient({url:`redis://:${process.env.REDIS_PASSWORD}@redis:6379`});
client.on('error', (error) => { console.log('Redis error : ', error); });
client.on('connect', () => { console.log("Redis connected") });
client.connect();

export default client;