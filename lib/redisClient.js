import { createClient } from "redis";

const client = process.env.REDIS_HOST === 'localhost' ? createClient() : createClient({url:`redis://:${process.env.REDIS_PASSWORD}@${process.env.REDIS_HOST}:6379`});
client.on('error', (error) => { console.log('Redis error : ', error); });
client.on('connect', () => { console.log("Redis connected") });
client.connect();

export default client;