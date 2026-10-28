import { env } from './env.js';

export function endpoint() {
  return env.API_URL;
}
